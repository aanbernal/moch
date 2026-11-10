import fs from "node:fs";
import path from "node:path";
import { CONTENT_DIR } from "./paths.mjs";

/**
 * Load chapters sorted by (order, slug). "Capítulo N" is the rank among kind:"chapter".
 * Missing or empty content/chapters yields [].
 */
export function loadChapters(contentDir = CONTENT_DIR) {
  const root = path.join(contentDir, "chapters");
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }

  const list = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const file = path.join(root, e.name, "chapter.json");
    if (!fs.existsSync(file)) continue;
    list.push({ ...JSON.parse(fs.readFileSync(file, "utf8")), slug: e.name });
  }

  list.sort((a, b) => a.order - b.order || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));

  let n = 0;
  for (const ch of list) {
    ch.number = ch.kind === "chapter" ? ++n : null;
    ch.label = ch.kind === "prologue" ? "Prólogo" : ch.kind === "teaser" ? "Continuará" : `Capítulo ${ch.number}`;
    ch.url = `/capitulo/${ch.slug}/`;
  }
  // Fixed nav labels; first prev and last next go to the TOC (design 3).
  list.forEach((ch, i) => {
    ch.prevUrl = i > 0 ? list[i - 1].url : "/indice/";
    ch.nextUrl = i < list.length - 1 ? list[i + 1].url : "/indice/";
    ch.prev = i > 0 ? list[i - 1].slug : null;
    ch.next = i < list.length - 1 ? list[i + 1].slug : null;
  });
  return list;
}

