// Admin page entry point (design 2.3-2.5, Req 13). Vanilla ES module.
// Rendering safety: all DOM writes go through h() (createElement, textContent via text
// nodes, `value`/`checked` properties, setAttribute on a fixed allow-list).
// Until a token is unlocked nothing but the unlock/setup form exists and no
// authenticated request is made.

import { createVault, MIN_PASSWORD } from "./crypto.js";
import { createGitHubClient, resolveApiBase, DEFAULT_API_BASE, GitHubError, MSG as GH_MSG } from "./github.js";
import {
  applyEdits, updateMediaItem, editNote, editCaption, setDefinitive, isDefinitive,
  defaultOrder, orderBefore, setCover, removeMediaItem, coverProblem, newFolderName,
} from "./model.js";
import { planUploads, readVideoDuration, classify, LIMITS, MSG as UP_MSG } from "./uploads.js";
import { prepareImage, jpegName } from "./image-prep.js";
import { slugify, slugifyFileName } from "./slug.js";
import { validateAll, TOP_LEVEL_KEYS } from "./validate-core.mjs";

// ---------- constants and environment ----------

const PENDING_KEY = "album-admin-pending";
const TIMEOUT_MS = 12 * 60 * 1000;
const FAILURE_MSG = "No se pudo construir. Revisa el video o la foto que subiste.";
const TIMEOUT_MSG = "Sigue construyéndose; revisa en unos minutos.";
const KIND_LABELS = { prologue: "Prólogo", chapter: "Capítulo", teaser: "Continuará" };
const ITEM_LABELS = { photo: "Foto", video: "Video", pdf: "PDF", quote: "Cita" };

const params = new URLSearchParams(location.search);
const isLocal = location.hostname === "localhost" || location.hostname === "127.0.0.1";
const apiBase = resolveApiBase(params.get("api"), location.hostname); // override only on localhost
const apiOverridden = apiBase !== DEFAULT_API_BASE;
const pollOverride = isLocal ? Number(params.get("poll")) : 0;
const BUILD_POLL_MS = pollOverride > 0 ? pollOverride : 10000;
const RUNS_POLL_MS = pollOverride > 0 ? pollOverride : 15000;

// ---------- DOM helpers (no markup strings anywhere) ----------

const ATTRS = new Set([
  "id", "class", "type", "for", "name", "href", "target", "rel", "rows", "maxlength", "autocomplete",
  "autocapitalize", "accept", "placeholder", "role", "aria-label", "aria-live", "aria-describedby",
  "aria-invalid", "aria-current", "inputmode", "tabindex", "spellcheck", "title", "lang",
]);
const PROPS = new Set(["value", "checked", "disabled", "hidden", "multiple", "required"]);

function safeUrl(u) {
  try {
    const url = new URL(String(u));
    if (url.protocol === "https:") return url.href;
    if (url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1")) return url.href;
  } catch { /* not a URL */ }
  return null;
}

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "href") {
      const u = safeUrl(v);
      if (u) el.setAttribute("href", u);
    } else if (PROPS.has(k)) {
      el[k] = v;
    } else if (ATTRS.has(k)) {
      el.setAttribute(k, String(v));
    } else {
      throw new Error(`Atributo no permitido: ${k}`);
    }
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid);
  return el;
}

const on = (el, evt, fn) => el.addEventListener(evt, fn);
const clear = (el) => { el.replaceChildren(); return el; };
const setText = (el, text) => { el.textContent = text; };
let uid = 0;
const nextId = (p) => `${p}-${++uid}`;

function field(labelText, makeControl, hint) {
  const id = nextId("f");
  const control = makeControl(id);
  return h("div", { class: "field" }, h("label", { for: id }, labelText), control, hint ? h("p", { class: "hint" }, hint) : null);
}

function textInput(id, value, maxlength, onInput) {
  const el = h("input", { id, type: "text", value: value ?? "", maxlength });
  on(el, "input", () => onInput(el.value, el));
  return el;
}

function textArea(id, value, maxlength, onInput, rows = 3) {
  const el = h("textarea", { id, rows, value: value ?? "", maxlength });
  on(el, "input", () => onInput(el.value, el));
  return el;
}

function select(id, options, current, onChange) {
  const el = h("select", { id }, options.map(([v, label]) => h("option", { value: v }, label)));
  el.value = current;
  on(el, "change", () => onChange(el.value));
  return el;
}

function checkbox(text, checked, onChange) {
  const input = h("input", { type: "checkbox", checked: !!checked });
  on(input, "change", () => onChange(input.checked));
  return { input, label: h("label", { class: "check" }, input, h("span", {}, text)) };
}

function button(text, onClick, cls = "btn", extra = {}) {
  const el = h("button", { type: "button", class: cls, ...extra }, text);
  on(el, "click", onClick);
  return el;
}

// ---------- encoding helpers ----------

function bytesToBase64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const textToBase64 = (text) => bytesToBase64(new TextEncoder().encode(text));

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).slice(String(reader.result).indexOf(",") + 1));
    reader.onerror = () => reject(new Error("No se pudo leer el archivo."));
    reader.readAsDataURL(blob);
  });
}

const serialize = (obj) => JSON.stringify(obj, null, 2) + "\n";
const sortByOrder = (a, b) => a.order - b.order || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0);

// Parses "1, 2, 5-7" into [1,2,5,6,7].
function parsePages(text) {
  const out = [];
  for (const tok of text.split(/[\s,]+/).filter(Boolean)) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(tok);
    if (!m) return { ok: false, message: `"${tok}" no es una página válida. Usa números como 1, 2, 5-7.` };
    const a = Number(m[1]);
    const b = m[2] === undefined ? a : Number(m[2]);
    if (a < 1 || b < a) return { ok: false, message: `"${tok}" no es un rango válido.` };
    for (let n = a; n <= b; n++) out.push(n);
    if (out.length > 30) return { ok: false, message: "Máximo 30 páginas." };
  }
  return { ok: true, pages: out };
}

function orderKeys(obj) {
  const out = {};
  for (const k of TOP_LEVEL_KEYS) if (k in obj) out[k] = obj[k];
  for (const k of Object.keys(obj)) if (!(k in out)) out[k] = obj[k];
  return out;
}

const FIELD_NAMES = {
  title: "Título", dateText: "Fecha", place: "Lugar", note: "Nota", cover: "Portada",
  media: "Elementos", kind: "Tipo", order: "Orden",
};
function friendly(msg, slug) {
  return msg
    .replace(`[capítulo:${slug}] `, "")
    .replace(/^media\[(\d+)\]/, (_, n) => `Elemento ${Number(n) + 1}`)
    .replace(/^(title|dateText|place|note|cover|media|kind|order)\b/, (k) => FIELD_NAMES[k]);
}

// ---------- state ----------

const els = {};
const state = {
  cfg: null,
  cfgError: null,
  vault: null,
  client: null,
  mode: "setup", // "setup" | "unlock"
  chapters: [], // { folder, json | null, files: Set }
  ed: null, // editor session
  busy: false,
  track: null,
};

// ---------- config and auth ----------

async function loadConfig() {
  let res;
  try {
    res = await fetch("/admin/config.json", { cache: "no-store" });
  } catch {
    return { error: "No se pudo leer la configuración del álbum (/admin/config.json). Revisa tu conexión." };
  }
  if (res.status === 404) {
    return { error: "Falta la configuración del álbum (/admin/config.json). Avisa a quien publicó el álbum." };
  }
  if (!res.ok) return { error: "No se pudo leer la configuración del álbum." };
  let raw;
  try {
    raw = await res.json();
  } catch {
    return { error: "La configuración del álbum (/admin/config.json) no es válida." };
  }
  const r = raw && typeof raw.repo === "object" && raw.repo ? raw.repo : raw || {};
  const cfg = { owner: r.owner, repo: r.repo ?? r.name, branch: r.branch || "main" };
  if (JSON.stringify(cfg).includes("REPLACE_")) {
    return { error: "Configura el repositorio: falta el usuario y el nombre del repositorio de GitHub en la configuración del álbum." };
  }
  if (typeof cfg.owner !== "string" || typeof cfg.repo !== "string" || !cfg.owner || !cfg.repo) {
    return { error: "Configura el repositorio: falta el usuario y el nombre del repositorio de GitHub." };
  }
  return { cfg };
}

function makeClient(token) {
  return createGitHubClient({
    token, owner: state.cfg.owner, repo: state.cfg.repo, branch: state.cfg.branch,
    apiBase, hostname: location.hostname,
  });
}

function setAuthMode(mode) {
  state.mode = mode;
  const setup = mode === "setup";
  els.tokenField.hidden = setup ? false : true;
  els.passwordHint.hidden = !setup;
  els.password.setAttribute("autocomplete", setup ? "new-password" : "current-password");
  setText(els.passwordLabel, setup ? "Crea una contraseña" : "Contraseña");
  setText(els.submit, setup ? "Guardar y entrar" : "Entrar");
  setText(els.intro, setup
    ? "Primera vez en este dispositivo. Pega tu token de GitHub y elige una contraseña."
    : "Escribe tu contraseña para abrir el administrador.");
  els.forget.hidden = setup;
}

function showAuthError(message) { setText(els.authError, message); }

let lockTimer = null;
function startLockCountdown() {
  clearInterval(lockTimer);
  const tick = () => {
    const ms = state.vault.lockRemainingMs();
    if (ms <= 0) {
      clearInterval(lockTimer);
      els.submit.disabled = !!state.cfgError;
      showAuthError("");
      return;
    }
    els.submit.disabled = true;
    showAuthError(`Demasiados intentos. Espera ${Math.ceil(ms / 1000)} s.`);
  };
  tick();
  lockTimer = setInterval(tick, 1000);
}

async function onAuthSubmit(event) {
  event.preventDefault();
  if (state.cfgError || state.busy) return;
  showAuthError("");
  const password = els.password.value;
  state.busy = true;
  els.submit.disabled = true;
  try {
    if (state.mode === "setup") {
      const token = els.token.value.trim();
      if (!token) throw new Error("Pega el token de GitHub.");
      if (password.length < MIN_PASSWORD) throw new Error("La contraseña debe tener al menos 8 caracteres.");
      showAuthError("Comprobando el token…");
      const client = makeClient(token);
      await client.checkRepo();
      await state.vault.setup(token, password);
      state.client = client;
    } else {
      await state.vault.unlock(password);
      state.client = makeClient(state.vault.getToken());
    }
    els.token.value = "";
    els.password.value = "";
    showAuthError("Abriendo el álbum…");
    await enterApp();
    showAuthError("");
  } catch (err) {
    state.vault.lock();
    state.client = null;
    showAuthError(err instanceof Error ? err.message : GH_MSG.unexpected);
    if (err && err.code === "locked") startLockCountdown();
  } finally {
    state.busy = false;
    if (!state.vault.isLocked()) els.submit.disabled = !!state.cfgError;
  }
}

function onForget() {
  if (!confirm("¿Olvidar este dispositivo? Tendrás que pegar el token de GitHub otra vez.")) return;
  state.vault.forget();
  setAuthMode("setup");
  showAuthError("");
}

function lockApp() {
  stopTracking();
  state.vault.lock();
  state.client = null;
  state.chapters = [];
  state.ed = null;
  clear(els.app);
  els.app.hidden = true;
  els.auth.hidden = false;
  setAuthMode(state.vault.hasStoredToken() ? "unlock" : "setup");
  els.password.focus();
}

// ---------- reading the repository ----------

const CHAPTER_RE = /^content\/chapters\/([^/]+)\/chapter\.json$/;
const MEDIA_RE = /^content\/chapters\/([^/]+)\/media\/([^/]+)$/;

async function loadChapters() {
  const stateInfo = await state.client.readState();
  const byFolder = new Map();
  const get = (f) => {
    if (!byFolder.has(f)) byFolder.set(f, { folder: f, json: null, sha: null, files: new Set() });
    return byFolder.get(f);
  };
  for (const e of stateInfo.entries) {
    if (e.type !== "blob") continue;
    let m = CHAPTER_RE.exec(e.path);
    if (m) { get(m[1]).sha = e.sha; continue; }
    m = MEDIA_RE.exec(e.path);
    if (m) get(m[1]).files.add(m[2]);
  }
  const list = [...byFolder.values()].filter((c) => c.sha);
  await Promise.all(list.map(async (c) => {
    try {
      c.json = JSON.parse(await state.client.readBlobText(c.sha));
    } catch (err) {
      if (err instanceof GitHubError && (err.code === "token" || err.code === "forbidden")) throw err;
      c.json = null;
    }
  }));
  list.sort((a, b) => sortByOrder(
    { order: a.json?.order ?? Infinity, slug: a.folder },
    { order: b.json?.order ?? Infinity, slug: b.folder },
  ));
  state.chapters = list;
}

const chapterMeta = (excludeFolder) => state.chapters
  .filter((c) => c.json && c.folder !== excludeFolder && typeof c.json.order === "number")
  .map((c) => ({ slug: c.folder, order: c.json.order, kind: c.json.kind }));

// ---------- app shell ----------

async function enterApp() {
  await loadChapters(); // first authenticated chapter read happens only after unlock
  els.auth.hidden = true;
  els.app.hidden = false;
  buildShell();
  renderList();
  resumePending();
}

function buildShell() {
  clear(els.app);
  els.live = h("section", { class: "card live", role: "status", "aria-live": "polite", hidden: true });
  els.view = h("main", { id: "view" });
  els.app.append(
    h("div", { class: "topbar" },
      h("h1", {}, "Nuestra historia"),
      button("Bloquear", lockApp, "btn", { "aria-label": "Bloquear el administrador" })),
    els.live,
    els.view,
  );
}

function focusHeading() {
  const head = els.view.querySelector("h2");
  if (head) { head.setAttribute("tabindex", "-1"); head.focus(); }
}

// ---------- chapter list ----------

function renderList() {
  state.ed = null;
  const view = clear(els.view);
  const items = state.chapters.map((c) => {
    const title = c.json ? c.json.title || c.folder : c.folder;
    const tags = c.json
      ? [KIND_LABELS[c.json.kind] || "", c.json.draft === true ? "borrador" : ""].filter(Boolean).join(" · ")
      : "no se pudo leer";
    const btn = h("button", { type: "button", class: "chapter-btn", disabled: !c.json },
      h("span", {}, title), h("span", { class: "tag" }, tags));
    on(btn, "click", () => openEditor(c.folder));
    return h("li", {}, btn);
  });
  view.append(
    h("h2", {}, "Capítulos"),
    state.chapters.length ? h("ul", { class: "chapters" }, items) : h("p", {}, "Todavía no hay capítulos."),
    button("Nuevo capítulo", newChapter, "btn primary"),
  );
  focusHeading();
}

// ---------- editor session ----------

function newChapter() {
  const meta = chapterMeta(null);
  const { order, renumbered } = defaultOrder(meta);
  startEditor({
    isNew: true,
    folder: null,
    original: null,
    work: { schema: 1, order, kind: "chapter", title: "", draft: true, media: [] },
    files: new Set(),
    renumbered,
    placement: "",
  });
}

function openEditor(folder) {
  const c = state.chapters.find((x) => x.folder === folder);
  if (!c || !c.json) return;
  startEditor({
    isNew: false,
    folder,
    original: c.json,
    work: JSON.parse(JSON.stringify(c.json)),
    files: new Set(c.files),
    renumbered: {},
    placement: "",
  });
}

function startEditor(base) {
  state.ed = {
    ...base,
    added: new Map(), // name -> { blob, kind }
    removed: new Set(), // names of repo files to delete
    fieldErrors: new Map(),
    uploadErrors: [],
    uploadWarnings: [],
    dom: {},
  };
  renderEditor();
}

function dirty(ed) {
  if (ed.isNew) return true;
  return serialize(ed.work) !== serialize(ed.original) || ed.added.size > 0 || ed.removed.size > 0 ||
    Object.keys(ed.renumbered).length > 0;
}

function editorErrors(ed) {
  const slug = ed.folder || "nuevo";
  const files = new Set([...ed.files].filter((f) => !ed.removed.has(f)));
  for (const name of ed.added.keys()) files.add(name);
  const others = state.chapters
    .filter((c) => c.json && c.folder !== ed.folder)
    .map((c) => ({ slug: c.folder, json: c.json, files: [...c.files] }));
  const all = validateAll([...others, { slug, json: ed.work, files: [...files] }]);
  let mine = all.filter((e) => e.startsWith(`[capítulo:${slug}] `)).map((e) => friendly(e, slug));
  const cp = coverProblem(ed.work);
  if (cp) mine = [cp, ...mine.filter((e) => !e.startsWith("Portada"))];
  return [...mine, ...ed.fieldErrors.values(), ...ed.uploadErrors];
}

function refresh() {
  const ed = state.ed;
  if (!ed || !ed.dom.errors) return;
  const errors = editorErrors(ed);
  const changed = dirty(ed);
  const list = clear(ed.dom.errors);
  for (const e of errors) list.append(h("li", {}, e));
  ed.dom.errors.hidden = errors.length === 0;
  ed.dom.publish.disabled = state.busy || errors.length > 0 || !changed;
  if (ed.dom.remove) ed.dom.remove.disabled = state.busy;
  if (!state.busy && ed.dom.status && !ed.dom.status.dataset.keep) {
    setText(ed.dom.status, errors.length ? "Corrige los avisos para poder publicar." : changed ? "" : "Sin cambios por publicar.");
  }
}

function setStatus(text, keep = false) {
  const el = state.ed?.dom.status;
  if (!el) return;
  setText(el, text);
  if (keep) el.dataset.keep = "1";
  else delete el.dataset.keep;
}

function setWork(next) {
  state.ed.work = next;
  refresh();
}

function syncDefinitive() {
  const box = state.ed.dom.definitive;
  if (box) box.checked = isDefinitive(state.ed.work);
}

function renderEditor() {
  const ed = state.ed;
  const view = clear(els.view);
  ed.dom = {};

  // Order / placement ("Insertar antes de…")
  const others = state.chapters.filter((c) => c.json && c.folder !== ed.folder).sort((a, b) => sortByOrder(
    { order: a.json.order, slug: a.folder }, { order: b.json.order, slug: b.folder }));
  const placementOptions = [["", ed.isNew ? "Al final, antes de «Continuará»" : "Dejar donde está"]]
    .concat(others.map((c) => [c.folder, `Antes de «${c.json.title || c.folder}»`]));
  const placementSel = (id) => select(id, placementOptions, ed.placement, (value) => {
    ed.placement = value;
    let res;
    if (value) res = orderBefore(chapterMeta(ed.folder), value);
    else if (ed.isNew) res = defaultOrder(chapterMeta(null));
    else res = { order: ed.original.order, renumbered: {} };
    ed.renumbered = res.renumbered;
    setWork(applyEdits(ed.work, { order: res.order }));
  });

  const work = ed.work;
  const note = textArea;

  const definitive = checkbox("Texto definitivo", isDefinitive(work), (v) => setWork(setDefinitive(ed.work, v)));
  ed.dom.definitive = definitive.input;

  ed.dom.mediaList = h("ol", { class: "media" });
  ed.dom.errors = h("ul", { class: "error-list", role: "alert" });
  ed.dom.status = h("p", { class: "status", role: "status", "aria-live": "polite" });
  ed.dom.publish = button("Publicar", publishChapter, "btn primary");
  ed.dom.addMsg = h("div", { "aria-live": "polite" });

  const fileInput = h("input", {
    id: "add-files", type: "file", multiple: true,
    accept: ".jpg,.jpeg,.png,.webp,.mp4,.mov,.m4v,.pdf,image/*,video/*,application/pdf",
  });
  on(fileInput, "change", async () => {
    const files = [...fileInput.files];
    fileInput.value = "";
    await addFiles(files);
  });

  view.append(
    button("← Capítulos", () => {
      if (dirty(ed) && !ed.isNew ? !confirm("Hay cambios sin publicar. ¿Salir sin guardarlos?") : false) return;
      renderList();
    }, "btn link"),
    h("h2", {}, ed.isNew ? "Nuevo capítulo" : "Editar capítulo"),
    h("div", { class: "card" },
      field("Título", (id) => textInput(id, work.title, 120, (v) => setWork(applyEdits(ed.work, { title: v })))),
      h("div", { class: "grid" },
        field("Fecha (texto)", (id) => textInput(id, work.dateText, 60, (v) => setWork(applyEdits(ed.work, { dateText: v === "" ? undefined : v })))),
        field("Lugar", (id) => textInput(id, work.place, 80, (v) => setWork(applyEdits(ed.work, { place: v === "" ? undefined : v }))))),
      field("Tipo", (id) => select(id, Object.entries(KIND_LABELS), work.kind, (v) => {
        setWork(applyEdits(ed.work, { kind: v }));
        renderMedia();
      })),
      field("Insertar antes de…", placementSel),
      field("Nota", (id) => note(id, work.note, 600, (v) => {
        if (v === "" && !("note" in ed.work)) return;
        setWork(editNote(ed.work, v));
        syncDefinitive();
      }, 5), "Máximo 600 caracteres."),
      definitive.label),
    h("div", { class: "card" },
      h("h3", {}, "Fotos, videos y PDF"),
      ed.dom.mediaList,
      field("Agregar fotos, videos o PDF", (id) => { fileInput.setAttribute("id", id); return fileInput; },
        "Fotos JPG, PNG o WebP; videos MP4 o MOV de hasta 25 MB; PDF de hasta 25 MB. También sirven los archivos exportados de Canva."),
      ed.dom.addMsg,
      button("Agregar cita", addQuote)),
    h("div", { class: "publishbar" },
      ed.dom.errors,
      h("div", { class: "row" },
        ed.dom.publish,
        ed.isNew ? null : (ed.dom.remove = button("Eliminar capítulo", deleteChapter, "btn danger"))),
      ed.dom.status),
  );
  renderMedia();
  renderAddMsg();
  refresh();
  focusHeading();
}

// ---------- media list ----------

function moveItem(i, delta) {
  const ed = state.ed;
  const media = [...ed.work.media];
  const j = i + delta;
  if (j < 0 || j >= media.length) return;
  [media[i], media[j]] = [media[j], media[i]];
  setWork(applyEdits(ed.work, { media }));
  renderMedia();
}

function removeItem(i) {
  const ed = state.ed;
  const item = ed.work.media[i];
  const { chapter } = removeMediaItem(ed.work, i);
  if (item.file) {
    if (ed.added.has(item.file)) ed.added.delete(item.file);
    else if (ed.files.has(item.file)) ed.removed.add(item.file);
  }
  ed.fieldErrors.clear();
  setWork(chapter);
  syncDefinitive();
  renderMedia();
}

function mediaCard(item, i, count) {
  const ed = state.ed;
  const isQuote = item.type === "quote";
  const visual = item.type === "photo" || item.type === "video";
  const legend = `${i + 1}. ${ITEM_LABELS[item.type] || "Elemento"}${isQuote ? "" : `: ${item.file}`}`;
  const patch = (p) => setWork(updateMediaItem(ed.work, i, p));
  const parts = [h("legend", {}, legend)];

  if (isQuote) {
    parts.push(
      field("Texto de la cita", (id) => textArea(id, item.text, 600, (v) => patch({ text: v }), 3)),
      field("Cuándo (opcional)", (id) => textInput(id, item.when, 60, (v) => patch({ when: v === "" ? undefined : v }))),
    );
  } else {
    parts.push(field("Pie de foto", (id) => textArea(id, item.caption, 300, (v) => {
      if (v === "" && !("caption" in ed.work.media[i])) return;
      setWork(editCaption(ed.work, i, v));
      syncDefinitive();
    }, 2)));
    if (item.type === "photo") {
      parts.push(field("Texto alternativo", (id) => textInput(id, item.alt, 200, (v) => patch({ alt: v === "" ? undefined : v })),
        "Describe la foto para quien no puede verla."));
    }
    if (item.type === "photo" || item.type === "pdf") {
      parts.push(
        field("Tamaño", (id) => select(id, [["normal", "Normal"], ["small", "Pequeña"]], item.size || "normal", (v) => {
          patch({ size: v === "small" ? "small" : ("size" in ed.work.media[i] ? "normal" : undefined) });
        })),
        field("Marco", (id) => select(id, [["none", "Ninguno"], ["letter", "Carta"]], item.frame || "none", (v) => {
          patch({ frame: v === "letter" ? "letter" : undefined });
        })),
      );
    }
    if (item.type === "pdf") {
      const key = `pages${i}`;
      parts.push(field("Páginas", (id) => {
        const input = textInput(id, (item.pages || []).join(", "), 120, (v, el) => {
          const r = parsePages(v);
          if (!r.ok) {
            ed.fieldErrors.set(key, `Elemento ${i + 1}: ${r.message}`);
            el.setAttribute("aria-invalid", "true");
            refresh();
            return;
          }
          ed.fieldErrors.delete(key);
          el.removeAttribute("aria-invalid");
          patch({ pages: r.pages.length ? r.pages : undefined });
        });
        return input;
      }, "Ejemplo: 1, 2, 5-7. Déjalo vacío para usar todas."));
    }
  }

  if (i > 0) {
    parts.push(checkbox("Mostrar junto a la anterior", item.pairWithPrevious === true, (v) => {
      patch({ pairWithPrevious: v ? true : ("pairWithPrevious" in ed.work.media[i] ? false : undefined) });
    }).label);
  }
  if (visual) {
    const radio = h("input", { type: "radio", name: "cover", checked: ed.work.cover === item.file });
    on(radio, "change", () => { if (radio.checked) setWork(setCover(ed.work, item.file)); });
    parts.push(h("label", { class: "radio" }, radio, h("span", {}, "Usar como portada")));
  }

  parts.push(h("div", { class: "row" },
    button("Subir", () => moveItem(i, -1), "btn", { "aria-label": `Subir el elemento ${i + 1}`, disabled: i === 0 }),
    button("Bajar", () => moveItem(i, 1), "btn", { "aria-label": `Bajar el elemento ${i + 1}`, disabled: i === count - 1 }),
    button("Quitar", () => removeItem(i), "btn danger", { "aria-label": `Quitar el elemento ${i + 1}` })));

  return h("li", { class: "item" }, h("fieldset", {}, parts));
}

function renderMedia() {
  const ed = state.ed;
  const list = clear(ed.dom.mediaList);
  const media = ed.work.media || [];
  if (!media.length) list.append(h("li", {}, h("p", { class: "hint" }, "Todavía no hay elementos.")));
  media.forEach((item, i) => list.append(mediaCard(item, i, media.length)));
  refresh();
}

function addQuote() {
  const ed = state.ed;
  setWork(applyEdits(ed.work, { media: [...ed.work.media, { type: "quote", text: "" }] }));
  renderMedia();
}

function renderAddMsg() {
  const ed = state.ed;
  const box = clear(ed.dom.addMsg);
  for (const w of ed.uploadWarnings) box.append(h("p", { class: "warn" }, w));
  for (const e of ed.uploadErrors) box.append(h("p", { class: "error" }, e));
  if (ed.uploadErrors.length) {
    box.append(button("Entendido", () => {
      ed.uploadErrors = [];
      renderAddMsg();
      refresh();
    }, "btn"));
  }
}

async function addFiles(files) {
  const ed = state.ed;
  if (!files.length) return;
  ed.uploadErrors = [];
  ed.uploadWarnings = [];
  setStatus("Preparando los archivos…", true);
  const prepErrors = [];
  const infos = [];
  for (const file of files) {
    try {
      const kind = classify(file.name);
      if (kind === "photo") {
        const blob = await prepareImage(file);
        infos.push({ name: jpegName(file.name), size: blob.size, blob });
      } else if (kind === "video") {
        const duration = file.size <= LIMITS.videoMax ? await readVideoDuration(file) : null;
        infos.push({ name: file.name, size: file.size, duration, blob: file });
      } else {
        infos.push({ name: file.name, size: file.size, blob: file });
      }
    } catch {
      prepErrors.push(`No se pudo leer la foto "${file.name}". Prueba con otra.`);
    }
  }
  const existing = [...ed.files].filter((f) => !ed.removed.has(f)).concat([...ed.added.keys()]);
  const plan = planUploads(infos, { existing, slugifyFileName });
  const errors = [...prepErrors, ...plan.errors];
  if (ed.added.size + plan.items.length > LIMITS.maxFiles && !errors.includes(UP_MSG.tooMany)) errors.push(UP_MSG.tooMany);

  if (errors.includes(UP_MSG.tooMany)) {
    ed.uploadErrors = errors;
  } else {
    const queues = new Map();
    for (const info of infos) {
      if (!queues.has(info.name)) queues.set(info.name, []);
      queues.get(info.name).push(info);
    }
    const newItems = [];
    for (const it of plan.items) {
      const info = queues.get(it.original).shift();
      ed.added.set(it.name, { blob: info.blob, kind: it.kind });
      newItems.push({ type: it.kind, file: it.name });
    }
    ed.uploadErrors = errors;
    ed.uploadWarnings = plan.warnings;
    if (newItems.length) {
      let next = applyEdits(ed.work, { media: [...ed.work.media, ...newItems] });
      const needsCover = next.kind === "prologue" || next.kind === "chapter";
      const firstVisual = newItems.find((m) => m.type === "photo" || m.type === "video");
      if (needsCover && !next.cover && firstVisual) next = setCover(next, firstVisual.file);
      ed.work = next;
    }
  }
  setStatus("");
  renderMedia();
  renderAddMsg();
}

// ---------- publish and delete ----------

function setBusy(busy) {
  state.busy = busy;
  if (state.ed) refresh();
}

function describeError(err) {
  return err instanceof GitHubError ? err.message : GH_MSG.publish;
}

async function publishChapter() {
  const ed = state.ed;
  if (state.busy || !ed || editorErrors(ed).length) return;
  setBusy(true);
  setStatus("Publicando…", true);
  try {
    if (ed.isNew && !ed.folder) {
      let folder;
      do { folder = newFolderName(ed.work.title, slugify); } while (state.chapters.some((c) => c.folder === folder));
      ed.folder = folder;
    }
    const dir = `content/chapters/${ed.folder}`;
    const finalWork = ed.isNew ? orderKeys(ed.work) : ed.work;
    const files = [{ path: `${dir}/chapter.json`, base64: textToBase64(serialize(finalWork)) }];
    const addedPaths = new Set();
    for (const [name, { blob }] of ed.added) {
      const path = `${dir}/media/${name}`;
      addedPaths.add(path);
      files.push({ path, base64: await blobToBase64(blob) });
    }
    for (const [slug, order] of Object.entries(ed.renumbered)) {
      const other = state.chapters.find((c) => c.folder === slug);
      if (other?.json) files.push({ path: `content/chapters/${slug}/chapter.json`, base64: textToBase64(serialize(applyEdits(other.json, { order }))) });
    }
    const deletePaths = [...ed.removed].map((n) => `${dir}/media/${n}`).filter((p) => !addedPaths.has(p));
    const title = ed.work.title.trim();
    const { commitSha } = await state.client.publish({ message: `Capítulo: ${title}`, files, deletePaths });
    await afterPublish(commitSha, title);
  } catch (err) {
    setStatus(describeError(err), true);
    setBusy(false);
    if (state.ed) state.ed.dom.status.dataset.keep = "1";
    return;
  }
  setBusy(false);
}

async function deleteChapter() {
  const ed = state.ed;
  if (state.busy || !ed || ed.isNew) return;
  const title = ed.work.title || ed.folder;
  if (!confirm(`¿Eliminar el capítulo «${title}»? Se borrarán también sus fotos, videos y PDF.`)) return;
  setBusy(true);
  setStatus("Eliminando…", true);
  try {
    const { commitSha } = await state.client.publish({
      message: `Eliminar capítulo: ${ed.folder}`,
      deletePrefixes: [`content/chapters/${ed.folder}/`],
    });
    await afterPublish(commitSha, title);
  } catch (err) {
    setStatus(describeError(err), true);
    setBusy(false);
    return;
  }
  setBusy(false);
}

async function afterPublish(sha, title) {
  const pending = { sha, title, startedAt: Date.now() };
  sessionStorage.setItem(PENDING_KEY, JSON.stringify(pending));
  try {
    await loadChapters();
  } catch { /* the list will refresh on the next unlock */ }
  renderList();
  startTracking(pending);
}

// ---------- live and failure detection ----------

function showLive(kind, text, link) {
  const box = clear(els.live);
  box.hidden = false;
  box.className = `card live${kind === "ok" ? " ok" : kind === "bad" ? " bad" : ""}`;
  box.append(h("p", {}, text));
  if (link) box.append(h("p", {}, h("a", { href: link.href, target: "_blank", rel: "noopener noreferrer" }, link.text)));
}

const repoUrl = () => `https://github.com/${state.cfg.owner}/${state.cfg.repo}`;

function stopTracking() {
  const t = state.track;
  if (!t) return;
  clearInterval(t.buildTimer);
  clearInterval(t.runsTimer);
  state.track = null;
}

function finishTracking(kind, text, link) {
  stopTracking();
  sessionStorage.removeItem(PENDING_KEY);
  showLive(kind, text, link);
}

function resumePending() {
  let pending = null;
  try { pending = JSON.parse(sessionStorage.getItem(PENDING_KEY) || "null"); } catch { pending = null; }
  if (pending && pending.sha) startTracking(pending);
}

function startTracking(pending) {
  stopTracking();
  const t = { ...pending, runsOff: false, checking: false, runsChecking: false, buildTimer: null, runsTimer: null };
  state.track = t;
  showLive("pending", `Publicado: «${pending.title}». Se está construyendo; suele tardar de 2 a 4 minutos.`);

  const timedOut = () => {
    if (Date.now() - t.startedAt < TIMEOUT_MS) return false;
    finishTracking("bad", TIMEOUT_MSG, { href: `${repoUrl()}/actions`, text: "Ver las compilaciones en GitHub" });
    return true;
  };

  const checkBuild = async () => {
    if (state.track !== t || t.checking) return;
    if (timedOut()) return;
    t.checking = true;
    try {
      const res = await fetch(`${apiOverridden ? apiBase : ""}/build.json?t=${Date.now()}`, { cache: "no-store" });
      if (res.ok && state.track === t) {
        const data = await res.json();
        let live = data && data.sha === t.sha;
        if (!live && data && typeof data.sha === "string" && data.sha) {
          const status = await state.client.compareStatus(t.sha, data.sha);
          live = status === "ahead" || status === "identical";
        }
        if (live && state.track === t) finishTracking("ok", `Ya está publicado: «${t.title}».`);
      }
    } catch { /* try again on the next tick */ }
    t.checking = false;
  };

  const checkRuns = async () => {
    if (state.track !== t || t.runsOff || t.runsChecking) return;
    t.runsChecking = true;
    try {
      const runs = await state.client.listRuns(t.sha);
      if (state.track !== t) return;
      if (runs === null) {
        t.runsOff = true; // no Actions access: build.json polling only
        clearInterval(t.runsTimer);
        return;
      }
      const failed = runs.find((r) => r.conclusion === "failure" || r.conclusion === "timed_out");
      if (failed) {
        finishTracking("bad", FAILURE_MSG, {
          href: failed.html_url || `${repoUrl()}/actions`,
          text: "Ver qué falló en GitHub",
        });
        els.live.append(h("p", { class: "hint" },
          "Lo publicado antes sigue en línea. Para deshacer el cambio, abre el commit en GitHub y elige «Revert»."));
      }
    } catch { /* try again on the next tick */ }
    if (state.track === t) t.runsChecking = false;
  };

  t.buildTimer = setInterval(checkBuild, BUILD_POLL_MS);
  t.runsTimer = setInterval(checkRuns, RUNS_POLL_MS);
  checkBuild();
  checkRuns();
}

// ---------- init ----------

async function init() {
  for (const [key, id] of Object.entries({
    auth: "auth", app: "app", form: "auth-form", intro: "auth-intro", token: "token", tokenField: "token-field",
    password: "password", passwordLabel: "password-label", passwordHint: "password-hint",
    authError: "auth-error", submit: "auth-submit", forget: "forget",
  })) els[key] = document.getElementById(id);

  state.vault = createVault();
  setAuthMode(state.vault.hasStoredToken() ? "unlock" : "setup");
  on(els.form, "submit", onAuthSubmit);
  on(els.forget, "click", onForget);

  const { cfg, error } = await loadConfig();
  if (error) {
    state.cfgError = error;
    showAuthError(error);
    setText(els.intro, "El administrador no está listo.");
    return;
  }
  state.cfg = cfg;
  els.submit.disabled = false;
  if (state.vault.isLocked()) startLockCountdown();
}

init();
