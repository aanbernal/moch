// PDF to images (design 6.2): pdfinfo for the count, pdftoppm per page, letter photo path.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { run } from "../exec.mjs";
import { CACHE_DIR } from "../paths.mjs";
import { processPhoto } from "./photo.mjs";

export const MAX_PDF_PAGES = 30;
export const LETTER_PDF_PAGES = 2;

/** Page count from `pdfinfo`. File names with spaces are safe (argument arrays). */
export async function pdfPageCount(file) {
  const r = await run("pdfinfo", [file]);
  const m = /^Pages:\s+(\d+)/m.exec(r.stdout);
  if (r.code !== 0 || !m) {
    throw new Error(`No se pudo leer el PDF ${path.basename(file)}: ${r.stderr.trim() || "sin número de páginas"}`);
  }
  return Number(m[1]);
}

/**
 * Validate `pages` (unset = all). Out of range or invalid is an error naming the PDF and page.
 * @returns {number[]}
 */
export function resolvePages({ pages, pageCount, name }) {
  let list;
  if (pages === undefined || pages === null) {
    list = Array.from({ length: pageCount }, (_, i) => i + 1);
  } else {
    list = pages;
    for (const n of list) {
      if (!Number.isInteger(n) || n < 1) {
        throw new Error(`${name}: la página ${n} no es válida (debe ser un entero desde 1)`);
      }
      if (n > pageCount) {
        throw new Error(`${name}: la página ${n} no existe (el PDF tiene ${pageCount} páginas)`);
      }
    }
  }
  if (list.length > MAX_PDF_PAGES) {
    throw new Error(`${name}: se piden ${list.length} páginas y el máximo es ${MAX_PDF_PAGES}`);
  }
  return list;
}

export async function hashFile(file) {
  return crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex");
}

/** Render one page to `<cacheRoot>/pdf/<hash>/page-N.png` (reused if present). */
export async function renderPage({ file, page, hash, cacheRoot = CACHE_DIR }) {
  const dir = path.join(cacheRoot, "pdf", hash);
  await fs.mkdir(dir, { recursive: true });
  const target = path.join(dir, `page-${page}.png`);
  try {
    await fs.access(target);
    return target;
  } catch {
    /* render below */
  }
  const r = await run("pdftoppm", [
    "-png", "-singlefile",
    "-f", String(page), "-l", String(page),
    "-scale-to-x", "1800", "-scale-to-y", "-1",
    file, path.join(dir, `page-${page}`),
  ]);
  if (r.code !== 0) {
    throw new Error(`${path.basename(file)}: falló pdftoppm en la página ${page}: ${r.stderr.trim()}`);
  }
  return target;
}

/**
 * Expand a PDF item into letter-class photo items.
 * @param {object} o
 * @param {string} o.file absolute PDF path
 * @param {string} [o.name] label (default basename)
 * @param {number[]} [o.pages]
 * @param {string} [o.alt] template; `{n}` is replaced by the page number
 * @param {string} [o.frame] default "letter"
 * @param {string} [o.outDir] when set, each page also goes through processPhoto (letter class)
 * @param {string} [o.cacheRoot]
 * @param {boolean} [o.isLetter] expect 2 pages (default: name matches "Para Manuel" or frame letter)
 * @returns {{pageCount, pages, items, openItems:[string]}}
 */
export async function expandPdf({
  file, name = path.basename(file), pages, alt = "", frame = "letter",
  outDir, cacheRoot = CACHE_DIR, isLetter,
}) {
  const pageCount = await pdfPageCount(file);
  const letter = isLetter ?? (frame === "letter" || /para manuel/i.test(name));
  const openItems = [];
  let selected;
  if (letter && pageCount !== LETTER_PDF_PAGES) {
    openItems.push(
      `${name}: tiene ${pageCount} páginas y se esperaban ${LETTER_PDF_PAGES}; se usan las páginas 1 y 2`,
    );
    selected = [1, 2].filter((n) => n <= pageCount);
  } else {
    selected = resolvePages({ pages, pageCount, name });
  }

  const hash = await hashFile(file);
  const items = [];
  for (const page of selected) {
    const png = await renderPage({ file, page, hash, cacheRoot });
    const item = {
      type: "photo",
      file: png,
      page,
      alt: alt.replaceAll("{n}", String(page)),
      frame,
    };
    if (outDir) {
      const key12 = crypto.createHash("sha256").update(`${hash}:${page}`).digest("hex").slice(0, 12);
      item.key12 = key12;
      item.processed = await processPhoto({
        input: png, outDir, key12, frame: "letter", name: `${name} p.${page}`,
      });
    }
    items.push(item);
  }
  return { pageCount, pages: selected, items, openItems };
}
