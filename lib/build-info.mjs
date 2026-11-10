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

/** 12 hex chars of SHA-256 over the sorted media and page lists. No timestamps. */
export function computeBuildId(media, pages) {
  const m = [...media].sort();
  const p = [...pages].sort();
  return createHash("sha256").update(JSON.stringify({ media: m, pages: p })).digest("hex").slice(0, 12);
}

export function buildInfo(mediaManifest, chapters) {
  const media = collectMediaUrls(mediaManifest);
  const pages = collectPages(chapters);
  return { buildId: computeBuildId(media, pages), media, pages };
}
