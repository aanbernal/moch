#!/usr/bin/env node
// End-to-end check of the admin against the local GitHub mock (design 14.4, Req 13.1-13.8,
// 13.10, 23.7, 23.8). Run with `npm run e2e` (sets STRICT_SEED=1).
//
// What it does (numbers follow design 14.4):
//  1. Builds a baseline of the content into tmp/e2e/dist-baseline and records baseline.json
//     (SHA-256 per file; build.json excluded; sw.js compared by its buildId).
//  2. Copies content/ to tmp/e2e/content, seeds scripts/mock-github.mjs from it and serves the
//     baseline with scripts/serve.mjs --strict-headers plus the mock origin as extra connect-src.
//  3. Drives Chrome at 390 px through setup, reload, unlock, wrong token and wrong password.
//  4. Creates "Capítulo de prueba" (EXIF-GPS JPEG 3000x2000, transparent PNG, short MP4), publishes.
//  5. Rebuilds into tmp/e2e/dist-1 and checks the TOC, numbering, caption and media in the browser.
//  6. Deletes the chapter, publishes, rebuilds: the dist listing equals the baseline and the
//     mock content equals the original (diff -r).
//  7. Negative cases, 8. edit round trip, service worker / build.json polling, failed run.
//
// The real dist/ is never touched. Builds run the same chain as `npm run build` (guard pre, media,
// eleventy, guard post) with CONTENT_DIR and an Eleventy --output override. Afterwards build/ is
// restored for the real content. Nothing is pushed, deployed or sent anywhere but 127.0.0.1.
// Evidence goes to verification/e2e/. Exit code 1 when any check fails.

import fs from "node:fs/promises";
import crypto from "node:crypto";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { chromium } from "playwright-core";
import { startServer } from "./serve.mjs";
import { startMockGithub, DEFAULT_TOKEN } from "./mock-github.mjs";

process.env.STRICT_SEED ??= "1";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(ROOT); // the mock only exports inside the working directory or the OS tmp dir
const E2E = path.join(ROOT, "tmp", "e2e");
const OUT = path.join(ROOT, "verification", "e2e");
const FIXTURES = path.join(ROOT, "test", "fixtures");
const REAL_CONTENT = path.join(ROOT, "content");
const ELEVENTY = path.join(ROOT, "node_modules", "@11ty", "eleventy", "cmd.cjs");

const PASSWORD = "clave-segura-1";
const TEST_TITLE = "Capítulo de prueba";
const TEST_CAPTION = "Foto de prueba con GPS";
const TEST_NOTE = "Nota de prueba del capítulo.";
const E2E_REPO = { owner: "e2e-owner", name: "e2e-album", branch: "main" };
const ZERO_SHA = "0".repeat(40);
const CONTEXT_OPTS = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  locale: "es-MX",
};

// ------------------------------------------------------------------ reporting
const results = [];
const notes = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: !!ok, detail: String(detail ?? "") });
  console.log(`${ok ? "OK   " : "FALLA"} ${name}${detail && !ok ? ` -> ${detail}` : ""}`);
  return !!ok;
}
const note = (text) => { notes.push(text); console.log(`NOTA  ${text}`); };
let stepLabel = "";
const step = (label) => { stepLabel = label; console.log(`\n== ${label}`); };

// ------------------------------------------------------------------ small helpers
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exists = (p) => fs.access(p).then(() => true, () => false);
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function run(cmd, args, { env = {}, cwd = ROOT } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    child.on("error", (e) => resolve({ code: -1, out: `${out}${e.message}` }));
    child.on("close", (code) => resolve({ code, out }));
  });
}

/** guard pre, media, eleventy, guard post: the `npm run build` chain with overridden dirs. */
async function build(contentDir, outDir, label) {
  await fs.rm(outDir, { recursive: true, force: true });
  const env = { CONTENT_DIR: contentDir, DIST_DIR: outDir };
  const stages = [
    ["guard pre", [path.join(ROOT, "scripts", "guard.mjs"), "pre"]],
    ["media", [path.join(ROOT, "scripts", "media.mjs")]],
    ["eleventy", [ELEVENTY, "--quiet"]],
    ["guard post", [path.join(ROOT, "scripts", "guard.mjs"), "post"]],
  ];
  let log = "";
  for (const [name, args] of stages) {
    const r = await run(process.execPath, args, { env });
    log += `--- ${name} (exit ${r.code})\n${r.out}\n`;
    if (r.code !== 0) {
      await fs.writeFile(path.join(OUT, `build-${label}.log`), log);
      throw new Error(`Falló la etapa "${name}" del build (${label}): ${r.out.trim().split("\n").slice(-6).join(" | ")}`);
    }
  }
  await fs.writeFile(path.join(OUT, `build-${label}.log`), log);
}

async function walkFiles(dir, rel = "") {
  const out = [];
  for (const e of await fs.readdir(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await walkFiles(dir, r)));
    else if (e.isFile()) out.push(r);
  }
  return out.sort();
}

/** Map of relative path -> sha256 for any directory. */
async function listTree(dir) {
  const map = new Map();
  for (const rel of await walkFiles(dir)) map.set(rel, sha256(await fs.readFile(path.join(dir, rel))));
  return map;
}

/** dist listing for the baseline comparison: build.json excluded, sw.js reduced to its buildId. */
async function distListing(dir) {
  const out = {};
  for (const [rel, hash] of await listTree(dir)) {
    if (rel === "build.json") continue;
    if (rel === "sw.js") {
      const text = await fs.readFile(path.join(dir, rel), "utf8");
      out[rel] = `buildId:${/BUILD_ID\s*=\s*"([^"]+)"/.exec(text)?.[1] ?? "?"}`;
    } else {
      out[rel] = hash;
    }
  }
  return out;
}

function diffMaps(a, b) {
  const diffs = [];
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (a[k] === undefined) diffs.push(`solo en el segundo: ${k}`);
    else if (b[k] === undefined) diffs.push(`solo en el primero: ${k}`);
    else if (a[k] !== b[k]) diffs.push(`distinto: ${k}`);
  }
  return diffs;
}

function diffTrees(a, b) {
  return diffMaps(Object.fromEntries(a), Object.fromEntries(b));
}

const writeJson = async (file, data) => fs.writeFile(file, `${JSON.stringify(data, null, 2)}\n`);
const readJson = async (file) => JSON.parse(await fs.readFile(file, "utf8"));

// ------------------------------------------------------------------ fixtures
/** Minimal valid PDF with `n` blank pages (same construction as test/pdf.test.mjs). */
function makePdf(n) {
  const objs = [];
  const kids = Array.from({ length: n }, (_, i) => `${3 + i} 0 R`).join(" ");
  objs.push("<< /Type /Catalog /Pages 2 0 R >>");
  objs.push(`<< /Type /Pages /Kids [${kids}] /Count ${n} >>`);
  for (let i = 0; i < n; i++) objs.push("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] >>");
  let out = "%PDF-1.4\n";
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out);
}

async function makeGpsJpeg(file) {
  const svg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="3000" height="2000">' +
      '<rect x="200" y="200" width="1200" height="800" fill="#2d6a8f"/>' +
      '<circle cx="2100" cy="1200" r="500" fill="#e8c547"/>' +
      '<rect x="900" y="1400" width="1400" height="300" fill="#a23b3b"/></svg>',
  );
  const base = sharp({ create: { width: 3000, height: 2000, channels: 3, background: { r: 214, g: 190, b: 160 } } })
    .composite([{ input: svg, top: 0, left: 0 }]);
  let withGps = true;
  try {
    await base.clone().withExif({
      IFD0: { Make: "E2E", Model: "Fixture" },
      IFD3: { GPSLatitudeRef: "N", GPSLatitude: "19/1 25/1 0/1", GPSLongitudeRef: "W", GPSLongitude: "99/1 8/1 0/1" },
    }).jpeg({ quality: 82 }).toFile(file);
  } catch {
    withGps = false;
    await base.clone().withExif({ IFD0: { Make: "E2E", Model: "Fixture" } }).jpeg({ quality: 82 }).toFile(file);
  }
  const meta = await sharp(file).metadata();
  const buf = await fs.readFile(file);
  return {
    width: meta.width,
    height: meta.height,
    hasExif: !!meta.exif && meta.exif.length > 0 && buf.includes(Buffer.from("Exif\0\0", "latin1")),
    gpsRequested: withGps,
  };
}

async function makeTransparentPng(file) {
  const square = await sharp({ create: { width: 40, height: 40, channels: 4, background: { r: 200, g: 30, b: 30, alpha: 1 } } }).png().toBuffer();
  await sharp({ create: { width: 240, height: 160, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: square, top: 60, left: 100 }])
    .png()
    .toFile(file);
}

async function makeVideo(file, { seconds, size = "320x240", rate = 15, source = "testsrc" }) {
  const input = source === "testsrc" ? `testsrc=size=${size}:rate=${rate}` : `color=c=black:size=${size}:rate=${rate}`;
  const r = await run("ffmpeg", [
    "-y", "-loglevel", "error", "-f", "lavfi", "-i", input, "-t", String(seconds),
    "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", file,
  ]);
  if (r.code !== 0) throw new Error(`ffmpeg no pudo crear ${path.basename(file)}: ${r.out.trim()}`);
}

const smallJpegBuffer = () => sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 90, g: 140, b: 200 } } }).jpeg().toBuffer();

/** Adds a teaser and a chapter with place/size/frame/pages/draft when the seed lacks them. */
async function ensureFixtureChapters(contentDir) {
  const chaptersDir = path.join(contentDir, "chapters");
  const all = [];
  for (const e of await fs.readdir(chaptersDir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const file = path.join(chaptersDir, e.name, "chapter.json");
    if (await exists(file)) all.push({ slug: e.name, json: await readJson(file), file });
  }
  const added = [];
  if (!all.some((c) => c.json.kind === "teaser")) {
    const dir = path.join(chaptersDir, "continuara");
    await fs.mkdir(dir, { recursive: true });
    const json = { schema: 1, order: 900, kind: "teaser", title: "Continuará…", draft: true, media: [] };
    await fs.writeFile(path.join(dir, "chapter.json"), `${JSON.stringify(json, null, 2)}\n`);
    added.push("continuara (teaser)");
  }
  const features = (j) => !!j.place && j.draft === true && Array.isArray(j.media) &&
    j.media.some((m) => m.size === "small") && j.media.some((m) => m.frame === "letter") &&
    j.media.some((m) => m.type === "pdf" && Array.isArray(m.pages));
  let roundTrip = all.find((c) => features(c.json));
  if (!roundTrip) {
    const slug = "capitulo-de-ronda";
    const dir = path.join(chaptersDir, slug);
    await fs.mkdir(path.join(dir, "media"), { recursive: true });
    await sharp({ create: { width: 600, height: 400, channels: 3, background: { r: 120, g: 160, b: 130 } } })
      .jpeg().toFile(path.join(dir, "media", "carta-prueba.jpg"));
    await fs.writeFile(path.join(dir, "media", "hojas-prueba.pdf"), makePdf(2));
    const json = {
      schema: 1, order: 20, kind: "chapter", title: "Capítulo de ronda", dateText: "Fecha de ronda",
      place: "Lugar de ronda", note: "Nota original de ronda.", draft: true, cover: "carta-prueba.jpg",
      media: [
        { type: "photo", file: "carta-prueba.jpg", alt: "Hoja de prueba", size: "small", frame: "letter" },
        { type: "pdf", file: "hojas-prueba.pdf", pages: [1, 2], frame: "letter", alt: "Hoja {n} de prueba" },
      ],
    };
    await fs.writeFile(path.join(dir, "chapter.json"), `${JSON.stringify(json, null, 2)}\n`);
    roundTrip = { slug, json };
    added.push(`${slug} (place, size, frame, pdf.pages, draft)`);
  }
  return { roundTripSlug: roundTrip.slug, added };
}

// ------------------------------------------------------------------ browser helpers
async function launch() {
  try {
    return await chromium.launch({ channel: "chrome", headless: true });
  } catch (e) {
    if (process.env.CHROME_PATH) return chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
    throw new Error(`No se pudo iniciar Chrome (channel "chrome"): ${e.message}. Define CHROME_PATH si está en otra ruta.`);
  }
}

async function waitFor(fn, what, timeout = 20000) {
  const start = Date.now();
  let last;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) { last = e; }
    if (Date.now() - start > timeout) throw new Error(`Tiempo agotado esperando: ${what}${last ? ` (${last.message})` : ""}`);
    await sleep(100);
  }
}

const textOf = (page, selector) => page.locator(selector).first().textContent().then((t) => t ?? "", () => "");

async function waitText(page, selector, re, what, timeout = 20000) {
  return waitFor(async () => (re.test(await textOf(page, selector)) ? await textOf(page, selector) : false), what ?? `${selector} ~ ${re}`, timeout);
}

async function shot(page, name) {
  try { await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true, scale: "css" }); } catch { /* evidence only */ }
}

// ------------------------------------------------------------------ main
const cleanup = [];
let browser = null;

async function main() {
  await fs.rm(E2E, { recursive: true, force: true });
  await fs.rm(OUT, { recursive: true, force: true });
  await fs.mkdir(E2E, { recursive: true });
  await fs.mkdir(OUT, { recursive: true });
  await fs.mkdir(FIXTURES, { recursive: true });

  // ---- Step 1/2: content copy, fixtures, baseline ---------------------------------------
  step("1-2. Copia de content/, fixtures y baseline");
  const original = path.join(E2E, "content"); // untouched reference for diff -r
  const seedRepo = path.join(E2E, "repo"); // mock seed root: <seedRepo>/content/...
  await fs.cp(REAL_CONTENT, original, { recursive: true });
  const siteFile = path.join(original, "site.json");
  const site = await readJson(siteFile);
  site.repo = { ...E2E_REPO };
  await writeJson(siteFile, site);
  const fx = await ensureFixtureChapters(original);
  if (fx.added.length) note(`El contenido sembrado no tenía todos los casos; se añadieron solo a la copia de prueba: ${fx.added.join("; ")}.`);
  await fs.cp(original, path.join(seedRepo, "content"), { recursive: true });

  const gpsJpeg = path.join(FIXTURES, "e2e.jpg");
  const jpegInfo = await makeGpsJpeg(gpsJpeg);
  check("Fixture test/fixtures/e2e.jpg es de 3000x2000 con EXIF", jpegInfo.width === 3000 && jpegInfo.height === 2000 && jpegInfo.hasExif,
    JSON.stringify(jpegInfo));
  if (!jpegInfo.gpsRequested) note("sharp no aceptó el bloque GPS; el fixture lleva EXIF (IFD0) sin etiquetas GPS.");
  const filesDir = path.join(E2E, "files");
  await fs.mkdir(filesDir, { recursive: true });
  const pngFile = path.join(filesDir, "transparente.png");
  const clipFile = path.join(filesDir, "clip-prueba.mp4");
  const longClip = path.join(filesDir, "tres-minutos.mp4");
  await makeTransparentPng(pngFile);
  await makeVideo(clipFile, { seconds: 2 });
  await makeVideo(longClip, { seconds: 180, size: "64x64", rate: 1, source: "color" });

  const baseDist = path.join(E2E, "dist-baseline");
  await build(original, baseDist, "baseline");
  const baseline = await distListing(baseDist);
  await writeJson(path.join(OUT, "baseline.json"), baseline);
  check("Baseline construido y registrado (baseline.json)", Object.keys(baseline).length > 10, `${Object.keys(baseline).length} archivos`);

  // ---- Step 2: mock + serve --------------------------------------------------------------
  const servePort = await freePort();
  const mockPort = await freePort();
  const serveOrigin = `http://127.0.0.1:${servePort}`;
  const mock = await startMockGithub({ seed: seedRepo, port: mockPort, origin: serveOrigin, token: DEFAULT_TOKEN });
  cleanup.push(() => mock.close());
  const serve = await startServer({ dir: baseDist, port: servePort, strictHeaders: true, extraConnectSrc: mock.url });
  cleanup.push(() => serve.close());
  check("Mock y servidor (--strict-headers --extra-connect-src) en marcha", serve.url === serveOrigin && mock.url.includes(String(mockPort)));

  browser = await launch();
  const context = await browser.newContext(CONTEXT_OPTS);
  const cspViolations = [];
  const corsFailures = [];
  await context.exposeFunction("__e2eCsp", (v) => cspViolations.push(v));
  await context.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) => {
      window.__e2eCsp(`${e.violatedDirective} ${e.blockedURI}`);
    });
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => corsFailures.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    const t = m.text();
    if (/CORS|Access-Control|cross-origin/i.test(t)) corsFailures.push(`console: ${t}`);
    if (/Content Security Policy|Refused to/i.test(t)) cspViolations.push(`console: ${t}`);
  });
  page.on("requestfailed", (r) => {
    const err = r.failure()?.errorText ?? "";
    if (r.url().startsWith(mock.url) && !/ERR_ABORTED/.test(err)) corsFailures.push(`requestfailed: ${r.url()} ${err}`);
  });
  page.on("dialog", (d) => d.accept());
  page.setDefaultTimeout(15000);
  const adminUrl = `${serveOrigin}/admin/?api=${encodeURIComponent(mock.url)}&poll=200`;
  const mockCalls = () => mock.requests().filter((r) => !r.path.startsWith("/__mock/")).length;
  const mockAuthCalls = () => mock.requests().filter((r) => r.authenticated).length;

  // ---- Step 3: unauthenticated state, setup, unlock --------------------------------------
  step("3. Estado sin sesión, configuración, desbloqueo");
  await page.goto(adminUrl);
  await waitFor(() => page.evaluate(() => !document.getElementById("auth-submit").disabled), "formulario listo");
  check("Sin sesión: solo el formulario de configuración (app oculta y vacía)",
    (await page.locator("#app").isHidden()) && (await page.locator("#app").evaluate((n) => n.children.length === 0)) &&
      (await page.locator("#token-field").isVisible()) && /Primera vez/.test(await textOf(page, "#auth-intro")));
  check("Sin sesión: el mock no recibió ninguna petición autenticada", mockAuthCalls() === 0 && mockCalls() === 0,
    `${mockCalls()} peticiones`);
  await shot(page, "admin-01-setup");

  await page.fill("#token", "token-malo");
  await page.fill("#password", PASSWORD);
  await page.click("#auth-submit");
  const badToken = await waitText(page, "#auth-error", /token no es válido/i, "mensaje de token inválido");
  check("Token incorrecto muestra el mensaje 401", /El token no es válido o venció/.test(badToken), badToken);
  check("Token incorrecto no abre el administrador", await page.locator("#app").isHidden());

  await page.fill("#token", DEFAULT_TOKEN);
  await page.fill("#password", PASSWORD);
  await page.click("#auth-submit");
  await waitText(page, "#view h2", /Capítulos/, "lista de capítulos tras configurar");
  const sizeAfterSetup = await page.locator(".chapter-btn").count();
  check("Configuración con test-token abre la lista de capítulos", sizeAfterSetup >= 1, `${sizeAfterSetup} capítulos`);
  await shot(page, "admin-02-list");

  await page.reload();
  await waitFor(() => page.evaluate(() => !document.getElementById("auth-submit").disabled), "formulario tras recargar");
  check("Tras recargar pide solo la contraseña (token cifrado guardado)",
    /Escribe tu contraseña/.test(await textOf(page, "#auth-intro")) && (await page.locator("#token-field").isHidden()));
  await page.fill("#password", "contraseña-equivocada");
  await page.click("#auth-submit");
  const wrongPw = await waitText(page, "#auth-error", /incorrecta/i, "error de contraseña");
  check("Contraseña incorrecta muestra error", /Contraseña incorrecta/.test(wrongPw), wrongPw);
  await page.fill("#password", PASSWORD);
  await page.click("#auth-submit");
  await waitText(page, "#view h2", /Capítulos/, "lista tras desbloquear");
  check("Desbloqueo con la contraseña correcta abre la lista", true);
  check("Cero violaciones de CSP y cero fallos de CORS hasta aquí", cspViolations.length === 0 && corsFailures.length === 0,
    JSON.stringify({ cspViolations, corsFailures }));

  const listTitles = async () => page.locator(".chapter-btn span:first-child").allTextContents();
  const titlesBefore = await listTitles();

  // ---- Step 4: create the test chapter --------------------------------------------------
  step("4. Crear «Capítulo de prueba»");
  await page.getByRole("button", { name: "Nuevo capítulo" }).click();
  await waitText(page, "#view h2", /Nuevo capítulo/, "editor nuevo");
  await page.getByLabel("Título", { exact: true }).fill(TEST_TITLE);
  await page.getByLabel("Fecha (texto)").fill("1 de enero, 2027");
  await page.getByLabel("Nota", { exact: true }).fill(TEST_NOTE);
  const teaserValue = await page.getByLabel("Insertar antes de…").evaluate((sel) => {
    const o = [...sel.options].find((x) => x.value !== "" && /Continuará/.test(x.textContent));
    return o ? o.value : null;
  });
  check("El selector «Insertar antes de…» ofrece «Continuará»", !!teaserValue, String(teaserValue));
  await page.getByLabel("Insertar antes de…").selectOption(teaserValue);
  await page.locator('input[type="file"]').setInputFiles([gpsJpeg, pngFile, clipFile]);
  await waitFor(async () => (await page.locator(".item").count()) === 3, "tres elementos de medios", 30000);
  await waitFor(async () => (await page.locator(".status").first().textContent()) !== "Preparando los archivos…", "archivos preparados", 30000);
  await page.locator(".item").nth(0).getByLabel("Pie de foto").fill(TEST_CAPTION);
  await page.locator(".item").nth(0).getByLabel("Usar como portada").check();
  await shot(page, "admin-03-editor");
  const publishBtn = page.getByRole("button", { name: "Publicar" });
  await waitFor(async () => !(await publishBtn.isDisabled()), "botón Publicar habilitado");
  const commitsBefore = mock.commitCount();
  await publishBtn.click();
  await waitFor(async () => mock.commitCount() === commitsBefore + 1, "un commit en el mock", 30000);
  await waitText(page, "#view h2", /Capítulos/, "lista tras publicar", 30000);
  check("Publicar crea exactamente un commit", mock.commitCount() === commitsBefore + 1, `${mock.commitCount()} commits`);
  const liveText = await waitText(page, ".live", /Ya está publicado/, "aviso de publicación en vivo", 30000);
  check("El administrador muestra «Ya está publicado» con el build.json del mock", /Ya está publicado/.test(liveText), liveText);
  await shot(page, "admin-04-published");

  const export1 = path.join(E2E, "export-1");
  await mock.exportTo(export1);
  const treeOrig = await listTree(original);
  const tree1 = await listTree(path.join(export1, "content"));
  const added1 = [...tree1.keys()].filter((k) => !treeOrig.has(k));
  const changed1 = [...tree1.keys()].filter((k) => treeOrig.has(k) && treeOrig.get(k) !== tree1.get(k));
  const newFolder = [...new Set(added1.map((k) => /^chapters\/([^/]+)\//.exec(k)?.[1]).filter(Boolean))][0];
  check("El commit añade una carpeta de capítulo nueva y no modifica nada existente", !!newFolder && changed1.length === 0 &&
    [...treeOrig.keys()].every((k) => tree1.has(k)), `nueva=${newFolder} cambiados=${changed1.join(",")}`);
  const newJson = await readJson(path.join(export1, "content", "chapters", newFolder, "chapter.json"));
  const mediaFiles = added1.filter((k) => k.includes("/media/")).map((k) => path.posix.basename(k)).sort();
  check("El capítulo guarda las tres piezas (JPEG, PNG convertido a JPG, MP4)",
    JSON.stringify(mediaFiles) === JSON.stringify(["clip-prueba.mp4", "e2e.jpg", "transparente.jpg"]), mediaFiles.join(", "));
  check("chapter.json: título, fecha, nota, portada y pie de foto", newJson.title === TEST_TITLE && newJson.dateText === "1 de enero, 2027" &&
    newJson.note === TEST_NOTE && newJson.cover === "e2e.jpg" && newJson.media[0].caption === TEST_CAPTION && newJson.kind === "chapter",
  JSON.stringify(newJson));
  const teaserJson = (await Promise.all((await fs.readdir(path.join(export1, "content", "chapters"))).map(async (f) =>
    ({ f, j: await readJson(path.join(export1, "content", "chapters", f, "chapter.json")) })))).filter((x) => x.j.kind === "teaser")[0];
  const prevMax = Math.max(...(await Promise.all([...treeOrig.keys()].filter((k) => /^chapters\/[^/]+\/chapter\.json$/.test(k))
    .map(async (k) => (await readJson(path.join(original, k))).order))).filter((o) => o < teaserJson.j.order));
  check("«Insertar antes de: Continuará» deja el orden entre el último capítulo y el teaser",
    newJson.order > prevMax && newJson.order < teaserJson.j.order, `${prevMax} < ${newJson.order} < ${teaserJson.j.order}`);

  const storedJpeg = await fs.readFile(path.join(export1, "content", "chapters", newFolder, "media", "e2e.jpg"));
  const storedMeta = await sharp(storedJpeg).metadata();
  check("JPEG almacenado: sin EXIF ni GPS, redimensionado a 2400 px", !storedMeta.exif && !storedJpeg.includes(Buffer.from("Exif\0\0", "latin1")) &&
    Math.max(storedMeta.width, storedMeta.height) === 2400, JSON.stringify({ w: storedMeta.width, h: storedMeta.height, exif: !!storedMeta.exif }));
  const storedPng = await fs.readFile(path.join(export1, "content", "chapters", newFolder, "media", "transparente.jpg"));
  const px = await sharp(storedPng).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const corner = [px.data[0], px.data[1], px.data[2]];
  check("PNG transparente: el píxel de la esquina es blanco tras la preparación", corner.every((c) => c >= 250), corner.join(","));
  check("Sin violaciones de CSP ni fallos de CORS tras publicar", cspViolations.length === 0 && corsFailures.length === 0,
    JSON.stringify({ cspViolations, corsFailures }));

  // ---- Step 5: rebuild with the new chapter, check in the browser ------------------------
  step("5. Reconstruir con el capítulo nuevo y revisar el sitio");
  const dist1 = path.join(E2E, "dist-1");
  await build(path.join(export1, "content"), dist1, "con-capitulo");
  const serve1 = await startServer({ dir: dist1, strictHeaders: true });
  cleanup.push(() => serve1.close());
  const pubCtx = await browser.newContext(CONTEXT_OPTS);
  const pubProblems = [];
  const pub = await pubCtx.newPage();
  pub.on("response", (r) => { if (r.status() >= 400) pubProblems.push(`HTTP ${r.status()} ${r.url()}`); });
  pub.on("requestfailed", (r) => pubProblems.push(`requestfailed ${r.url()} ${r.failure()?.errorText ?? ""}`));
  pub.on("pageerror", (e) => pubProblems.push(`pageerror ${e.message}`));
  pub.on("console", (m) => { if (m.type() === "error") pubProblems.push(`console.error ${m.text()}`); });
  const readToc = async (origin) => {
    await pub.goto(`${origin}/indice/`, { waitUntil: "networkidle" });
    return pub.evaluate(() => [...document.querySelectorAll(".toc-item")].map((li) => ({
      href: li.querySelector("a").getAttribute("href"),
      cls: li.className,
      label: li.querySelector(".toc-label").textContent.trim(),
      title: li.querySelector(".toc-title").textContent.trim(),
      hasImg: !!li.querySelector("img"),
    })));
  };
  const tocBase = await readToc(serveOrigin);
  const toc1 = await readToc(serve1.url);
  const idx = toc1.findIndex((t) => t.href === `/capitulo/${newFolder}/`);
  const teaserIdx = toc1.findIndex((t) => t.cls.includes("toc-teaser"));
  check("Índice: el capítulo nuevo está justo antes de «Continuará»", idx >= 0 && teaserIdx === toc1.length - 1 && idx === teaserIdx - 1,
    `idx=${idx} teaser=${teaserIdx}`);
  const chaptersBefore = tocBase.filter((t) => t.cls.includes("toc-chapter")).length;
  check("Índice: el capítulo nuevo es el número siguiente al último existente",
    toc1[idx]?.label === `Capítulo ${chaptersBefore + 1}` && toc1[idx]?.title === TEST_TITLE, toc1[idx]?.label);
  const expectedLabels = tocBase.map((t) => t.label);
  const labels1 = toc1.filter((t) => t.href !== `/capitulo/${newFolder}/`).map((t) => t.label);
  let renumberOk = labels1.length === expectedLabels.length;
  // Followers of the insertion point shift by one; here the only follower is the teaser (unaffected).
  const followers = toc1.slice(idx + 1);
  renumberOk = renumberOk && followers.every((t, i) => t.cls.includes("toc-teaser")
    ? t.label === "Continuará" : t.label === `Capítulo ${chaptersBefore + 2 + i}`);
  renumberOk = renumberOk && toc1.slice(0, idx).every((t, i) => t.label === tocBase[i].label);
  check("Índice: los capítulos anteriores conservan su número y el teaser no cambia", renumberOk, JSON.stringify(toc1.map((t) => t.label)));
  check("Índice: la fila del teaser no tiene imagen", toc1[teaserIdx] && toc1[teaserIdx].hasImg === false);

  await pub.goto(`${serve1.url}/capitulo/${newFolder}/`, { waitUntil: "networkidle" });
  await pub.evaluate(async () => {
    for (let y = 0; y < document.documentElement.scrollHeight; y += 400) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 60)); }
    window.scrollTo(0, 0);
  });
  await pub.waitForLoadState("networkidle");
  const pageInfo = await pub.evaluate(async () => {
    const imgs = [...document.images];
    await Promise.all(imgs.map((i) => (i.complete ? null : new Promise((r) => { i.onload = i.onerror = r; setTimeout(r, 8000); }))));
    const video = document.querySelector("video");
    let videoOk = false;
    if (video) {
      // A detached probe element: re-loading the page's own <video> would abort its request.
      const src = video.querySelector("source")?.getAttribute("src");
      const probe = document.createElement("video");
      probe.preload = "metadata";
      videoOk = await new Promise((resolve) => {
        probe.addEventListener("loadedmetadata", () => resolve(probe.videoWidth > 0), { once: true });
        probe.addEventListener("error", () => resolve(false), { once: true });
        setTimeout(() => resolve(false), 10000);
        probe.src = src;
      });
    }
    return {
      h1: document.querySelector("h1")?.textContent.trim(),
      eyebrow: document.querySelector(".eyebrow")?.textContent.trim(),
      note: document.querySelector(".note")?.textContent.trim(),
      captions: [...document.querySelectorAll("figcaption")].map((c) => c.textContent.trim()),
      badImgs: imgs.filter((i) => !(i.complete && i.naturalWidth > 0)).map((i) => i.currentSrc || i.src),
      imgCount: imgs.length,
      videoOk,
      hasVideo: !!video,
      prev: document.querySelector("a.prev")?.getAttribute("href"),
      next: document.querySelector("a.next")?.getAttribute("href"),
    };
  });
  check("Capítulo nuevo: título, nota y pie de foto", pageInfo.h1 === TEST_TITLE && pageInfo.note === TEST_NOTE && pageInfo.captions.includes(TEST_CAPTION),
    JSON.stringify(pageInfo));
  check("Capítulo nuevo: etiqueta de número correcta", pageInfo.eyebrow?.endsWith(`Capítulo ${chaptersBefore + 1}`), pageInfo.eyebrow);
  check("Capítulo nuevo: todas las imágenes cargan y el video llega a loadedmetadata", pageInfo.imgCount >= 2 && pageInfo.badImgs.length === 0 &&
    pageInfo.hasVideo && pageInfo.videoOk, JSON.stringify(pageInfo.badImgs));
  check("Capítulo nuevo: «Siguiente» lleva al teaser", pageInfo.next === toc1[teaserIdx].href, pageInfo.next);
  await shot(pub, "site-01-capitulo-nuevo");
  const heroSrc = await pub.evaluate(() => document.querySelector("figure img")?.getAttribute("src"));
  if (heroSrc) {
    const heroMeta = await sharp(path.join(dist1, heroSrc)).metadata();
    check("La foto publicada en dist no conserva EXIF", !heroMeta.exif, heroSrc);
  }
  check("Sitio reconstruido: cero respuestas 400+, requestfailed, pageerror y console.error", pubProblems.length === 0, pubProblems.join(" | "));

  // ---- Step 6: delete, publish, rebuild --------------------------------------------------
  step("6. Eliminar el capítulo, publicar y comparar con el baseline");
  await page.locator(".chapter-btn", { hasText: TEST_TITLE }).click();
  await waitText(page, "#view h2", /Editar capítulo/, "editor del capítulo");
  await page.getByRole("button", { name: "Eliminar capítulo" }).click();
  await waitFor(async () => mock.commitCount() === 2, "segundo commit (eliminar)", 30000);
  await waitText(page, "#view h2", /Capítulos/, "lista tras eliminar", 30000);
  check("Eliminar publica un commit más (dos en total)", mock.commitCount() === 2, `${mock.commitCount()} commits`);
  check("La lista ya no muestra el capítulo de prueba", !(await listTitles()).includes(TEST_TITLE));
  const export2 = path.join(E2E, "export-2");
  await mock.exportTo(export2);
  // Git (and so the mock tree) cannot store empty directories; ignore them in the comparison.
  const pruneEmpty = async (dir) => {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      if (e.isDirectory()) await pruneEmpty(path.join(dir, e.name));
    }
    if ((await fs.readdir(dir)).length === 0 && dir !== original) await fs.rmdir(dir);
  };
  await pruneEmpty(original);
  const diffR = await run("diff", ["-r", original, path.join(export2, "content")]);
  await fs.writeFile(path.join(OUT, "diff-r.txt"), `diff -r ${original} ${path.join(export2, "content")}\nexit ${diffR.code}\n${diffR.out}`);
  check("diff -r: el contenido del mock es igual al original", diffR.code === 0, diffR.out.slice(0, 300));
  const dist2 = path.join(E2E, "dist-2");
  await build(path.join(export2, "content"), dist2, "tras-eliminar");
  const final = await distListing(dist2);
  const listingDiffs = diffMaps(baseline, final);
  await writeJson(path.join(OUT, "dist-final.json"), final);
  check("El listado de dist/ tras eliminar es igual a baseline.json", listingDiffs.length === 0, listingDiffs.slice(0, 5).join("; "));

  // ---- Step 7: negative cases ------------------------------------------------------------
  step("7. Casos negativos");
  await page.getByRole("button", { name: "Nuevo capítulo" }).click();
  await waitText(page, "#view h2", /Nuevo capítulo/, "editor para negativos");
  const callsBeforeNeg = mockCalls();
  const fileInput = page.locator('input[type="file"]');
  const dismiss = async () => { const b = page.getByRole("button", { name: "Entendido" }); if (await b.count()) await b.first().click(); };

  await fileInput.setInputFiles({ name: "enorme.mp4", mimeType: "video/mp4", buffer: Buffer.alloc(30 * 1024 * 1024) });
  const e30 = await waitText(page, "#app p.error", /25 MB/, "rechazo de video de 30 MB");
  check("Video de 30 MB rechazado en el cliente con el límite en el mensaje", /pesa más de 25 MB/.test(e30), e30);
  await dismiss();
  await fileInput.setInputFiles(longClip);
  const e180 = await waitText(page, "#app p.error", /120 segundos/, "rechazo de video de 3 minutos", 30000);
  check("Video de 3 minutos rechazado en el cliente con el límite en el mensaje", /dura más de 120 segundos/.test(e180), e180);
  await dismiss();
  await fileInput.setInputFiles({ name: "foto.heic", mimeType: "image/heic", buffer: Buffer.from("no-es-una-imagen") });
  const eHeic = await waitText(page, "#app p.error", /HEIC/, "rechazo de HEIC");
  check(".heic rechazado con un mensaje claro", /HEIC/.test(eHeic), eHeic);
  await dismiss();
  check("Los rechazos no hicieron ninguna llamada de red al mock", mockCalls() === callsBeforeNeg, `${mockCalls() - callsBeforeNeg} llamadas`);

  const dup = await smallJpegBuffer();
  await fileInput.setInputFiles({ name: "repetida.jpg", mimeType: "image/jpeg", buffer: dup });
  await waitFor(async () => (await page.locator(".item").count()) === 1, "primera foto repetida", 20000);
  await fileInput.setInputFiles({ name: "repetida.jpg", mimeType: "image/jpeg", buffer: dup });
  await waitFor(async () => (await page.locator(".item").count()) === 2, "segunda foto repetida", 20000);
  const legends = await page.locator(".item legend").allTextContents();
  check("Un nombre repetido recibe el sufijo -2", legends.some((l) => l.endsWith("repetida.jpg")) && legends.some((l) => l.endsWith("repetida-2.jpg")), legends.join(" | "));
  check("Los archivos aceptados tampoco llaman a la red hasta publicar", mockCalls() === callsBeforeNeg, `${mockCalls() - callsBeforeNeg} llamadas`);
  await shot(page, "admin-05-negativos");
  await page.getByRole("button", { name: "← Capítulos" }).click();
  await waitText(page, "#view h2", /Capítulos/, "volver a la lista");

  // ---- Step 8: edit round trip with a 422 retry ------------------------------------------
  step("8. Edición de un capítulo sembrado (con reintento 422)");
  const rtDir = path.join(export2, "content", "chapters", fx.roundTripSlug);
  const rtBeforeText = await fs.readFile(path.join(rtDir, "chapter.json"), "utf8");
  const rtBefore = JSON.parse(rtBeforeText);
  const rtTitle = rtBefore.title;
  const rtNote1 = "Nota editada por la prueba e2e.";
  await page.locator(".chapter-btn", { hasText: rtTitle }).click();
  await waitText(page, "#view h2", /Editar capítulo/, "editor del capítulo sembrado");
  await page.getByLabel("Nota", { exact: true }).fill(rtNote1);
  check("Editar la nota de un borrador marca «Texto definitivo»", await page.getByLabel("Texto definitivo").isChecked());
  mock.setHooks({ failFirstPatch: true });
  const c8 = mock.commitCount();
  const patchesBefore = mock.requests().filter((r) => r.method === "PATCH").length;
  await page.getByRole("button", { name: "Publicar" }).click();
  await waitText(page, "#view h2", /Capítulos/, "lista tras editar", 30000);
  const patches = mock.requests().filter((r) => r.method === "PATCH").slice(patchesBefore).map((r) => r.status);
  check("422 en el primer PATCH: el reintento funciona y queda un solo commit", patches.join(",") === "422,200" && mock.commitCount() === c8 + 1,
    `PATCH ${patches.join(",")} commits=${mock.commitCount() - c8}`);
  const export3 = path.join(E2E, "export-3");
  await mock.exportTo(export3);
  const tree2 = await listTree(path.join(export2, "content"));
  const tree3 = await listTree(path.join(export3, "content"));
  const changed3 = diffTrees(tree2, tree3);
  check("Solo cambió el chapter.json del capítulo editado", changed3.length === 1 && changed3[0] === `distinto: chapters/${fx.roundTripSlug}/chapter.json`, changed3.join("; "));
  const rtAfterText = await fs.readFile(path.join(export3, "content", "chapters", fx.roundTripSlug, "chapter.json"), "utf8");
  const rtAfter = JSON.parse(rtAfterText);
  const expected = { ...rtBefore, note: rtNote1, draft: false };
  check("Ida y vuelta: solo difieren note y draft; claves y orden intactos (place, size, frame, pages)",
    JSON.stringify(rtAfter) === JSON.stringify(expected) && JSON.stringify(Object.keys(rtAfter)) === JSON.stringify(Object.keys(rtBefore)) &&
      rtAfterText === `${JSON.stringify(expected, null, 2)}\n`,
  `${rtBeforeText.length} -> ${rtAfterText.length}`);
  await shot(page, "admin-06-edicion");

  // ---- Service worker and build.json polling ---------------------------------------------
  step("8b. Service worker y sondeo de build.json");
  const swPage = await context.newPage();
  await swPage.goto(`${serveOrigin}/`, { waitUntil: "load" });
  const swState = await swPage.evaluate(async () => {
    const reg = await Promise.race([navigator.serviceWorker.ready, new Promise((r) => setTimeout(() => r(null), 15000))]);
    return reg && reg.active ? reg.active.state : null;
  });
  check("El service worker está activo en una página pública", swState === "activated" || swState === "activating", String(swState));
  const shellCaches = await swPage.evaluate(async () => (await caches.keys()).filter((k) => k.startsWith("shell-")));
  check("El service worker creó su caché de páginas", shellCaches.length > 0, shellCaches.join(","));
  await page.locator(".chapter-btn", { hasText: rtTitle }).click();
  await waitText(page, "#view h2", /Editar capítulo/, "editor (segunda edición)");
  await page.getByLabel("Nota", { exact: true }).fill("Segunda edición de la prueba e2e.");
  mock.setHooks({ buildSha: ZERO_SHA }); // the deployed sha does not match the new commit yet
  const buildGetsBefore = mock.requests().filter((r) => r.path.startsWith("/build.json")).length;
  await page.getByRole("button", { name: "Publicar" }).click();
  await waitText(page, "#view h2", /Capítulos/, "lista tras segunda edición", 30000);
  const headSha = mock.head();
  await waitFor(() => mock.requests().filter((r) => r.path.startsWith("/build.json")).length >= buildGetsBefore + 3, "sondeos de build.json", 15000);
  const pendingText = await textOf(page, ".live");
  check("Con otro sha en build.json el administrador sigue «construyendo»", /construyendo/.test(pendingText) && !/Ya está publicado/.test(pendingText), pendingText);
  const cached = await page.evaluate(async () => {
    const hit = await caches.match("/build.json");
    return hit === undefined ? "undefined" : "hit";
  });
  check("caches.match(\"/build.json\") es undefined con el service worker activo", cached === "undefined", cached);
  mock.setHooks({ buildSha: headSha });
  const liveNow = await waitText(page, ".live", /Ya está publicado/, "detección del nuevo sha en el siguiente sondeo", 15000);
  check("Al cambiar el sha del mock, el administrador lo detecta en el siguiente sondeo", /Ya está publicado/.test(liveNow), liveNow);
  const cachedAfter = await page.evaluate(async () => ((await caches.match("/build.json")) === undefined ? "undefined" : "hit"));
  check("Tras el sondeo, /build.json sigue sin estar en ningún caché", cachedAfter === "undefined", cachedAfter);
  await swPage.close();

  // ---- Failed run --------------------------------------------------------------------------
  step("8c. Ejecución de Actions fallida");
  await page.locator(".chapter-btn", { hasText: rtTitle }).click();
  await waitText(page, "#view h2", /Editar capítulo/, "editor (tercera edición)");
  await page.getByLabel("Nota", { exact: true }).fill("Tercera edición para el run fallido.");
  mock.setHooks({ runConclusion: "failure", buildSha: ZERO_SHA });
  await page.getByRole("button", { name: "Publicar" }).click();
  const failText = await waitText(page, ".live", /No se pudo construir/, "aviso de build fallido", 20000);
  const failHref = await page.locator(".live a").first().getAttribute("href");
  check("Run fallido: «No se pudo construir» con el enlace a la ejecución", /No se pudo construir/.test(failText) && /\/runs\/\d+$/.test(failHref ?? "") &&
    (failHref ?? "").startsWith(mock.url), `${failText} | ${failHref}`);
  await shot(page, "admin-07-build-fallido");
  mock.setHooks({ runConclusion: "success", buildSha: null });

  // ---- 401 mid-session ------------------------------------------------------------------------
  step("8d. 401 a mitad de la sesión");
  await page.locator(".chapter-btn", { hasText: rtTitle }).click();
  await waitText(page, "#view h2", /Editar capítulo/, "editor (cuarta edición)");
  await page.getByLabel("Nota", { exact: true }).fill("Cuarta edición con token revocado.");
  const commitsBefore401 = mock.commitCount();
  await page.route(`${mock.url}/repos/**`, (route) => {
    if (route.request().method() === "OPTIONS") return route.fallback();
    return route.fulfill({
      status: 401,
      headers: { "Access-Control-Allow-Origin": serveOrigin, "Content-Type": "application/json", Vary: "Origin" },
      body: JSON.stringify({ message: "Bad credentials" }),
    });
  });
  await page.getByRole("button", { name: "Publicar" }).click();
  const msg401 = await waitText(page, ".status", /token no es válido/i, "mensaje de token vencido", 15000);
  check("401 a mitad de la sesión: mensaje de token vencido y no se publica nada", /El token no es válido o venció/.test(msg401) && mock.commitCount() === commitsBefore401, msg401);
  note("401 a mitad de la sesión: el administrador muestra el mensaje de token vencido y conserva el formulario (diseño 12); no vuelve por sí solo a la pantalla de configuración. Para volver a empezar se usa «Bloquear» y «Olvidar este dispositivo».");
  await page.unroute(`${mock.url}/repos/**`);
  await page.getByRole("button", { name: "Bloquear" }).click().catch(() => {});

  check("Al final: cero violaciones de CSP y cero fallos de CORS", cspViolations.length === 0 && corsFailures.length === 0,
    JSON.stringify({ cspViolations, corsFailures }));

  await writeJson(path.join(OUT, "mock-requests.json"), mock.requests().map(({ method, path: p, authenticated, status }) => ({ method, path: p, authenticated, status })));
}

// ------------------------------------------------------------------ run + report
async function finish(fatal) {
  if (fatal) check(`Error fatal en «${stepLabel}»`, false, fatal.stack ?? String(fatal));
  try { await browser?.close(); } catch { /* ignore */ }
  for (const fn of cleanup.reverse()) { try { await fn(); } catch { /* ignore */ } }
  // Leave build/ matching the real content (the e2e builds shared it).
  const restore = await run(process.execPath, [path.join(ROOT, "scripts", "media.mjs")]);
  check("build/ restaurado para el contenido real", restore.code === 0, restore.out.trim().split("\n").slice(-3).join(" | "));

  const failed = results.filter((r) => !r.ok);
  const report = {
    generatedAt: new Date().toISOString(),
    ok: failed.length === 0,
    passed: results.length - failed.length,
    failed: failed.length,
    results,
    notes,
    notExercised: [
      "GitHub real (token fine-grained, API, límites de tasa)",
      "Ejecución real de GitHub Actions",
      "Despliegue en Cloudflare Pages y HTTPS en pages.dev",
      "Un teléfono real y NFC",
      "El comportamiento real de unión de cabeceras de Cloudflare (solo se aplica la semántica local de _headers)",
    ],
  };
  await fs.mkdir(OUT, { recursive: true });
  await writeJson(path.join(OUT, "report.json"), report);
  const md = [
    "# Verificación e2e del administrador",
    "",
    `Generado: ${report.generatedAt}`,
    `Resultado: ${report.ok ? "TODO OK" : "HAY FALLOS"} (${report.passed} correctas, ${report.failed} con fallo)`,
    "",
    "## Comprobaciones",
    ...results.map((r) => `- ${r.ok ? "OK" : "FALLA"}: ${r.name}${r.ok || !r.detail ? "" : ` (${r.detail})`}`),
    "",
    "## Notas",
    ...(notes.length ? notes.map((n) => `- ${n}`) : ["- (ninguna)"]),
    "",
    "## No se ejercitó (Req 23.8)",
    ...report.notExercised.map((n) => `- ${n}`),
    "",
    "Evidencia: capturas `admin-*.png` y `site-*.png`, `baseline.json`, `dist-final.json`, `diff-r.txt`, `mock-requests.json`, `build-*.log`.",
    "",
  ].join("\n");
  await fs.writeFile(path.join(OUT, "REPORT.md"), md);
  console.log(`\n${report.ok ? "e2e OK" : "e2e CON FALLOS"}: ${report.passed} correctas, ${report.failed} con fallo. Evidencia en verification/e2e/`);
  process.exit(report.ok ? 0 : 1);
}

main().then(() => finish(null), (e) => finish(e));
