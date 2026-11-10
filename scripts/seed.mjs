#!/usr/bin/env node
// Seed: copies originals (read-only source) into content/chapters/<slug>/media/
// and writes chapter.json. Usage: node scripts/seed.mjs [--only a,b] [--force]
// Exit codes: 0 ok, 1 missing required file / bad args, 3 setlog, 4 group-shot cover.
import fs from "node:fs";
import path from "node:path";
import { ROOT, ALBUM_SRC, CONTENT_DIR } from "../lib/paths.mjs";
import { slugifyFileName } from "../lib/slug.mjs";
import { isSetlog } from "../lib/setlog-guard.mjs";

const SEED_FILE = path.join(ROOT, "seed", "chapters.seed.json");
const GROUP_SHOTS_FILE = path.join(ROOT, "seed", "group-shots.json");
const MISMATCH_KEY = "Discrepancias de nombres";
const WARN_BYTES = 400 * 1024 * 1024;
const KEY_ORDER = ["schema", "order", "kind", "title", "dateText", "place", "note", "draft", "cover", "media"];

function fail(code, msg) {
  console.error(`seed: ${msg}`);
  process.exit(code);
}

function parseArgs(argv) {
  const args = { only: null, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--force") args.force = true;
    else if (a === "--only") {
      const v = argv[++i];
      if (!v) fail(1, "--only requiere una lista de slugs separados por coma");
      args.only = v.split(",").map((s) => s.trim()).filter(Boolean);
    } else fail(1, `argumento desconocido: ${a}`);
  }
  return args;
}

const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const toSlash = (p) => String(p).replace(/\\/g, "/");

function itemOut(item) {
  const out = { type: item.type };
  for (const [k, v] of Object.entries(item)) {
    if (k === "from" || k === "planPath" || k === "type") continue;
    out[k] = v;
  }
  if (item.from) out.file = slugifyFileName(path.posix.basename(toSlash(item.from)));
  // keep "file" right after "type"
  const { type, file, ...rest } = out;
  return file ? { type, file, ...rest } : { type, ...rest };
}

function chapterJson(def) {
  const media = def.media.map(itemOut);
  const obj = { schema: 1, ...def, media };
  delete obj.slug;
  const ordered = {};
  for (const k of KEY_ORDER) if (obj[k] !== undefined && obj[k] !== "") ordered[k] = obj[k];
  return ordered;
}

const args = parseArgs(process.argv.slice(2));
const seed = readJson(SEED_FILE);
const groupShots = new Set(readJson(GROUP_SHOTS_FILE).map((s) => s.toLowerCase()));
const all = seed.chapters;
const slugs = new Set(all.map((c) => c.slug));

if (args.only) {
  const unknown = args.only.filter((s) => !slugs.has(s));
  if (unknown.length) fail(1, `slugs desconocidos: ${unknown.join(", ")}`);
}
const selected = args.only ? all.filter((c) => args.only.includes(c.slug)) : all;

// ---- Static checks over ALL definitions (no I/O writes yet) ----
for (const def of all) {
  if (isSetlog(def.slug)) fail(3, `slug rechazado (setlog): ${def.slug}`);
  const outNames = new Set();
  for (const item of def.media) {
    if (!item.from) continue;
    if (isSetlog(item.from)) fail(3, `origen rechazado (setlog): ${item.from}`);
    const out = slugifyFileName(path.posix.basename(toSlash(item.from)));
    if (isSetlog(out)) fail(3, `salida rechazada (setlog): ${out}`);
    if (outNames.has(out)) fail(1, `[capítulo:${def.slug}] nombre de salida duplicado: ${out}`);
    outNames.add(out);
  }
  const files = new Set(def.media.filter((i) => i.from).map((i) => itemOut(i).file));
  if (def.cover != null) {
    if (!files.has(def.cover)) fail(1, `[capítulo:${def.slug}] la portada ${def.cover} no es un archivo del capítulo`);
    const photo = def.media.find((i) => i.from && itemOut(i).file === def.cover);
    if (photo.type === "pdf") fail(1, `[capítulo:${def.slug}] la portada no puede ser un PDF`);
    // Req 10.7: no group shots as cover or hero (applies to the prologue hero too)
    if (groupShots.has(`${def.slug}/${def.cover}`.toLowerCase())) {
      fail(4, `[capítulo:${def.slug}] la portada ${def.cover} está en seed/group-shots.json`);
    }
  } else if (def.kind !== "teaser") {
    fail(1, `[capítulo:${def.slug}] falta cover`);
  }
  if (def.kind === "prologue") {
    for (const f of files) {
      if (groupShots.has(`${def.slug}/${f}`.toLowerCase())) fail(4, `[capítulo:${def.slug}] hero ${f} está en seed/group-shots.json`);
    }
  }
  // Cover table (design 4.4)
  if (!(def.slug in seed.coverTable)) fail(1, `[capítulo:${def.slug}] no está en coverTable`);
  const expected = seed.coverTable[def.slug];
  if ((def.cover ?? null) !== expected) {
    fail(1, `[capítulo:${def.slug}] la portada (${def.cover ?? "ninguna"}) no coincide con la tabla (${expected ?? "ninguna"})`);
  }
}

// ---- Source verification (read-only) ----
const missing = [];
const mismatches = [];
for (const def of selected) {
  for (const item of def.media) {
    if (!item.from) continue;
    const src = path.join(ALBUM_SRC, item.from);
    if (!fs.existsSync(src) || !fs.statSync(src).isFile()) missing.push(`${def.slug}: ${item.from}`);
    if (item.planPath && toSlash(item.planPath) !== toSlash(item.from)) {
      mismatches.push(`${path.posix.basename(item.from)}: el plan dice "${item.planPath}" y en disco es "${item.from}"`);
    }
  }
}

function recordMismatches() {
  if (!mismatches.length) return;
  const file = path.join(CONTENT_DIR, "open-items.json");
  let data = {};
  if (fs.existsSync(file)) {
    try {
      data = readJson(file);
    } catch {
      fail(1, `${file} no es JSON válido; no se sobrescribe`);
    }
  }
  const list = Array.isArray(data[MISMATCH_KEY]) ? data[MISMATCH_KEY] : [];
  for (const m of mismatches) if (!list.includes(m)) list.push(m);
  data[MISMATCH_KEY] = list;
  fs.mkdirSync(CONTENT_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

if (missing.length) {
  recordMismatches();
  fail(1, `faltan archivos requeridos en ${ALBUM_SRC}:\n  ${missing.join("\n  ")}`);
}

// ---- Copy ----
let total = 0;
for (const def of selected) {
  const dir = path.join(CONTENT_DIR, "chapters", def.slug);
  if (fs.existsSync(dir)) {
    if (!args.force) {
      console.log(`seed: ${def.slug} ya existe, se omite (usa --force)`);
      continue;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const mediaDir = path.join(dir, "media");
  fs.mkdirSync(mediaDir, { recursive: true });
  for (const item of def.media) {
    if (!item.from) continue;
    const dest = path.join(mediaDir, itemOut(item).file);
    fs.copyFileSync(path.join(ALBUM_SRC, item.from), dest, fs.constants.COPYFILE_EXCL);
    total += fs.statSync(dest).size;
  }
  fs.writeFileSync(path.join(dir, "chapter.json"), JSON.stringify(chapterJson(def), null, 2) + "\n");
  console.log(`seed: ${def.slug} listo`);
}
recordMismatches();

const mb = total / (1024 * 1024);
console.log(`seed: tamaño total copiado ${mb.toFixed(1)} MB`);
if (total > WARN_BYTES) console.warn(`seed: ADVERTENCIA: el total supera 400 MB (${mb.toFixed(1)} MB)`);
