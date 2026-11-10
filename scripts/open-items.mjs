// Generates OPEN_ITEMS.md (Spanish) at the project root. Never copied to dist/.
//
// content/open-items.json schema (all keys optional; unknown keys ignored):
//   {
//     "sections": [
//       { "title": "Texto del título",
//         "items": [
//           "texto simple",
//           { "text": "texto", "check": { "chapter": "slug", "file": "archivo.jpg" } }
//         ] }
//     ],
//     "Discrepancias de nombres": ["texto", ...]   // written by `npm run seed`
//   }
// `check` is an optional hint to detect stale entries: if `check.chapter` names a chapter
// that no longer exists, or `check.file` is not a media file of that chapter, the entry is
// rendered with "(obsoleto: ...)" . Stale entries are marked, never errors.
// A section titled like PRIVACY_TITLE merges with the hard-coded privacy section.
//
// Inputs missing or malformed never crash: they are skipped. Output has no timestamps.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONTENT_DIR, BUILD_DIR, ROOT } from "../lib/paths.mjs";

export const MISMATCH_KEY = "Discrepancias de nombres";
export const PRIVACY_TITLE = "Riesgo de privacidad aceptado";
export const PRIVACY_TEXT =
  "El álbum no usa autenticación: la privacidad se apoya en `noindex` y en una dirección imposible de adivinar. " +
  "Quien tenga el enlace puede verlo. Este riesgo está aceptado.";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v) => (typeof v === "string" ? v.trim() : "");

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return undefined;
  }
}

async function readChapters(contentDir) {
  const root = path.join(contentDir, "chapters");
  let names = [];
  try {
    names = (await fs.readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
  const chapters = [];
  for (const slug of names.sort()) {
    const json = await readJson(path.join(root, slug, "chapter.json"));
    if (isObj(json)) chapters.push({ slug, json });
  }
  chapters.sort((a, b) => (Number(a.json.order) || 0) - (Number(b.json.order) || 0) || (a.slug < b.slug ? -1 : 1));
  return chapters;
}

function normalizeItem(raw) {
  if (typeof raw === "string") return str(raw) ? { text: str(raw) } : null;
  if (isObj(raw) && str(raw.text)) return { text: str(raw.text), check: isObj(raw.check) ? raw.check : undefined };
  return null;
}

function staleReason(check, chapters) {
  if (!check) return "";
  const slug = str(check.chapter);
  const file = str(check.file);
  if (!slug) return "";
  const ch = chapters.find((c) => c.slug === slug);
  if (!ch) return `el capítulo "${slug}" ya no existe`;
  if (file) {
    const media = Array.isArray(ch.json.media) ? ch.json.media : [];
    const has = media.some((m) => isObj(m) && m.file === file) || ch.json.cover === file;
    if (!has) return `"${file}" ya no está en el capítulo "${slug}"`;
  }
  return "";
}

/** Pure builder: returns the Markdown text. */
export function buildOpenItems({ curated, chapters = [], report }) {
  const sections = []; // {title, items:[string]}
  const add = (title, items) => {
    if (items.length) sections.push({ title, items });
  };
  const c = isObj(curated) ? curated : {};

  // 1. Privacy: always present (hard-coded fallback), merged with curated section of same title.
  const privacy = [PRIVACY_TEXT];
  const curatedSections = [];
  for (const s of Array.isArray(c.sections) ? c.sections : []) {
    if (!isObj(s) || !str(s.title)) continue;
    const items = (Array.isArray(s.items) ? s.items : []).map(normalizeItem).filter(Boolean).map((it) => {
      const why = staleReason(it.check, chapters);
      return why ? `${it.text} _(obsoleto: ${why})_` : it.text;
    });
    if (str(s.title).toLowerCase() === PRIVACY_TITLE.toLowerCase()) {
      for (const t of items) if (!privacy.includes(t)) privacy.push(t);
    } else {
      curatedSections.push({ title: str(s.title), items });
    }
  }
  add(PRIVACY_TITLE, privacy);
  for (const s of curatedSections) add(s.title, s.items);

  // 2. Seed mismatches.
  const mism = Array.isArray(c[MISMATCH_KEY]) ? c[MISMATCH_KEY].map(str).filter(Boolean) : [];
  add(MISMATCH_KEY, [...new Set(mism)]);

  // 3. Auto-detected from content.
  const noCaption = [];
  const drafts = [];
  const noNote = [];
  const noPlace = [];
  const noDate = [];
  for (const { slug, json } of chapters) {
    const label = `${slug}`;
    const media = Array.isArray(json.media) ? json.media : [];
    const files = media
      .filter((m) => isObj(m) && m.type !== "quote" && typeof m.file === "string" && !str(m.caption))
      .map((m) => m.file);
    if (files.length) noCaption.push(`${label}: ${files.length} sin pie de foto (${files.join(", ")})`);
    if (json.draft === true) drafts.push(`${label}: texto provisional, reescríbelo con tus palabras`);
    if (json.kind === "teaser") continue;
    if (!str(json.note)) noNote.push(label);
    if (!str(json.place)) noPlace.push(label);
    if (!str(json.dateText)) noDate.push(label);
  }
  add("Elementos sin pie de foto", noCaption);
  add("Capítulos con texto provisional", drafts);
  add("Capítulos sin nota", noNote);
  add("Capítulos sin lugar", noPlace);
  add("Capítulos sin fecha", noDate);

  // 4. Auto-detected from the media report.
  const r = isObj(report) ? report : {};
  const heavy = (Array.isArray(r.heavy) ? r.heavy : []).filter(isObj).map((h) => {
    const kb = Number.isFinite(h.bytes) ? ` ${Math.round(h.bytes / 1024)} KB` : "";
    const budget = Number.isFinite(h.budget) ? ` (presupuesto ${Math.round(h.budget / 1024)} KB)` : "";
    const width = h.width ? ` ${h.width} px` : "";
    return `${h.name} ${h.format ?? ""}${width}${kb}${budget}`.replace(/\s+/g, " ").trim();
  });
  add("Fotos pesadas", heavy);
  add("PDF con número de páginas inesperado", (Array.isArray(r.openItems) ? r.openItems : []).map(str).filter(Boolean));

  const lines = [
    "# Pendientes del álbum",
    "",
    "Archivo generado por `npm run open-items`. No lo edites a mano y no se publica en el sitio.",
    "",
  ];
  for (const s of sections) {
    lines.push(`## ${s.title}`, "");
    for (const t of s.items) lines.push(`- ${t}`);
    lines.push("");
  }
  return lines.join("\n");
}

/** Reads inputs (all optional) and writes the file. Returns the output path. */
export async function generateOpenItems({
  contentDir = CONTENT_DIR,
  buildDir = BUILD_DIR,
  outFile = path.join(ROOT, "OPEN_ITEMS.md"),
} = {}) {
  const curated = await readJson(path.join(contentDir, "open-items.json"));
  const report = await readJson(path.join(buildDir, "media-report.json"));
  const chapters = await readChapters(contentDir);
  const text = buildOpenItems({ curated, chapters, report });
  await fs.writeFile(outFile, text);
  return outFile;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = await generateOpenItems();
  console.log(`OPEN_ITEMS.md escrito: ${out}`);
}
