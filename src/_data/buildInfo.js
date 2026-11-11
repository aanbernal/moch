import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildInfo } from "../../lib/build-info.mjs";
import { loadChapters } from "../../lib/chapters-loader.mjs";
import { buildPages } from "../../lib/book-model.mjs";
import site from "./site.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function readManifest() {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, "build/media-manifest.json"), "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return {};
    throw e;
  }
}

// Pure build manifest (no timestamps) plus the deploy stamp and the inlined service worker logic.
export default function () {
  const chapters = loadChapters();
  const fontFiles = fs.readdirSync(path.join(root, "src/assets/fonts")).filter((f) => f.endsWith(".woff2"));
  const ids = buildPages(chapters, site).map((p) => p.id);
  const info = buildInfo(readManifest(), chapters, { ids, fontFiles });
  const sha = process.env.GITHUB_SHA || "local";
  // sw-logic.js is inlined into /sw.js so the worker is one self-contained script (no importScripts).
  const swLogic = fs
    .readFileSync(path.join(root, "src/sw-logic.js"), "utf8")
    .replace(/^export\s+/gm, "");
  return { ...info, sha, builtAt: new Date().toISOString(), swLogic };
}
