import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const CONTENT_DIR = process.env.CONTENT_DIR
  ? path.resolve(process.env.CONTENT_DIR)
  : path.join(ROOT, "content");

export const DIST_DIR = process.env.DIST_DIR
  ? path.resolve(process.env.DIST_DIR)
  : path.join(ROOT, "dist");

// Read-only source of the original material. May be absent (e.g. in CI).
export const ALBUM_SRC = process.env.ALBUM_SRC
  ? path.resolve(process.env.ALBUM_SRC)
  : "/home/anbernal/kama/album-for-kiro";

export const BUILD_DIR = path.join(ROOT, "build");
export const CACHE_DIR = path.join(ROOT, ".cache", "media");

// Must equal PIPELINE_VERSION in .github/workflows/deploy.yml.
export const PIPELINE_VERSION = "1";
