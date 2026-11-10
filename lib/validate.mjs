// Node wrapper around validate-core: reads chapter folders, adds disk checks
// (pdf page count via pdfinfo; extension per type is enforced by the core).
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONTENT_DIR } from "./paths.mjs";
import { pdfPageCount } from "./media/pdf.mjs";
import { validateAll, MAX_PDF_PAGES } from "./validate-core.mjs";

async function listDirs(dir) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
}

async function listFiles(dir) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isFile()).map((e) => e.name);
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
}

/**
 * Validate every chapter under `<contentDir>/chapters`.
 * @returns {Promise<string[]>} all violations; empty when valid
 */
export async function validateContent({ contentDir = CONTENT_DIR } = {}) {
  const root = path.join(contentDir, "chapters");
  const errors = [];
  const chapters = [];

  for (const slug of await listDirs(root)) {
    const dir = path.join(root, slug);
    let json;
    try {
      json = JSON.parse(await fs.readFile(path.join(dir, "chapter.json"), "utf8"));
    } catch (e) {
      const msg = e.code === "ENOENT" ? "no existe chapter.json" : `JSON inválido (${e.message})`;
      errors.push(`[capítulo:${slug}] chapter.json: ${msg}`);
      continue;
    }
    const files = await listFiles(path.join(dir, "media"));
    chapters.push({ slug, json, files, dir });
  }

  errors.push(...validateAll(chapters));

  // Disk checks: PDF page count and `pages` range.
  for (const ch of chapters) {
    const media = Array.isArray(ch.json?.media) ? ch.json.media : [];
    for (let i = 0; i < media.length; i++) {
      const item = media[i];
      if (item?.type !== "pdf" || typeof item.file !== "string" || !ch.files.includes(item.file)) continue;
      const label = `media[${i}] "${item.file}"`;
      let count;
      try {
        count = await pdfPageCount(path.join(ch.dir, "media", item.file));
      } catch (e) {
        errors.push(`[capítulo:${ch.slug}] ${label}: ${e.message}`);
        continue;
      }
      if (Array.isArray(item.pages)) {
        for (const n of item.pages) {
          if (Number.isInteger(n) && n > count) {
            errors.push(`[capítulo:${ch.slug}] ${label}: la página ${n} no existe (el PDF tiene ${count})`);
          }
        }
      } else if (count > MAX_PDF_PAGES) {
        errors.push(`[capítulo:${ch.slug}] ${label}: el PDF tiene ${count} páginas y el máximo es ${MAX_PDF_PAGES}`);
      }
    }
  }
  return errors;
}

/** For scripts/media.mjs: prints every violation and exits 1 if any. */
export async function assertContentValid(options) {
  const errors = await validateContent(options);
  if (errors.length > 0) {
    for (const e of errors) console.error(e);
    console.error(`\n${errors.length} error(es) de validación.`);
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const errors = await validateContent();
  if (errors.length > 0) {
    for (const e of errors) console.error(e);
    console.error(`\n${errors.length} error(es) de validación.`);
    process.exit(1);
  }
  console.log("Contenido válido.");
}
