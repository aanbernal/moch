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
const html = (p) => fs.readFile(path.join(out, p, "index.html"), "utf8");

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
      { type: "pdf", file: "carta.pdf", alt: "Carta, hoja {n}", frame: "letter" },
    ] });
  await w("fin", { order: 30, kind: "teaser", title: "Continuará…", media: [] });
  await fs.writeFile(path.join(content, "site.json"), JSON.stringify({ title: "Álbum de prueba", volume: "Volumen I", lang: "es" }));

  const { manifest } = await runMedia({ contentDir: content, buildDir: build, cacheDir: path.join(tmp, "cache"), log: () => {} });
  assert.ok(manifest["dos/clip.mp4"]);
  await eleventy({ CONTENT_DIR: content, MEDIA_MANIFEST: path.join(build, "media-manifest.json") }, out);
});

after(() => fs.rm(tmp, { recursive: true, force: true }));

test("nav labels are fixed; ends go to the TOC", async () => {
  const uno = await html("capitulo/uno");
  assert.match(uno, /<a class="prev" rel="prev" href="\/capitulo\/prologo\/">Anterior<\/a>/);
  assert.match(uno, /<a class="next" rel="next" href="\/capitulo\/dos\/">Siguiente<\/a>/);
  assert.match(uno, />Índice<\/a>/);
  assert.doesNotMatch(uno.split('<nav class="pager"')[1], /Dos|Prólogo del álbum/);
  assert.match(await html("capitulo/prologo"), /rel="prev" href="\/indice\/">Anterior/);
  assert.match(await html("capitulo/fin"), /rel="next" href="\/indice\/">Siguiente/);
});

test("heading lines and teaser", async () => {
  assert.match(await html("capitulo/uno"), /Volumen I · Capítulo 1/);
  assert.match(await html("capitulo/dos"), /Volumen I · Capítulo 2/);
  assert.match(await html("capitulo/prologo"), /class="eyebrow">Prólogo</);
  const fin = await html("capitulo/fin");
  assert.match(fin, /<h1>Continuará…<\/h1>/);
  assert.doesNotMatch(fin, /<img|<figure|Capítulo \d/);
});

test("teaser TOC row has no img and keeps an empty slot", async () => {
  const toc = await html("indice");
  const row = toc.match(/<li class="toc-item toc-teaser">[\s\S]*?<\/li>/)[0];
  assert.doesNotMatch(row, /<img|alt=/);
  assert.match(row, /toc-thumb-empty/);
  assert.match(toc.match(/<li class="toc-item toc-chapter">[\s\S]*?<\/li>/)[0], /<img [^>]*alt="Portada: Uno &lt;b&gt;"/);
});

test("absent caption/note/place render nothing; present ones are escaped", async () => {
  const dos = await html("capitulo/dos");
  assert.doesNotMatch(dos, /figcaption|class="note"|class="place"|class="date"|<footer/);
  const uno = await html("capitulo/uno");
  assert.match(uno, /<figcaption>Con pie<\/figcaption>/);
  assert.equal((uno.match(/<figcaption>/g) || []).length, 1);
  assert.match(uno, /<h1>Uno &lt;b&gt;<\/h1>/);
  assert.match(uno, /<blockquote class="quote">\s*<p>Me agradó<\/p>\s*<footer>1 de octubre<\/footer>/);
});

test("pictures: eager first, lazy rest, pair wrapper, dimensions", async () => {
  const uno = await html("capitulo/uno");
  const imgs = uno.match(/<img [^>]*>/g);
  assert.equal(imgs.length, 3);
  assert.match(imgs[0], /loading="eager" fetchpriority="high"/);
  assert.match(imgs[1], /loading="lazy"/);
  assert.ok(imgs.every((i) => /width="\d+" height="\d+"/.test(i) && /alt="Foto del capítulo 1"/.test(i)));
  assert.match(uno, /<source type="image\/webp" srcset="[^"]+\.webp \d+w/);
  assert.equal((uno.match(/<div class="pair">/g) || []).length, 1);
  assert.match(uno, /sizes="\(min-width: 700px\) 310px, 50vw"/);
  const pair = uno.match(/<div class="pair">[\s\S]*?<\/div>/)[0];
  assert.equal((pair.match(/<figure/g) || []).length, 2);
});

test("prologue hero emits only variants up to maxWidth", async () => {
  const pro = await html("capitulo/prologo");
  assert.doesNotMatch(pro, /-1200\./);
  assert.match(pro, /alt="Foto del prólogo"/);
  const cover = await fs.readFile(path.join(out, "index.html"), "utf8");
  assert.match(cover, /class="cover-hero"/);
  assert.match(cover, /loading="eager" fetchpriority="high"/);
});

test("video attributes", async () => {
  const dos = await html("capitulo/dos");
  const tag = dos.match(/<video[^>]*>/)[0];
  assert.match(tag, /\bcontrols\b/);
  assert.match(tag, /\bplaysinline\b/);
  assert.match(tag, /preload="none"/);
  assert.match(tag, /poster="\/m\/[0-9a-f]{12}-\d+\.jpg"/);
  assert.match(tag, /width="\d+" height="\d+"/);
  assert.doesNotMatch(tag, /autoplay|muted/);
});

test("letters: figure.frame-letter with link and dialog", async () => {
  const dos = await html("capitulo/dos");
  assert.equal((dos.match(/<figure class="frame-letter">/g) || []).length, 2);
  assert.equal((dos.match(/<dialog class="zoom"/g) || []).length, 2);
  assert.match(dos, /<a class="zoom-open" href="\/m\/[0-9a-f]{12}-1800\.jpg"/);
  assert.match(dos, /alt="Carta, hoja 2"/);
  assert.doesNotMatch(dos, /alt=""/);
});
