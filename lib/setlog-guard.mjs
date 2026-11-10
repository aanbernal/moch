import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const PATTERN = /setlog/i;
const TEXT_EXT = new Set([".html", ".json", ".js", ".css", ".webmanifest", ".txt"]);

/** True if the whole relative path (not only a prefix) matches /setlog/i. */
export function isSetlog(pathLike) {
  return PATTERN.test(String(pathLike));
}

/** Recursively list files (relative, forward slashes). Missing dir => []. */
export function walk(dir) {
  const out = [];
  const rec = (abs, rel) => {
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        out.push(r + "/");
        rec(path.join(abs, e.name), r);
      } else out.push(r);
    }
  };
  rec(dir, "");
  return out.sort();
}

/** Offending relative paths (files and directories) under dir. */
export function scanPaths(dir) {
  return walk(dir).filter(isSetlog).map((p) => ({ kind: "path", where: p }));
}

function* strings(value, pointer = "") {
  if (typeof value === "string") yield [pointer, value];
  else if (Array.isArray(value)) for (let i = 0; i < value.length; i++) yield* strings(value[i], `${pointer}[${i}]`);
  else if (value && typeof value === "object")
    for (const [k, v] of Object.entries(value)) {
      if (isSetlog(k)) yield [`${pointer}.${k} (key)`, k];
      yield* strings(v, `${pointer}.${k}`);
    }
}

/** Every string (and key) in the given JSON files that matches. */
export function scanJsonStrings(files) {
  const hits = [];
  for (const file of files) {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      continue; // malformed JSON is the validator's concern
    }
    for (const [ptr, s] of strings(data)) {
      if (isSetlog(s)) hits.push({ kind: "json", where: `${file} ${ptr}` });
    }
  }
  return hits;
}

/** Text files (by extension) under dir whose content matches. */
export function scanTextFiles(dir, exts = TEXT_EXT) {
  const hits = [];
  for (const rel of walk(dir)) {
    if (rel.endsWith("/") || !exts.has(path.extname(rel).toLowerCase())) continue;
    let text;
    try {
      text = fs.readFileSync(path.join(dir, rel), "utf8");
    } catch {
      continue;
    }
    if (isSetlog(text)) hits.push({ kind: "text", where: rel });
  }
  return hits;
}

export function sha256File(file) {
  const h = crypto.createHash("sha256");
  h.update(fs.readFileSync(file));
  return h.digest("hex");
}

/** SHA-256 of each file against denied list [{label, sha256}]. */
export function scanHashes(files, denied) {
  const map = new Map(denied.map((d) => [d.sha256.toLowerCase(), d.label]));
  const hits = [];
  for (const f of files) {
    let digest;
    try {
      digest = sha256File(f);
    } catch {
      continue;
    }
    if (map.has(digest)) hits.push({ kind: "hash", where: f, label: map.get(digest) });
  }
  return hits;
}
