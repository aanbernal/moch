// Pure chapter validation (design 4.2). NO imports on purpose: this exact file is
// copied to dist/admin/validate-core.mjs and runs in the browser and in Node.
// It does not slugify: uppercase names are rejected, not corrected.

export const ALLOWED_EXTENSIONS = {
  photo: ["jpg", "jpeg", "png", "webp"],
  video: ["mp4", "mov", "m4v"],
  pdf: ["pdf"],
};

export const KINDS = ["prologue", "chapter", "teaser"];
export const ITEM_TYPES = ["photo", "video", "pdf", "quote"];
export const TOP_LEVEL_KEYS = [
  "schema", "order", "kind", "title", "dateText", "place", "note", "draft", "cover", "media",
];
export const MAX_MEDIA = 80;
export const MAX_PDF_PAGES = 30;

const FILE_RE = /^[a-z0-9][a-z0-9._-]*$/;
const URL_RE = /https?:\/\//i;
const isStr = (v) => typeof v === "string";
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** Same normalisation as slugify, kept inline to stay import-free. Used for collisions only. */
export function normaliseSlug(input) {
  return String(input)
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function extensionOf(file) {
  const i = String(file).lastIndexOf(".");
  return i <= 0 ? "" : String(file).slice(i + 1).toLowerCase();
}

function findUrls(value, path, out) {
  if (isStr(value)) {
    if (URL_RE.test(value)) out.push(path);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => findUrls(v, `${path}[${i}]`, out));
  } else if (isObj(value)) {
    for (const [k, v] of Object.entries(value)) findUrls(v, path ? `${path}.${k}` : k, out);
  }
}

/**
 * @param {unknown} json parsed chapter.json
 * @param {{files: Iterable<string>, slug: string}} ctx files = basenames in the chapter media folder
 * @returns {string[]} errors as "[capítulo:<slug>] campo: mensaje"; empty means valid
 */
export function validateChapter(json, { files = [], slug = "?" } = {}) {
  const errors = [];
  const err = (field, msg) => errors.push(`[capítulo:${slug}] ${field}: ${msg}`);
  const fileSet = new Set(files);

  if (!isObj(json)) {
    err("chapter.json", "debe ser un objeto JSON");
    return errors;
  }

  for (const key of Object.keys(json)) {
    if (!TOP_LEVEL_KEYS.includes(key)) err(key, "campo desconocido");
  }

  if (json.schema !== 1 || !Number.isInteger(json.schema)) err("schema", "debe ser el entero 1");
  if (typeof json.order !== "number" || !Number.isFinite(json.order)) err("order", "debe ser un número finito");
  if (!KINDS.includes(json.kind)) err("kind", `debe ser ${KINDS.join(" | ")}`);

  if (!isStr(json.title) || json.title.trim() === "") err("title", "es obligatorio y no puede estar vacío");
  else if (json.title.length > 120) err("title", "máximo 120 caracteres");

  for (const [key, max] of [["dateText", 60], ["place", 80], ["note", 600]]) {
    if (json[key] === undefined) continue;
    if (!isStr(json[key])) err(key, "debe ser texto");
    else if (json[key].length > max) err(key, `máximo ${max} caracteres`);
  }
  if (json.draft !== undefined && typeof json.draft !== "boolean") err("draft", "debe ser verdadero o falso");

  const urls = [];
  findUrls(json, "", urls);
  for (const p of urls) err(p, "no se permiten URLs externas (http:// o https://)");

  // media
  const media = json.media;
  const items = Array.isArray(media) ? media : [];
  if (!Array.isArray(media)) {
    err("media", "debe ser una lista");
  } else {
    if (media.length === 0 && json.kind !== "teaser") err("media", "no puede estar vacío (solo el teaser)");
    if (media.length > MAX_MEDIA) err("media", `máximo ${MAX_MEDIA} elementos`);
  }

  const seenFiles = new Set();
  const coverable = new Set();
  items.forEach((item, i) => {
    const at = `media[${i}]`;
    if (!isObj(item)) return err(at, "debe ser un objeto");
    const type = item.type;
    if (!ITEM_TYPES.includes(type)) return err(`${at}.type`, `debe ser ${ITEM_TYPES.join(" | ")}`);

    if (type === "quote") {
      if (!isStr(item.text) || item.text.trim() === "") err(`${at}.text`, "es obligatorio");
      else if (item.text.length > 600) err(`${at}.text`, "máximo 600 caracteres");
      if (item.when !== undefined && (!isStr(item.when) || item.when.length > 60)) {
        err(`${at}.when`, "debe ser texto de máximo 60 caracteres");
      }
    } else {
      const f = item.file;
      const label = `${at} "${isStr(f) ? f : ""}"`;
      if (!isStr(f) || f === "") {
        err(`${at}.file`, "es obligatorio");
      } else {
        if (!FILE_RE.test(f)) {
          err(label, "nombre inválido (solo minúsculas, números, punto, guion y guion bajo)");
        } else if (!ALLOWED_EXTENSIONS[type].includes(extensionOf(f))) {
          err(label, `extensión no permitida para ${type} (${ALLOWED_EXTENSIONS[type].join(", ")})`);
        }
        if (!fileSet.has(f)) err(label, "archivo no existe");
        if (seenFiles.has(f)) err(label, "archivo repetido");
        seenFiles.add(f);
        if (type === "photo" || type === "video") coverable.add(f);
      }
    }

    if (item.caption !== undefined && (!isStr(item.caption) || item.caption.length > 300)) {
      err(`${at}.caption`, "debe ser texto de máximo 300 caracteres");
    }
    if (item.alt !== undefined && (!isStr(item.alt) || item.alt.length > 200)) {
      err(`${at}.alt`, "debe ser texto de máximo 200 caracteres");
    }
    if (item.pairWithPrevious !== undefined && typeof item.pairWithPrevious !== "boolean") {
      err(`${at}.pairWithPrevious`, "debe ser verdadero o falso");
    }
    if (item.maxWidth !== undefined) {
      if (type !== "photo") err(`${at}.maxWidth`, "solo aplica a fotos");
      else if (![480, 800, 1200].includes(item.maxWidth)) err(`${at}.maxWidth`, "debe ser 480, 800 o 1200");
    }
    if (item.size !== undefined && !["normal", "small"].includes(item.size)) {
      err(`${at}.size`, "debe ser normal | small");
    }
    if (item.frame !== undefined && item.frame !== "letter") err(`${at}.frame`, 'solo se permite "letter"');
    if (item.pages !== undefined) {
      if (type !== "pdf") err(`${at}.pages`, "solo aplica a PDF");
      else if (!Array.isArray(item.pages) || !item.pages.every((n) => Number.isInteger(n) && n >= 1)) {
        err(`${at}.pages`, "debe ser una lista de enteros desde 1");
      } else if (item.pages.length > MAX_PDF_PAGES) {
        err(`${at}.pages`, `máximo ${MAX_PDF_PAGES} páginas`);
      }
    }
  });

  // pairWithPrevious: a run (leader + followers) longer than 2 is an error
  let run = 0;
  items.forEach((item, i) => {
    if (isObj(item) && item.pairWithPrevious === true && i > 0) {
      run += 1;
      if (run === 3) err(`media[${i}].pairWithPrevious`, "no se pueden emparejar más de 2 elementos seguidos");
    } else {
      run = 1;
    }
  });

  // cover
  if (json.kind === "prologue" || json.kind === "chapter") {
    if (!isStr(json.cover) || json.cover === "") err("cover", "es obligatoria");
    else if (!coverable.has(json.cover)) err("cover", `"${json.cover}" no es el archivo de una foto o video del capítulo`);
  } else if (json.cover !== undefined && !isStr(json.cover)) {
    err("cover", "debe ser texto");
  }

  return errors;
}

/**
 * Cross-chapter rules plus every per-chapter rule.
 * @param {{slug: string, json: unknown, files: Iterable<string>}[]} chapters
 * @returns {string[]}
 */
export function validateAll(chapters) {
  const errors = [];
  const bySlug = new Map();
  const byNorm = new Map();
  const prologues = [];

  for (const ch of chapters) {
    errors.push(...validateChapter(ch.json, { files: ch.files, slug: ch.slug }));
    if (bySlug.has(ch.slug)) {
      errors.push(`[capítulo:${ch.slug}] slug: repetido`);
    }
    bySlug.set(ch.slug, true);
    const norm = normaliseSlug(ch.slug);
    if (byNorm.has(norm) && byNorm.get(norm) !== ch.slug) {
      errors.push(
        `[capítulo:${ch.slug}] slug: colisiona con "${byNorm.get(norm)}" al normalizarse ("${norm}")`,
      );
    } else if (!byNorm.has(norm)) {
      byNorm.set(norm, ch.slug);
    }
    if (isObj(ch.json) && ch.json.kind === "prologue") prologues.push(ch.slug);
  }

  if (prologues.length > 1) {
    for (const s of prologues.slice(1)) {
      errors.push(`[capítulo:${s}] kind: ya existe un prólogo ("${prologues[0]}"); solo puede haber uno`);
    }
  }
  return errors;
}
