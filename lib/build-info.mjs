import { createHash } from "node:crypto";

/** Collect every "/m/..." url string found anywhere in the media manifest (variants, video, poster, pdf pages). */
export function collectMediaUrls(manifest) {
  const out = new Set();
  const walk = (v) => {
    if (typeof v === "string") return;
    if (Array.isArray(v)) return v.forEach(walk);
    if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        if (k === "url" && typeof x === "string" && x.startsWith("/m/")) out.add(x);
        else walk(x);
      }
    }
  };
  walk(manifest ?? {});
  return [...out].sort();
}

/** Public pages the service worker may cache: cover, TOC and every chapter. Sorted, unique. */
export function collectPages(chapters) {
  return [...new Set(["/", "/indice/", ...(chapters ?? []).map((c) => c.url)])].sort();
}

/** Files the service worker installs: the Flipbook document, its assets and the fonts. Sorted, unique. */
export const SHELL_BASE = [
  "/",
  "/assets/book-logic.js",
  "/assets/book.css",
  "/assets/book.js",
  "/assets/fonts.css",
  "/assets/icon.svg",
  "/assets/paper.svg",
  "/assets/themes.css",
];

export function collectShell(fontFiles = []) {
  return [...new Set([...SHELL_BASE, ...fontFiles.map((f) => `/assets/fonts/${f}`)])].sort();
}

/**
 * 12 hex chars of SHA-256 over the sorted lists. No timestamps.
 * `ids` (the ordered Page ids) is optional so the earlier two-list form keeps its value.
 */
export function computeBuildId(media, pages, ids) {
  const m = [...media].sort();
  const p = [...pages].sort();
  const payload = ids === undefined ? { media: m, pages: p } : { media: m, pages: p, ids: [...ids] };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 12);
}

/**
 * @param {object} mediaManifest
 * @param {object[]} chapters
 * @param {{ ids?: string[], fontFiles?: string[] }} [book]  Page ids (ordered) and font file names
 * `pages` stays for the current service worker (task 15.5 moves it to `shell`).
 */
export function buildInfo(mediaManifest, chapters, book = {}) {
  const media = collectMediaUrls(mediaManifest);
  const pages = collectPages(chapters);
  const shell = collectShell(book.fontFiles);
  const ids = book.ids ?? [];
  // buildId covers shell, media and ids, so a text-only change that adds or removes a Page still changes it.
  return { buildId: computeBuildId(media, shell, book.ids ? ids : undefined), media, pages, shell, ids };
}
