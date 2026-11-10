// Class A static checks on dist/ (design 14.2). Template and structure checks only:
// nothing here depends on the seeded content, so Angel's own chapters can never be blocked.
// Class B (seed) assertions live in verify-browser / e2e behind STRICT_SEED=1.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import sharp from "sharp";
import { ROOT, CONTENT_DIR, DIST_DIR, ALBUM_SRC, BUILD_DIR } from "./paths.mjs";
import { run } from "./exec.mjs";
import { walk, scanPaths, scanTextFiles, scanHashes } from "./setlog-guard.mjs";
import { parseHeaders, matchHeaders, cspRuleCount } from "./headers.mjs";
import { checkAdminShip } from "./admin-ship.mjs";
import { loadChapters } from "./chapters-loader.mjs";

export const EXIT_BUDGET = 5;
export const ALBUM_SRC_SKIPPED = "ALBUM_SRC no disponible, comparación omitida";

const ALLOWED_HOSTS = new Set(["api.github.com", "github.com", "www.w3.org"]);
const FORBIDDEN_EXT = new Set([".mov", ".jpeg", ".heic", ".pdf"]);
const TEXT_EXT = new Set([".html", ".css", ".js", ".mjs", ".json", ".webmanifest", ".txt"]);
const PLACEHOLDER_RE = /TODO|PLACEHOLDER|undefined|null|\[object|\{\{/;
const WEBP_BUDGET = 250 * 1024;
const MAXWIDTH_BUDGET = 120 * 1024;
const MAX_VIDEO_BYTES = 15 * 1024 * 1024;

// ---------------------------------------------------------------- HTML parsing

const VOID = new Set(["meta", "link", "img", "source", "br", "hr", "input", "area", "base", "col", "embed", "wbr", "track"]);
const RAW = new Set(["script", "style"]);

export function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function parseAttrs(src) {
  const attrs = {};
  const re = /([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let m;
  while ((m = re.exec(src))) {
    attrs[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return attrs;
}

/** Small tolerant HTML parser: { tag, attrs, children, parent } and { text } nodes. */
export function parseHtml(html) {
  const root = { tag: "#root", attrs: {}, children: [], parent: null };
  let cur = root;
  const re = /<!--[\s\S]*?-->|<!doctype[^>]*>|<(\/?)([a-zA-Z][^\s/>]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/gi;
  let last = 0;
  let m;
  const text = (t) => {
    if (t) cur.children.push({ text: t, parent: cur });
  };
  while ((m = re.exec(html))) {
    text(html.slice(last, m.index));
    last = re.lastIndex;
    if (!m[2]) continue; // comment or doctype
    const tag = m[2].toLowerCase();
    if (m[1]) {
      let n = cur;
      while (n && n.tag !== tag) n = n.parent;
      if (n && n.parent) cur = n.parent;
      continue;
    }
    const node = { tag, attrs: parseAttrs(m[3].replace(/\/\s*$/, "")), children: [], parent: cur };
    cur.children.push(node);
    if (VOID.has(tag) || /\/\s*$/.test(m[3])) continue;
    if (RAW.has(tag)) {
      const close = new RegExp(`</${tag}\\s*>`, "i");
      const rest = html.slice(last);
      const c = close.exec(rest);
      const end = c ? c.index : rest.length;
      node.children.push({ text: rest.slice(0, end), parent: node });
      last += end + (c ? c[0].length : 0);
      re.lastIndex = last;
      continue;
    }
    cur = node;
  }
  text(html.slice(last));
  return root;
}

export function* elements(node) {
  for (const c of node.children ?? []) {
    if (c.tag) {
      yield c;
      yield* elements(c);
    }
  }
}

export function textOf(node) {
  if (node.text !== undefined) return decodeEntities(node.text);
  return (node.children ?? []).map(textOf).join("");
}

const classes = (el) => (el.attrs.class ?? "").split(/\s+/).filter(Boolean);
const find = (root, pred) => [...elements(root)].filter(pred);

// ---------------------------------------------------------------- placeholders

const AUTHOR_CLASSES = new Set(["date", "place", "note"]);
const AUTHOR_TAGS = new Set(["title", "h1", "figcaption", "blockquote"]);
const AUTHOR_ATTRS = new Set(["alt", "aria-label"]);

/**
 * Placeholder tokens (case-sensitive) in template-generated text only. Nodes that carry
 * author text (title, h1, date, place, note, captions, quotes, alt) are removed first.
 * @returns {string[]} the offending fragments
 */
export function findPlaceholders(html) {
  const out = [];
  const visit = (node) => {
    for (const c of node.children ?? []) {
      if (c.text !== undefined) {
        if (PLACEHOLDER_RE.test(decodeEntities(c.text))) out.push(decodeEntities(c.text).trim().slice(0, 80));
        continue;
      }
      if (AUTHOR_TAGS.has(c.tag) || classes(c).some((k) => AUTHOR_CLASSES.has(k))) continue;
      for (const [k, v] of Object.entries(c.attrs)) {
        if (!AUTHOR_ATTRS.has(k) && PLACEHOLDER_RE.test(v)) out.push(`${c.tag}[${k}=${v.slice(0, 60)}]`);
      }
      visit(c);
    }
  };
  visit(parseHtml(html));
  return out;
}

// ---------------------------------------------------------------- references

function splitSrcset(v) {
  return String(v)
    .split(",")
    .map((p) => p.trim().split(/\s+/)[0])
    .filter(Boolean);
}

/** All local-ish references in an HTML document. */
export function htmlRefs(root) {
  const refs = [];
  for (const el of elements(root)) {
    for (const a of ["src", "poster", "href"]) if (el.attrs[a] !== undefined) refs.push(el.attrs[a]);
    if (el.attrs.srcset !== undefined) refs.push(...splitSrcset(el.attrs.srcset));
  }
  return refs;
}

export function cssRefs(css) {
  const refs = [];
  const re = /url\(\s*(['"]?)(.*?)\1\s*\)/g;
  let m;
  while ((m = re.exec(css))) refs.push(m[2]);
  return refs;
}

/** Resolve a reference to an absolute path inside distDir. Returns null for non-local refs. */
export function resolveRef(ref, fromFile, distDir) {
  const r = String(ref).trim();
  if (!r || r.startsWith("#") || /^(data|mailto|tel|javascript|blob):/i.test(r)) return null;
  if (/^(https?:)?\/\//i.test(r)) return null; // external: hostname check
  const clean = r.split("#")[0].split("?")[0];
  if (clean === "") return null;
  let dec;
  try {
    dec = decodeURIComponent(clean);
  } catch {
    dec = clean;
  }
  const abs = dec.startsWith("/") ? path.join(distDir, dec) : path.resolve(path.dirname(fromFile), dec);
  return abs;
}

function refExists(abs, distDir) {
  const rel = path.relative(distDir, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return false;
  try {
    const st = fs.statSync(abs);
    if (st.isFile()) return true;
    return st.isDirectory() && fs.existsSync(path.join(abs, "index.html"));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- helpers

const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

function sizeIndex(dir) {
  const map = new Map();
  for (const rel of walk(dir)) {
    if (rel.endsWith("/")) continue;
    const abs = path.join(dir, rel);
    let size;
    try {
      size = fs.statSync(abs).size;
    } catch {
      continue;
    }
    if (size === 0) continue;
    if (!map.has(size)) map.set(size, []);
    map.get(size).push(abs);
  }
  return map;
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

const exists = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

function collectManifestUrls(entry) {
  const urls = [];
  const add = (variants) => variants?.forEach((v) => urls.push(v.url));
  add(entry.variants);
  if (entry.url) urls.push(entry.url);
  if (entry.poster) add(entry.poster.variants);
  for (const p of entry.pages ?? []) add(p.variants);
  return urls;
}

// ---------------------------------------------------------------- main

/**
 * @param {object} [o]
 * @param {string} [o.distDir]
 * @param {string} [o.contentDir]
 * @param {string|null} [o.albumSrc]
 * @param {string} [o.buildDir]
 * @param {(file:string)=>string} [o.mimeFor]   served Content-Type for the admin-ship check
 * @param {boolean} [o.strictBudget]
 * @param {boolean} [o.titleRerun]               second Eleventy run with ALBUM_TITLE_OVERRIDE
 * @param {(msg:string)=>void} [o.log]
 * @returns {Promise<{errors:string[], budgetErrors:string[], warnings:string[]}>}
 */
export async function verifyDist({
  distDir = DIST_DIR,
  contentDir = CONTENT_DIR,
  albumSrc = ALBUM_SRC,
  buildDir = BUILD_DIR,
  mimeFor,
  strictBudget = process.env.STRICT_BUDGET === "1",
  titleRerun = process.env.SKIP_TITLE_RERUN !== "1",
  log = console.log,
} = {}) {
  const errors = [];
  const budgetErrors = [];
  const warnings = [];
  const err = (check, msg) => errors.push(`[${check}] ${msg}`);

  if (!exists(distDir)) {
    err("dist", `no existe ${distDir}; ejecuta eleventy primero`);
    return { errors, budgetErrors, warnings };
  }

  const files = walk(distDir).filter((f) => !f.endsWith("/"));
  const abs = (rel) => path.join(distDir, rel);
  const htmlFiles = files.filter((f) => f.endsWith(".html"));
  const pages = new Map(); // rel -> parsed tree
  for (const rel of htmlFiles) pages.set(rel, parseHtml(fs.readFileSync(abs(rel), "utf8")));

  // 1. Every reference resolves.
  const checkRef = (ref, from, label) => {
    const target = resolveRef(ref, from, distDir);
    if (target && !refExists(target, distDir)) err("refs", `${label}: "${ref}" no existe en dist`);
  };
  for (const [rel, tree] of pages) for (const ref of htmlRefs(tree)) checkRef(ref, abs(rel), rel);
  for (const rel of files.filter((f) => f.endsWith(".css"))) {
    for (const ref of cssRefs(fs.readFileSync(abs(rel), "utf8"))) checkRef(ref, abs(rel), rel);
  }
  const bm = readJson(abs("build-manifest.json"));
  if (!bm) err("refs", "build-manifest.json falta o no es JSON válido");
  else for (const u of [...(bm.media ?? []), ...(bm.pages ?? [])]) checkRef(u, abs("build-manifest.json"), "build-manifest.json");
  const webmanifest = readJson(abs("manifest.webmanifest"));
  for (const icon of webmanifest?.icons ?? []) checkRef(icon.src, abs("manifest.webmanifest"), "manifest.webmanifest");

  // 2. Expected media present for every item in content/ (derived from data).
  const chapters = loadChapters(contentDir);
  const mediaManifest = readJson(path.join(buildDir, "media-manifest.json"), {});
  const budgetOf = new Map(); // url -> budget for 800 px WebP
  for (const ch of chapters) {
    for (const item of ch.media ?? []) {
      if (item.type === "quote") continue;
      const label = `${ch.slug}/${item.file}`;
      const entry = mediaManifest[label];
      if (!entry) {
        err("media", `${label}: sin entrada en media-manifest.json`);
        continue;
      }
      for (const u of collectManifestUrls(entry)) {
        if (!fs.existsSync(abs(u.replace(/^\//, "")))) err("media", `${label}: falta ${u} en dist`);
      }
      if (item.type === "photo" && item.frame !== "letter") {
        const w800 = entry.variants?.find((v) => v.format === "webp" && v.width === 800);
        if (w800) budgetOf.set(w800.url, item.maxWidth ? MAXWIDTH_BUDGET : WEBP_BUDGET);
      }
    }
  }

  // 3. No originals in dist; no byte-identical copies of content/ or ALBUM_SRC.
  for (const rel of files) {
    if (FORBIDDEN_EXT.has(path.extname(rel).toLowerCase())) err("originals", `${rel}: extensión de original no permitida en dist`);
  }
  for (const rel of files) {
    if (/^(open_items\.md|open-items\.json)$/i.test(path.basename(rel))) err("open-items", `${rel}: no debe publicarse`);
  }
  const compare = (label, dir) => {
    const idx = sizeIndex(dir);
    const hashes = new Map();
    const hashOf = (f) => hashes.get(f) ?? (hashes.set(f, sha256(f)), hashes.get(f));
    for (const rel of files) {
      const size = fs.statSync(abs(rel)).size;
      const cands = idx.get(size);
      if (!cands) continue;
      const h = sha256(abs(rel));
      const hit = cands.find((c) => hashOf(c) === h);
      if (hit) err("originals", `${rel}: idéntico a ${label} (${path.relative(dir, hit)})`);
    }
  };
  if (exists(contentDir)) compare("content/", contentDir);
  if (albumSrc && exists(albumSrc)) compare("ALBUM_SRC", albumSrc);
  else log(ALBUM_SRC_SKIPPED);

  // Budget: 800 px WebP.
  for (const [url, budget] of budgetOf) {
    const f = abs(url.replace(/^\//, ""));
    if (!fs.existsSync(f)) continue;
    const size = fs.statSync(f).size;
    if (size > budget) {
      const msg = `${url}: ${Math.round(size / 1024)} KB supera el presupuesto de ${Math.round(budget / 1024)} KB (800 px WebP)`;
      if (strictBudget) budgetErrors.push(`[budget] ${msg}`);
      else warnings.push(`[budget] ${msg}`);
    }
  }

  // No exif on images.
  for (const rel of files.filter((f) => /\.(jpe?g|webp|png)$/i.test(f))) {
    try {
      const meta = await sharp(abs(rel)).metadata();
      if (meta.exif) err("exif", `${rel}: contiene EXIF`);
    } catch (e) {
      err("exif", `${rel}: no se pudo leer (${e.message})`);
    }
  }

  // Videos: H.264 mp4, at most 15 MB; location tags on a sample.
  const videos = files.filter((f) => f.endsWith(".mp4")).sort();
  for (const rel of videos) {
    if (fs.statSync(abs(rel)).size > MAX_VIDEO_BYTES) err("video", `${rel}: pesa más de 15 MB`);
  }
  let ffprobeOk = true;
  for (const [i, rel] of videos.entries()) {
    if (!ffprobeOk) break;
    let res;
    try {
      res = await run("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", abs(rel)]);
    } catch {
      ffprobeOk = false;
      warnings.push("[video] ffprobe no disponible: códec y etiquetas de ubicación no revisados");
      break;
    }
    let info;
    try {
      info = JSON.parse(res.stdout);
    } catch {
      err("video", `${rel}: ffprobe no pudo leerlo`);
      continue;
    }
    const v = (info.streams ?? []).find((s) => s.codec_type === "video");
    if (!v || v.codec_name !== "h264") err("video", `${rel}: no es H.264 (${v?.codec_name ?? "sin video"})`);
    if (i < 3) {
      const tagSets = [info.format?.tags, ...(info.streams ?? []).map((s) => s.tags)].filter(Boolean);
      for (const tags of tagSets) {
        for (const k of Object.keys(tags)) {
          if (/^location/i.test(k) || /^com\.apple\.quicktime\./i.test(k)) err("video", `${rel}: etiqueta de ubicación "${k}"`);
        }
      }
    }
  }

  // 4. noindex, robots, sitemap, headers, hosts, scripts.
  for (const [rel, tree] of pages) {
    const robots = find(tree, (e) => e.tag === "meta" && (e.attrs.name ?? "").toLowerCase() === "robots");
    if (!robots.some((m) => /noindex/i.test(m.attrs.content ?? ""))) err("noindex", `${rel}: falta meta robots noindex`);
    const html = find(tree, (e) => e.tag === "html")[0];
    if (!html || html.attrs.lang !== "es") err("lang", `${rel}: <html lang="es"> ausente`);
    for (const s of find(tree, (e) => e.tag === "script" && e.attrs.src !== undefined)) {
      if (!/^\/(assets|admin)\//.test(s.attrs.src)) err("scripts", `${rel}: <script src="${s.attrs.src}"> fuera de /assets/ y /admin/`);
    }
    for (const img of find(tree, (e) => e.tag === "img")) {
      if (!(img.attrs.alt ?? "").trim()) err("alt", `${rel}: <img src="${img.attrs.src ?? ""}"> sin alt`);
    }
    for (const fc of find(tree, (e) => e.tag === "figcaption")) {
      if (!textOf(fc).trim() && !find(fc, () => true).length) err("figcaption", `${rel}: <figcaption> vacío`);
    }
  }
  const robotsTxt = fs.existsSync(abs("robots.txt")) ? fs.readFileSync(abs("robots.txt"), "utf8") : null;
  if (robotsTxt === null || !/^\s*Disallow:\s*\/\s*$/m.test(robotsTxt)) err("robots", "robots.txt debe contener Disallow: /");
  if (fs.existsSync(abs("sitemap.xml"))) err("robots", "sitemap.xml no debe existir");

  if (!fs.existsSync(abs("_headers"))) err("headers", "_headers falta");
  else {
    const rules = parseHeaders(fs.readFileSync(abs("_headers"), "utf8"));
    if (!matchHeaders(rules, "/capitulo/x/").has("x-robots-tag")) err("headers", "falta X-Robots-Tag");
    const publicPaths = ["/", "/indice/", "/capitulo/ejemplo/", "/404.html", "/assets/book.js"];
    const adminPaths = ["/admin/", "/admin/main.js"];
    for (const p of [...publicPaths, ...adminPaths, "/m/x.jpg", "/build.json", "/sw.js", "/robots.txt", "/manifest.webmanifest"]) {
      const n = cspRuleCount(rules, p);
      const isPublic = publicPaths.includes(p);
      const isAdmin = adminPaths.includes(p);
      if (n > 1) err("headers", `${p}: ${n} reglas CSP (máximo 1)`);
      if ((isPublic || isAdmin) && n !== 1) err("headers", `${p}: falta Content-Security-Policy`);
      const csp = matchHeaders(rules, p).get("content-security-policy")?.value ?? "";
      if (isPublic && csp.includes("api.github.com")) err("headers", `${p}: la CSP pública no debe incluir api.github.com`);
      if (isAdmin && !csp.includes("https://api.github.com")) err("headers", `${p}: la CSP del admin debe incluir https://api.github.com`);
    }
  }

  for (const rel of files.filter((f) => TEXT_EXT.has(path.extname(f).toLowerCase()))) {
    const text = fs.readFileSync(abs(rel), "utf8");
    for (const m of text.matchAll(/https?:\/\/([a-zA-Z0-9.-]+)/g)) {
      if (!ALLOWED_HOSTS.has(m[1].toLowerCase())) err("hosts", `${rel}: host externo "${m[1]}"`);
    }
  }

  // 5. Placeholders and navigation on chapter pages.
  for (const rel of htmlFiles.filter((f) => f.startsWith("capitulo/"))) {
    const html = fs.readFileSync(abs(rel), "utf8");
    for (const hit of findPlaceholders(html)) err("placeholder", `${rel}: "${hit}"`);
    const tree = pages.get(rel);
    for (const [cls, label] of [["prev", "Anterior"], ["toc", "Índice"], ["next", "Siguiente"]]) {
      const links = find(tree, (e) => e.tag === "a" && classes(e).includes(cls) && classes(e.parent).includes("pager"));
      if (links.length !== 1 || textOf(links[0]).trim() !== label) err("nav", `${rel}: la etiqueta de navegación "${cls}" debe ser exactamente "${label}"`);
    }
  }

  // 6. Setlog.
  for (const h of scanPaths(distDir)) err("setlog", `nombre en dist: ${h.where}`);
  for (const h of scanTextFiles(distDir)) err("setlog", `texto en dist: ${h.where}`);
  const denied = readJson(path.join(ROOT, "guard", "denied-hashes.json"), []);
  for (const h of scanHashes(files.map(abs), denied)) err("setlog", `archivo excluido en dist (${h.label}): ${path.relative(distDir, h.where)}`);

  // 7. Title propagation.
  const site = readJson(path.join(contentDir, "site.json"), {});
  const titleOf = (dir) => {
    const tree = parseHtml(fs.readFileSync(path.join(dir, "index.html"), "utf8"));
    const t = find(tree, (e) => e.tag === "title")[0];
    const h = find(tree, (e) => e.tag === "h1")[0];
    const man = readJson(path.join(dir, "manifest.webmanifest"), {});
    return { title: t ? textOf(t).trim() : null, h1: h ? textOf(h).trim() : null, name: man.name ?? null, short: man.short_name ?? null };
  };
  const checkTitle = (t, expected, label) => {
    if (!t.title?.endsWith(` · ${expected}`)) err("title", `${label}: <title> "${t.title}" no termina en " · ${expected}"`);
    if (t.h1 !== expected) err("title", `${label}: <h1> "${t.h1}" no es "${expected}"`);
    if (t.name !== expected || t.short !== expected) err("title", `${label}: manifest name/short_name no son "${expected}"`);
  };
  if (!fs.existsSync(abs("index.html"))) err("title", "index.html falta");
  else {
    checkTitle(titleOf(distDir), site.title, "portada");
    if (titleRerun) {
      const OVERRIDE = "Prueba";
      const tmp = fs.mkdtempSync(path.join(fs.existsSync(path.join(ROOT, "tmp")) ? path.join(ROOT, "tmp") : os.tmpdir(), "verify-title-"));
      try {
        const bin = path.join(ROOT, "node_modules", ".bin", "eleventy");
        const res = await run(bin, ["--output", tmp, "--quiet"], {
          cwd: ROOT,
          env: { ...process.env, NODE_ENV: "test", ALBUM_TITLE_OVERRIDE: OVERRIDE },
        });
        if (res.code !== 0) err("title", `segunda ejecución con ALBUM_TITLE_OVERRIDE falló: ${res.stderr.trim().split("\n").slice(-3).join(" | ")}`);
        else {
          const t2 = titleOf(tmp);
          checkTitle(t2, OVERRIDE, "portada (override)");
          if (OVERRIDE === site.title) err("title", "el título de prueba coincide con el real");
        }
      } catch (e) {
        err("title", `segunda ejecución con ALBUM_TITLE_OVERRIDE no pudo iniciar: ${e.message}`);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    } else {
      log("Reejecución con ALBUM_TITLE_OVERRIDE omitida (SKIP_TITLE_RERUN=1)");
    }
  }

  // Admin shared files (Fix 5): shipped, JS MIME, no import in validate-core.
  for (const p of checkAdminShip({ distDir, mimeFor })) err("admin-ship", p);

  return { errors, budgetErrors, warnings };
}
