import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Internal media manifest written by scripts/media.mjs: "<slug>/<file>" -> {kind,width,height,variants,...}.
// Returns {} when the pipeline has not run yet.
// MEDIA_MANIFEST (absolute path) lets tests build against a temporary manifest.
const file = process.env.MEDIA_MANIFEST
  ? path.resolve(process.env.MEDIA_MANIFEST)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../build/media-manifest.json");

export default function media() {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return {};
    throw e;
  }
}
