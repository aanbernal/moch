import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import sharp from "sharp";
import { run } from "../lib/exec.mjs";
import { ROOT } from "../lib/paths.mjs";
import { runMedia } from "../scripts/media.mjs";

// Renders a temporary content fixture (prologue, two chapters, teaser) through the real
// media pipeline and Eleventy, entirely under os.tmpdir().

let tmp, out;
const html = (p = "") => fs.readFile(path.join(out, p, "index.html"), "utf8");
const section = async (id) => {
  const m = (await html()).match(new RegExp(`<section class="page" id="${id}"[\\s\\S]*?</section>`));
  assert.ok(m, `section ${id}`);
  return m[0];
};

function makePdf(n) {
  const objs = ["<< /Type /Catalog /Pages 2 0 R >>"];
  objs.push(`<< /Type /Pages /Kids [${Array.from({ length: n }, (_, i) => `${3 + i} 0 R`).join(" ")}] /Count ${n} >>`);
  for (let i = 0; i < n; i++) objs.push("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] >>");
  let s = "%PDF-1.4\n";
  const offs = [];
  objs.forEach((o, i) => { offs.push(s.length); s += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = s.length;
  s += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offs) s += `${String(o).padStart(10, "0")} 00000 n \n`;
  return s + `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
}

function eleventy(env, output) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.join(ROOT, "node_modules/@11ty/eleventy/cmd.cjs"), `--output=${output}`],
      { cwd: ROOT, env: { ...process.env, ...env } },
    );
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    child.stdout.on("data", (d) => (err += d));
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(err))));
  });
}

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "chapter-tpl-"));
  const content = path.join(tmp, "content");
  const build = path.join(tmp, "build");
  out = path.join(tmp, "out");
  const ch = (slug) => path.join(content, "chapters", slug);
  for (const s of ["prologo", "uno", "dos", "fin"]) await fs.mkdir(path.join(ch(s), "media"), { recursive: true });

  const jpg = (w, h, r) => sharp({ create: { width: w, height: h, channels: 3, background: { r, g: 100, b: 80 } } }).jpeg().toBuffer();
  await fs.writeFile(path.join(ch("prologo"), "media", "hero.jpg"), await jpg(1000, 700, 200));
  await fs.writeFile(path.join(ch("uno"), "media", "a.jpg"), await jpg(1400, 900, 120));
  await fs.writeFile(path.join(ch("uno"), "media", "b.jpg"), await jpg(900, 900, 90));
  await fs.writeFile(path.join(ch("uno"), "media", "c.jpg"), await jpg(900, 600, 60));
  await fs.writeFile(path.join(ch("dos"), "media", "carta.pdf"), makePdf(2));
  const v = await run("ffmpeg", ["-nostdin", "-y", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=10:duration=2",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", path.join(ch("dos"), "media", "clip.mp4")]);
  assert.equal(v.code, 0, v.stderr);

  const w = (slug, o) => fs.writeFile(path.join(ch(slug), "chapter.json"), JSON.stringify({ schema: 1, ...o }));
  await w("prologo", { order: 0, kind: "prologue", title: "Prólogo del álbum", cover: "hero.jpg",
    media: [{ type: "photo", file: "hero.jpg", maxWidth: 800 }] });
  await w("uno", { order: 10, kind: "chapter", title: "Uno <b>", dateText: "Jue 1 de octubre", place: "Tepic", note: "Nota uno", cover: "a.jpg",
    media: [
      { type: "photo", file: "a.jpg", caption: "Con pie" },
      { type: "photo", file: "b.jpg" },
      { type: "photo", file: "c.jpg", pairWithPrevious: true },
      { type: "quote", text: "Me agradó", when: "1 de octubre" },
    ] });
  await w("dos", { order: 20, kind: "chapter", title: "Dos", cover: "clip.mp4",
    media: [
      { type: "video", file: "clip.mp4" },
      { type: "pdf", file: "carta.pdf", alt: "Carta, hoja {n}", frame: "letter", pages: [1, 2] },
    ] });
  await w("fin", { order: 30, kind: "teaser", title: "Continuará…", media: [] });
  await fs.writeFile(path.join(content, "site.json"), JSON.stringify({ title: "Álbum de prueba", volume: "Volumen I", lang: "es" }));

  const { manifest } = await runMedia({ contentDir: content, buildDir: build, cacheDir: path.join(tmp, "cache"), log: () => {} });
  assert.ok(manifest["dos/clip.mp4"]);
  await eleventy({ CONTENT_DIR: content, MEDIA_MANIFEST: path.join(build, "media-manifest.json") }, out);
});

after(() => fs.rm(tmp, { recursive: true, force: true }));

test("the Book is one document with one section per Page, inert except the Cover", async () => {
  const doc = await html();
  assert.match(doc, /^<!doctype html>\s*<html lang="es" class="no-js">/i);
  assert.match(doc, /<div class="stage">\s*<main id="book" class="book" data-pages="1">\s*<div class="pages">/);
  const ids = [...doc.matchAll(/<section class="page" id="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids, [
    "portada", "indice", "relleno-1",
    "capitulo-prologo", "capitulo-prologo-2",
    "capitulo-uno", "capitulo-uno-2", "capitulo-uno-3", "capitulo-uno-4",
    "capitulo-dos", "capitulo-dos-2", "capitulo-dos-3", "capitulo-dos-4",
    "capitulo-fin", "relleno-2",
  ]);
  const tags = [...doc.matchAll(/<section class="page" id="([^"]+)"[^>]*>/g)].map((m) => m[0]);
  for (const t of tags) {
    if (t.includes('id="portada"')) assert.doesNotMatch(t, /inert|aria-hidden/);
    else assert.match(t, / inert aria-hidden="true">$/);
  }
  assert.match(tags[0], /data-kind="cover" data-label="Portada"/);
  assert.match(doc, /<section class="page" id="capitulo-uno-2" data-kind="title-text" data-label="Capítulo 1, Uno &lt;b&gt;, página 2"/);
  assert.equal((doc.match(/<dialog class="zoom"/g) || []).length, 1);
  assert.match(doc, /<p id="anuncio" class="sr-only" aria-live="polite"><\/p>/);
  assert.match(doc, /<noscript>[\s\S]*Activa JavaScript para pasar las páginas[\s\S]*<\/noscript>/);
  assert.doesNotMatch(doc, /<script (?!type="module" src="\/assets\/book\.js")/);
  assert.match(doc, /<link rel="stylesheet" href="\/assets\/themes\.css">\s*<link rel="stylesheet" href="\/assets\/book\.css">/);
});

test("bar uses fixed labels and pages have no page-nav", async () => {
  const doc = await html();
  const bar = doc.match(/<nav class="bar"[\s\S]*?<\/nav>/)[0];
  assert.match(bar, /class="nav prev" aria-label="Página anterior"/);
  assert.match(bar, /class="nav next" aria-label="Página siguiente"/);
  assert.match(bar, />Índice<\/button>/);
  assert.doesNotMatch(doc, /class="page-nav"/);
});

test("Cover: title, subtitle, one eager hero photo and the Abrir hint, nothing else", async () => {
  const cover = await section("portada");
  assert.match(cover, /<h1 class="cover-title fit">Álbum de prueba<\/h1>/);
  assert.match(cover, /<p class="subtitle">Volumen I<\/p>/);
  assert.match(cover, /<p class="open-hint">Abrir<\/p>/);
  assert.equal((cover.match(/<img /g) || []).length, 1);
  assert.match(cover, /class="cover-hero"/);
  assert.match(cover, /loading="eager" fetchpriority="high"/);
  assert.doesNotMatch(cover, /<video|<button|<figcaption/);
  assert.equal(((await html()).match(/fetchpriority="high"/g) || []).length, 1);
});

test("heading lines and teaser", async () => {
  assert.match(await section("capitulo-uno-2"), /<p class="eyebrow">Volumen I · Capítulo 1<\/p>/);
  assert.match(await section("capitulo-dos-2"), /<p class="eyebrow">Volumen I · Capítulo 2<\/p>/);
  assert.match(await section("capitulo-prologo-2"), /<p class="eyebrow">Prólogo<\/p>/);
  const fin = await section("capitulo-fin");
  assert.match(fin, /<h2 class="teaser-title">Continuará…<\/h2>/);
  assert.doesNotMatch(fin, /<img|<figure|Capítulo \d|<video/);
});

test("TOC lists every entry with a hash link, no thumbnails; the teaser row has no img", async () => {
  const toc = await section("indice");
  assert.doesNotMatch(toc, /<img|<picture/);
  assert.match(toc, /<h2 class="toc-heading">Índice<\/h2>/);
  for (const id of ["capitulo-prologo", "capitulo-uno", "capitulo-dos", "capitulo-fin"]) {
    assert.match(toc, new RegExp(`<a class="toc-row" href="#${id}">`));
  }
  const row = toc.match(/<li class="toc-item toc-teaser">[\s\S]*?<\/li>/)[0];
  assert.doesNotMatch(row, /<img|alt=|toc-date|\d/);
  const unoRow = toc.match(/<li class="toc-item toc-chapter">[\s\S]*?<\/li>/g).find((r) => r.includes("Uno"));
  assert.match(unoRow, /Capítulo 1[\s\S]*Uno &lt;b&gt;[\s\S]*Jue 1 de octubre/);
});

test("absent caption/note/place/date render nothing; present ones are escaped", async () => {
  const dos = (await section("capitulo-dos-2")) + (await section("capitulo-dos"));
  assert.doesNotMatch(dos, /figcaption|class="note|class="place"|class="date"|<footer/);
  const text = await section("capitulo-uno-2");
  assert.match(text, /<h2 class="chapter-title fit">Uno &lt;b&gt;<\/h2>/);
  assert.match(text, /<p class="date">Jue 1 de octubre<\/p>/);
  assert.match(text, /<p class="place">Tepic<\/p>/);
  assert.match(text, /<div class="note fit"><p>Nota uno<\/p><\/div>/);
  assert.match(await section("capitulo-uno"), /<figcaption class="fit">Con pie<\/figcaption>/);
  const quote = await section("capitulo-uno-4");
  assert.match(quote, /<blockquote class="quote fit">\s*<p>Me agradó<\/p>\s*<footer>1 de octubre<\/footer>/);
  assert.doesNotMatch(await section("capitulo-prologo-2"), /class="date"|class="place"|class="note/);
});

test("pictures: lazy except the Cover hero, pair on one Page, alt fallbacks, sizes", async () => {
  const doc = await html();
  const imgs = doc.match(/<img [^>]*>/g);
  assert.equal(imgs.filter((i) => /loading="eager"/.test(i)).length, 1);
  assert.ok(imgs.every((i) => /width="\d+" height="\d+"/.test(i) && /alt="[^"]+"/.test(i)));
  const pair = (await section("capitulo-uno-3")).match(/<div class="pair">[\s\S]*<\/div>/)[0];
  assert.equal((pair.match(/<figure/g) || []).length, 2);
  assert.match(pair, /alt="Foto del capítulo 1"/);
  assert.match(pair, /sizes="\(min-width: 768px\) and \(min-aspect-ratio: 1\/1\) 44vw, 94vw"/);
  assert.match(pair, /<source type="image\/webp" srcset="[^"]+\.webp \d+w/);
  const uno = await section("capitulo-uno");
  assert.match(uno, /alt="Foto del capítulo 1"/);
  assert.match(uno, /loading="lazy"/);
});

test("prologue hero emits only variants up to maxWidth", async () => {
  const cover = await section("portada");
  assert.doesNotMatch(cover, /-1200\./);
  assert.match(await section("capitulo-prologo"), /alt="Foto del prólogo"/);
});

test("video renders inline autoplay video with Sonido button and no mp4 link", async () => {
  const dos = await section("capitulo-dos");
  const tag = dos.match(/<video[^>]*>/)[0];
  for (const a of ["muted", "autoplay", "loop", "playsinline"]) assert.match(tag, new RegExp(`\\b${a}\\b`));
  assert.match(tag, /preload="metadata"/);
  assert.match(tag, /width="\d+" height="\d+"/);
  assert.match(tag, /poster="\/m\/[0-9a-f]{12}-\d+\.jpg"/);
  assert.doesNotMatch(tag, /controls/);
  assert.match(dos, /<source src="\/m\/[0-9a-f]{12}\.mp4" type="video\/mp4">/);
  assert.match(dos, /<button type="button" class="vbtn v-sound" aria-label="Sonido" aria-pressed="false" data-no-swipe>/);
  assert.match(dos, />Sonido<\/span>/);
  assert.doesNotMatch(dos, /<a [^>]*href="[^"]*\.mp4"/);
  assert.equal(((await html()).match(/<video/g) || []).length, 1);
});

test("letters: figure.frame-letter with a link to the full image, no caption, one shared dialog", async () => {
  const doc = await html();
  const l3 = await section("capitulo-dos-3");
  const l4 = await section("capitulo-dos-4");
  assert.equal((doc.match(/<figure class="frame-letter">/g) || []).length, 2);
  assert.match(l3, /<a class="zoom-open" href="\/m\/[0-9a-f]{12}-1800\.jpg" data-zoom="\/m\/[0-9a-f]{12}-1800\.jpg"/);
  assert.match(l4, /alt="Carta, hoja 2"/);
  assert.doesNotMatch(l3 + l4, /figcaption|alt=""/);
  assert.equal((doc.match(/<dialog/g) || []).length, 1);
});

test("Themes: data-theme on every Chapter Page including blanks; none on Cover and TOC", async () => {
  const doc = await html();
  const themeOf = (id) => (doc.match(new RegExp(`<section class="page" id="${id}"[^>]*>`))[0].match(/data-theme="([^"]+)"/) || [])[1];
  assert.equal(themeOf("portada"), undefined);
  assert.equal(themeOf("indice"), undefined);
  assert.equal(themeOf("relleno-1"), undefined);
  for (const id of ["capitulo-prologo", "capitulo-prologo-2", "capitulo-fin", "relleno-2"]) assert.equal(themeOf(id), "crema", id);
  for (const id of ["capitulo-uno", "capitulo-uno-2", "capitulo-uno-3", "capitulo-uno-4"]) assert.equal(themeOf(id), "rosa", id);
  for (const id of ["capitulo-dos", "capitulo-dos-2", "capitulo-dos-3", "capitulo-dos-4"]) assert.equal(themeOf(id), "salvia", id);
  assert.doesNotMatch(doc, /style="[^"]*(color|background)/i);
  const css = await fs.readFile(path.join(out, "assets", "themes.css"), "utf8");
  assert.match(css, /:root \{ --paper: #f4ead7;/);
  assert.equal((css.match(/\[data-theme="/g) || []).length, 8);
  await assert.rejects(fs.access(path.join(out, "assets", "themes.css.njk")));
});

test("Legacy URLs redirect to the Hash_Routes; the 404 has no book script", async () => {
  const idx = await html("indice");
  assert.match(idx, /<html lang="es">/);
  assert.match(idx, /<meta name="robots" content="noindex,nofollow,noarchive">/);
  assert.match(idx, /<meta http-equiv="refresh" content="0;url=\/#indice">/);
  assert.match(idx, /<a class="button" href="\/#indice">Abrir el álbum<\/a>/);
  assert.match(idx, /href="\/assets\/book\.css"/);
  const uno = await html("capitulo/uno");
  assert.match(uno, /<meta http-equiv="refresh" content="0;url=\/#capitulo-uno">/);
  assert.match(uno, /href="\/#capitulo-uno">Abrir el álbum</);
  for (const slug of ["prologo", "dos", "fin"]) await html(`capitulo/${slug}`);
  const nf = await fs.readFile(path.join(out, "404.html"), "utf8");
  assert.match(nf, /Esta página no existe/);
  assert.doesNotMatch(nf, /book\.js/);
});

test("build-manifest.json is { buildId, ids, media, shell } with ids equal to the Page ids", async () => {
  const bm = JSON.parse(await fs.readFile(path.join(out, "build-manifest.json"), "utf8"));
  assert.deepEqual(Object.keys(bm), ["buildId", "ids", "media", "shell"]);
  assert.match(bm.buildId, /^[0-9a-f]{12}$/);
  const doc = await html();
  assert.deepEqual(bm.ids, [...doc.matchAll(/<section class="page" id="([^"]+)"/g)].map((m) => m[1]));
  assert.ok(bm.shell.includes("/") && bm.shell.includes("/assets/themes.css") && bm.shell.includes("/assets/book.js"));
  assert.ok(bm.shell.every((u) => u === "/" || u.startsWith("/assets/")));
});
