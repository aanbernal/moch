#!/usr/bin/env node
// Headless browser verification of dist/ (design 14.3, Req 1.2, 1.3, 1.6, 1.8, 1.10, 6.6, 7.3,
// 11.1, 18.7, 19.5, 23.1, 23.2). Run with `npm run verify:browser` (sets STRICT_SEED=1).
//
// Serves dist/ with scripts/serve.mjs (strict headers, so the real CSP applies), drives Chrome at
// 390x844 / DPR 3 and writes verification/screenshots/NN-<slug>.png, verification/report.json
// and verification/REPORT.md. Exit code 1 when any check fails, 0 otherwise (warnings allowed).

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { startServer } from "./serve.mjs";

process.env.STRICT_SEED ??= "1";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");
const OUT = path.join(ROOT, "verification");
const SHOTS = path.join(OUT, "screenshots");

const COVER_TARGET = 300 * 1024;
const COVER_FAIL = 450 * 1024;
const CONTEXT_OPTS = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  locale: "es-MX",
};

// ---------------------------------------------------------------- reporting
const results = [];
const warnings = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: !!ok, detail: String(detail ?? "") });
  console.log(`${ok ? "OK   " : "FALLA"} ${name}${detail && !ok ? ` -> ${detail}` : ""}`);
  return !!ok;
}
function warn(name, detail = "") {
  warnings.push({ name, detail: String(detail) });
  console.log(`AVISO ${name}${detail ? ` -> ${detail}` : ""}`);
}
const skipped = [];
function skip(name, why) {
  skipped.push({ name, why });
  console.log(`OMITIDA ${name} (${why})`);
}

// ---------------------------------------------------------------- helpers
const norm = (s) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

async function launch() {
  try {
    return await chromium.launch({ channel: "chrome", headless: true });
  } catch (e) {
    if (process.env.CHROME_PATH) {
      return chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
    }
    throw new Error(`No se pudo iniciar Chrome (channel "chrome"): ${e.message}. Define CHROME_PATH si está en otra ruta.`);
  }
}

/** Collects network/console problems for one page (Req 23.2). */
function watch(page, bucket, label) {
  page.on("response", (r) => {
    if (r.status() >= 400) bucket.push(`${label}: HTTP ${r.status()} ${r.url()}`);
  });
  page.on("requestfailed", (r) => {
    const err = r.failure()?.errorText ?? "";
    // ERR_ABORTED is Chrome cancelling an in-flight request when we navigate away (e.g. the page
    // icon on a fast goto); it is not a server or network failure.
    if (err === "net::ERR_ABORTED") return;
    bucket.push(`${label}: requestfailed ${r.url()} ${err}`);
  });
  page.on("pageerror", (e) => bucket.push(`${label}: pageerror ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") bucket.push(`${label}: console.error ${m.text()}`);
  });
}

async function scrollThrough(page) {
  await page.evaluate(async () => {
    const step = Math.max(200, Math.floor(window.innerHeight * 0.7));
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    let y = 0;
    for (let i = 0; i < 400; i++) {
      const h = document.documentElement.scrollHeight;
      if (y >= h) break;
      y += step;
      window.scrollTo(0, y);
      await wait(60);
    }
    window.scrollTo(0, 0);
  });
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.evaluate(async () => {
    const imgs = [...document.images].filter((i) => !i.closest("dialog"));
    await Promise.all(imgs.map((i) => (i.complete ? null : new Promise((r) => { i.onload = i.onerror = r; setTimeout(r, 8000); }))));
  });
}

async function screenshot(page, file) {
  try {
    await page.screenshot({ path: file, fullPage: true });
  } catch {
    // Very tall pages can exceed the texture limit at DPR 3; fall back to CSS pixels.
    await page.screenshot({ path: file, fullPage: true, scale: "css" });
  }
}

async function imageProblems(page) {
  return page.evaluate(() =>
    [...document.images]
      .filter((i) => !i.closest("dialog"))
      .filter((i) => !(i.complete && i.naturalWidth > 0))
      .map((i) => i.currentSrc || i.src),
  );
}

async function videoProblems(page) {
  return page.evaluate(async () => {
    const bad = [];
    for (const v of document.querySelectorAll("video")) {
      const ok = await new Promise((resolve) => {
        if (v.readyState >= 1 && v.videoWidth > 0) return resolve(true);
        const t = setTimeout(() => resolve(false), 10000);
        v.addEventListener("loadedmetadata", () => { clearTimeout(t); resolve(v.videoWidth > 0); }, { once: true });
        v.addEventListener("error", () => { clearTimeout(t); resolve(false); }, { once: true });
        v.preload = "metadata";
        v.load();
      });
      if (!ok) bad.push(`video ${v.currentSrc || v.querySelector("source")?.src}`);
      if (v.poster) {
        const pok = await new Promise((resolve) => {
          const im = new Image();
          im.onload = () => resolve(im.naturalWidth > 0);
          im.onerror = () => resolve(false);
          im.src = v.poster;
        });
        if (!pok) bad.push(`poster ${v.poster}`);
      }
    }
    return bad;
  });
}

async function layoutProblems(page) {
  return page.evaluate(() => {
    const out = [];
    const sw = document.documentElement.scrollWidth;
    if (sw > window.innerWidth) out.push(`scrollWidth ${sw} > ${window.innerWidth}`);
    return out;
  });
}

async function targetProblems(page) {
  return page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll(".pager a, a.button, .toc-row, .zoom-open")) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (r.height < 44 || r.width < 44) out.push(`${el.className || el.tagName} ${Math.round(r.width)}x${Math.round(r.height)}`);
    }
    return out;
  });
}

async function getTocOrder(page, base) {
  await page.goto(`${base}/indice/`);
  return page.$$eval("a.toc-row", (as) => as.map((a) => new URL(a.href).pathname));
}

async function swipe(page, x0, y0, x1, y1) {
  await page.evaluate(([a, b, c, d]) => {
    const t = (x, y) => new Touch({ identifier: 1, target: document.body, clientX: x, clientY: y });
    const fire = (type, x, y) =>
      document.body.dispatchEvent(new TouchEvent(type, {
        bubbles: true, cancelable: true,
        touches: type === "touchend" ? [] : [t(x, y)],
        changedTouches: [t(x, y)],
      }));
    fire("touchstart", a, b);
    fire("touchend", c, d);
  }, [x0, y0, x1, y1]);
}

async function readJson(p) {
  try { return JSON.parse(await fs.readFile(p, "utf8")); } catch { return null; }
}

// ---------------------------------------------------------------- main
async function main() {
  try {
    await fs.access(path.join(DIST, "index.html"));
  } catch {
    console.error("dist/ no existe o está vacío. Ejecuta primero `npm run build` (o eleventy).");
    process.exit(4);
  }
  await fs.rm(OUT, { recursive: true, force: true });
  await fs.mkdir(SHOTS, { recursive: true });

  const server = await startServer({ dir: DIST, port: 0, strictHeaders: true });
  const base = server.url;
  const browser = await launch();
  const problems = [];

  try {
    const ctx = await browser.newContext(CONTEXT_OPTS);
    const page = await ctx.newPage();
    watch(page, problems, "crawl");

    // ---- page list: cover, TOC, then chapters in TOC order
    const tocPaths = await getTocOrder(page, base);
    check("El índice enlaza al menos un capítulo", tocPaths.length > 0, `${tocPaths.length} enlaces`);
    const slugOf = (p) => decodeURIComponent(p).replace(/\/+$/, "").split("/").pop();
    const chapters = tocPaths.map((p) => ({ path: p, slug: slugOf(p) }));
    const pages = [
      { path: "/", slug: "portada" },
      { path: "/indice/", slug: "indice" },
      ...chapters,
    ];

    // ---- visit every page: screenshots, assets, layout (Req 23.1, 23.2, 1.8)
    let n = 0;
    for (const pg of pages) {
      const resp = await page.goto(`${base}${pg.path}`, { waitUntil: "load" });
      check(`${pg.path} responde 200`, resp?.status() === 200, `status ${resp?.status()}`);
      await scrollThrough(page);
      const imgs = await imageProblems(page);
      check(`${pg.path} imágenes cargan (naturalWidth > 0)`, imgs.length === 0, imgs.join(", "));
      const vids = await videoProblems(page);
      check(`${pg.path} videos y posters cargan`, vids.length === 0, vids.join(", "));
      const lay = await layoutProblems(page);
      check(`${pg.path} sin scroll horizontal a 390 px`, lay.length === 0, lay.join(", "));
      const tg = await targetProblems(page);
      check(`${pg.path} objetivos táctiles >= 44 px`, tg.length === 0, tg.join(", "));
      const file = path.join(SHOTS, `${String(n).padStart(2, "0")}-${pg.slug}.png`);
      await screenshot(page, file);
      pg.screenshot = path.relative(ROOT, file);
      n++;
    }

    // 360 px width
    await page.setViewportSize({ width: 360, height: 800 });
    for (const pg of pages) {
      await page.goto(`${base}${pg.path}`, { waitUntil: "load" });
      const lay = await layoutProblems(page);
      check(`${pg.path} sin scroll horizontal a 360 px`, lay.length === 0, lay.join(", "));
    }
    await page.setViewportSize(CONTEXT_OPTS.viewport);

    check("Cero respuestas >= 400, requestfailed, pageerror o console.error", problems.length === 0, problems.slice(0, 10).join(" | "));

    // ---- custom 404 pages
    const notFoundHtml = await fs.readFile(path.join(DIST, "404.html"), "utf8").catch(() => "");
    const notFoundTitle = /<title>([^<]*)<\/title>/.exec(notFoundHtml)?.[1]?.trim();
    const p404 = await ctx.newPage();
    for (const u of ["/no-existe/", "/capitulo/no-existe/"]) {
      const r = await p404.goto(`${base}${u}`);
      const title = (await p404.title()).trim();
      check(`${u} devuelve 404 con la página propia`, r?.status() === 404 && !!notFoundTitle && title === notFoundTitle, `status ${r?.status()}, title "${title}"`);
    }
    await p404.close();

    // ---- navigation (Req 1.2, 1.3)
    await page.goto(`${base}/`);
    check("La portada muestra el botón Abrir", (await page.locator("a.open", { hasText: "Abrir" }).count()) === 1);
    await Promise.all([page.waitForURL("**/indice/"), page.click("a.open")]);
    check('"Abrir" lleva al índice', new URL(page.url()).pathname === "/indice/");

    if (chapters.length > 0) {
      await page.goto(`${base}${chapters[0].path}`);
      const visited = [new URL(page.url()).pathname];
      for (let i = 0; i < chapters.length + 2; i++) {
        const label = (await page.locator("a.next").first().textContent())?.trim();
        if (label !== "Siguiente") { check('Etiqueta "Siguiente"', false, label); break; }
        await Promise.all([page.waitForURL((u) => u.pathname !== visited.at(-1)), page.click("a.next")]);
        const p = new URL(page.url()).pathname;
        if (p === "/indice/") break;
        visited.push(p);
      }
      check('"Siguiente" recorre todos los capítulos en orden y termina en el índice',
        JSON.stringify(visited) === JSON.stringify(chapters.map((c) => c.path)) && new URL(page.url()).pathname === "/indice/",
        `visitados: ${visited.join(", ")}`);

      // first chapter's Anterior goes to the TOC
      await page.goto(`${base}${chapters[0].path}`);
      const prevHref = await page.getAttribute("a.prev", "href");
      check('"Anterior" del primer capítulo va al índice', prevHref === "/indice/", prevHref);

      // keyboard
      const target = chapters.length > 1 ? chapters[1].path : "/indice/";
      await Promise.all([page.waitForURL((u) => u.pathname === target), page.keyboard.press("ArrowRight")]);
      check("Flecha derecha avanza", new URL(page.url()).pathname === target, page.url());
      await Promise.all([page.waitForURL((u) => u.pathname === chapters[0].path), page.keyboard.press("ArrowLeft")]);
      check("Flecha izquierda retrocede", new URL(page.url()).pathname === chapters[0].path, page.url());

      // swipe (>= 60 px, |dx| > 1.5 |dy|)
      await Promise.all([page.waitForURL((u) => u.pathname === target), swipe(page, 300, 400, 120, 410)]);
      check("Deslizar a la izquierda avanza", new URL(page.url()).pathname === target, page.url());
      await Promise.all([page.waitForURL((u) => u.pathname === chapters[0].path), swipe(page, 100, 400, 280, 395)]);
      check("Deslizar a la derecha retrocede", new URL(page.url()).pathname === chapters[0].path, page.url());
      await swipe(page, 300, 300, 270, 300);
      await page.waitForTimeout(300);
      check("Un deslizamiento corto (< 60 px) no navega", new URL(page.url()).pathname === chapters[0].path);

      // deep-link reload
      await page.reload();
      check("Recargar un enlace directo se queda en la página",
        new URL(page.url()).pathname === chapters[0].path && (await page.locator("h1").count()) === 1);
    }

    // ---- TOC teaser row (Fix 3)
    await page.goto(`${base}/indice/`);
    const teaserRow = await page.evaluate(() => {
      const t = document.querySelector("li.toc-teaser");
      const withImg = [...document.querySelectorAll("li.toc-item")].find((li) => li.querySelector("img"));
      if (!t) return { present: false };
      return {
        present: true,
        imgs: t.querySelectorAll("img").length,
        h: t.getBoundingClientRect().height,
        refH: withImg ? withImg.getBoundingClientRect().height : null,
      };
    });
    if (!teaserRow.present) skip("Fila de teaser del índice", "no hay capítulo teaser en el contenido actual");
    else {
      check("La fila teaser no tiene <img>", teaserRow.imgs === 0);
      if (teaserRow.refH == null) skip("Altura de fila teaser", "no hay fila con miniatura");
      else check("La fila teaser mide lo mismo que una fila con miniatura", Math.abs(teaserRow.h - teaserRow.refH) <= 1, `${teaserRow.h} vs ${teaserRow.refH}`);
    }

    // ---- letters zoom (Req 19.5)
    let letterPage = null;
    for (const c of chapters) {
      await page.goto(`${base}${c.path}`);
      if ((await page.locator("figure.frame-letter a.zoom-open").count()) > 0) { letterPage = c; break; }
    }
    if (!letterPage) skip("Zoom de cartas", "ningún capítulo tiene cartas todavía");
    else {
      const open = page.locator("figure.frame-letter a.zoom-open").first();
      await open.scrollIntoViewIfNeeded();
      await open.click();
      check("El zoom de una carta se abre al tocar", (await page.locator("dialog.zoom[open]").count()) === 1);
      await page.locator("dialog.zoom[open] .zoom-close").click();
      check("El zoom se cierra con el botón", (await page.locator("dialog.zoom[open]").count()) === 0);
      await open.click();
      await page.keyboard.press("Escape");
      check("El zoom se cierra con Esc", (await page.locator("dialog.zoom[open]").count()) === 0);
    }

    await ctx.close();

    // ---- reduced motion (Req 1.10)
    {
      const rctx = await browser.newContext({ ...CONTEXT_OPTS, reducedMotion: "reduce", serviceWorkers: "block" });
      const rp = await rctx.newPage();
      for (const u of ["/", chapters[0]?.path ?? "/indice/"]) {
        await rp.goto(`${base}${u}`, { waitUntil: "load" });
        const r = await rp.evaluate(() => ({
          pt: getComputedStyle(document.documentElement).getPropertyValue("--page-turn").trim(),
          anims: document.getAnimations().length,
        }));
        check(`Movimiento reducido en ${u}: --page-turn es none`, r.pt === "none", r.pt);
        check(`Movimiento reducido en ${u}: sin animaciones activas`, r.anims === 0, `${r.anims} animaciones`);
      }
      await rctx.close();
      const nctx = await browser.newContext({ ...CONTEXT_OPTS, reducedMotion: "no-preference", serviceWorkers: "block" });
      const np = await nctx.newPage();
      await np.goto(`${base}/`, { waitUntil: "load" });
      const pt = await np.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--page-turn").trim());
      check("Sin preferencia de movimiento: --page-turn es fade", pt === "fade", pt);
      await nctx.close();
    }

    // ---- cover budget (Fix 4, Req 6.6): fresh context, no service worker, CDP byte count
    {
      const cctx = await browser.newContext({ ...CONTEXT_OPTS, serviceWorkers: "block" });
      const cp = await cctx.newPage();
      const cdp = await cctx.newCDPSession(cp);
      await cdp.send("Network.enable");
      const reqs = new Map();
      let total = 0;
      cdp.on("Network.requestWillBeSent", (e) => reqs.set(e.requestId, e.request.url));
      cdp.on("Network.loadingFinished", (e) => { total += e.encodedDataLength; });
      await cp.goto(`${base}/`, { waitUntil: "load" });
      await cp.waitForLoadState("networkidle").catch(() => {});
      const urls = [...reqs.values()];
      const kb = (total / 1024).toFixed(1);
      if (total > COVER_FAIL) check("Presupuesto de portada <= 450 KB", false, `${kb} KB`);
      else {
        check("Presupuesto de portada <= 450 KB", true);
        if (total > COVER_TARGET) warn("Portada sobre el objetivo de 300 KB", `${kb} KB`);
      }
      const heroUrl = await cp.evaluate(() => document.querySelector("img.cover-hero, .cover-hero img")?.currentSrc ?? null);
      if (!heroUrl) skip("Imagen de portada de 800 px", "la portada no tiene imagen (sin prólogo con cover)");
      else {
        check("La portada carga la variante de 800 px", /-800\.(webp|jpg)$/.test(new URL(heroUrl).pathname), heroUrl);
        check("La portada no pide variantes de 1200 px", !urls.some((u) => /-1200\.(webp|jpg)$/.test(new URL(u).pathname)));
      }
      results.coverBytes = total;
      await cctx.close();
    }

    // ---- offline (Req 11.1)
    {
      const octx = await browser.newContext(CONTEXT_OPTS);
      const op = await octx.newPage();
      const offlineTarget = chapters[0]?.path;
      if (!offlineTarget) skip("Recarga sin conexión", "no hay capítulos");
      else {
        await op.goto(`${base}/indice/`, { waitUntil: "load" });
        await op.evaluate(() => navigator.serviceWorker.ready.then(() => true)).catch(() => false);
        await op.goto(`${base}${offlineTarget}`, { waitUntil: "load" });
        await op.reload({ waitUntil: "load" }); // now controlled by the worker
        await scrollThrough(op);
        const title = (await op.locator("h1").first().textContent())?.trim();
        const controlled = await op.evaluate(() => !!navigator.serviceWorker.controller);
        await op.waitForTimeout(1500); // let /m/ puts finish
        await octx.setOffline(true);
        let ok = false, detail = "";
        try {
          await op.reload({ waitUntil: "load" });
          const t2 = (await op.locator("h1").first().textContent())?.trim();
          const loaded = await op.evaluate(() => [...document.images].filter((i) => !i.closest("dialog")).some((i) => i.complete && i.naturalWidth > 0));
          ok = t2 === title && loaded;
          detail = `título "${t2}", imagen cargada: ${loaded}, controlado: ${controlled}`;
        } catch (e) { detail = e.message; }
        check("Recarga sin conexión muestra el capítulo y una imagen en caché", ok, detail);
        await octx.setOffline(false);
      }
      await octx.close();
    }

    // ---- class B seed assertions (Fix 1), only because STRICT_SEED=1
    if (process.env.STRICT_SEED === "1") {
      const ctxB = await browser.newContext({ ...CONTEXT_OPTS, serviceWorkers: "block" });
      const pb = await ctxB.newPage();
      const hasChapter = (s) => chapters.some((c) => c.slug === s);

      if (!hasChapter("continuara")) skip("Clase B: texto de continuara", "el capítulo continuara no está sembrado");
      else {
        await pb.goto(`${base}/capitulo/continuara/`);
        const text = norm(await pb.evaluate(() => document.body.innerText));
        check('continuara contiene "Continuará"', text.includes("continuara"));
        const leaked = ["28", "cafe", "pregunta", "noviembre"].filter((w) => text.includes(w));
        check("continuara no revela 28, café, pregunta ni noviembre", leaked.length === 0, leaked.join(", "));
      }

      if (!hasChapter("cartas")) skip("Clase B: cartas", "el capítulo cartas no está sembrado");
      else {
        await pb.goto(`${base}/capitulo/cartas/`);
        const nFigs = await pb.locator("figure.frame-letter").count();
        check("cartas tiene exactamente 4 figure.frame-letter", nFigs === 4, `${nFigs}`);
        const phrases = ["enamoramiento", "todo comenzo"];
        const hits = [];
        async function walk(dir) {
          for (const e of await fs.readdir(dir, { withFileTypes: true })) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) await walk(full);
            else if (/\.(html|json|js|css|txt|webmanifest|md)$/.test(e.name)) {
              const t = norm(await fs.readFile(full, "utf8"));
              for (const ph of phrases) if (t.includes(ph)) hits.push(`${path.relative(ROOT, full)}: ${ph}`);
            }
          }
        }
        await walk(DIST);
        await walk(path.join(ROOT, "content")).catch(() => {});
        check("Las frases clave de las cartas no aparecen en dist/ ni content/", hits.length === 0, hits.slice(0, 5).join(" | "));
      }
      await ctxB.close();

      // covers are never a group shot (Fix 3). Works for whatever is seeded.
      const deny = (await readJson(path.join(ROOT, "seed", "group-shots.json"))) ?? [];
      const bad = [];
      for (const c of chapters) {
        const j = await readJson(path.join(ROOT, "content", "chapters", c.slug, "chapter.json"))
          ?? await readJson(path.join(ROOT, "content", c.slug, "chapter.json"));
        if (j?.cover && deny.includes(`${c.slug}/${j.cover}`.toLowerCase())) bad.push(`${c.slug}/${j.cover}`);
      }
      check("Ninguna portada es una foto de grupo de la lista de exclusión", bad.length === 0, bad.join(", "));
    }
  } finally {
    await browser.close();
    await server.close();
  }

  // ---- report
  const failed = results.filter((r) => !r.ok);
  const report = {
    generatedAt: new Date().toISOString(),
    strictSeed: process.env.STRICT_SEED === "1",
    coverBytes: results.coverBytes ?? null,
    passed: results.length - failed.length,
    failed: failed.length,
    results,
    warnings,
    skipped,
    problems,
  };
  await fs.writeFile(path.join(OUT, "report.json"), JSON.stringify(report, null, 2) + "\n");
  const md = [
    "# Reporte de verificación en navegador",
    "",
    `Generado: ${report.generatedAt}`,
    `Resultado: ${report.passed} correctas, ${report.failed} con falla, ${warnings.length} avisos, ${skipped.length} omitidas.`,
    "",
    "## Fallas",
    ...(failed.length ? failed.map((r) => `- ${r.name}: ${r.detail}`) : ["Ninguna."]),
    "",
    "## Avisos",
    ...(warnings.length ? warnings.map((w) => `- ${w.name}: ${w.detail}`) : ["Ninguno."]),
    "",
    "## Omitidas",
    ...(skipped.length ? skipped.map((s) => `- ${s.name}: ${s.why}`) : ["Ninguna."]),
    "",
    "## Todas las comprobaciones",
    ...results.map((r) => `- [${r.ok ? "x" : " "}] ${r.name}`),
    "",
  ].join("\n");
  await fs.writeFile(path.join(OUT, "REPORT.md"), md);

  console.log(`\n${report.passed} correctas, ${report.failed} con falla. Reporte: verification/REPORT.md`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
