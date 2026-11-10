import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { run } from "../lib/exec.mjs";
import { runMedia } from "../scripts/media.mjs";

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
  return out;
}

let tmp, content, build, cache;
const quiet = { log: () => {} };
const opts = () => ({ contentDir: content, buildDir: build, cacheDir: cache, ...quiet });

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "media-test-"));
  content = path.join(tmp, "content");
  build = path.join(tmp, "build");
  cache = path.join(tmp, "cache");
  const mediaDir = path.join(content, "chapters", "uno", "media");
  const other = path.join(content, "chapters", "dos", "media");
  await fs.mkdir(mediaDir, { recursive: true });
  await fs.mkdir(other, { recursive: true });

  const jpg = await sharp({
    create: { width: 1000, height: 600, channels: 3, background: { r: 200, g: 120, b: 90 } },
  }).jpeg().toBuffer();
  await fs.writeFile(path.join(mediaDir, "foto.jpg"), jpg);
  await fs.writeFile(path.join(other, "misma.jpg"), jpg); // same bytes in another chapter
  await fs.writeFile(path.join(mediaDir, "carta.pdf"), makePdf(2));
  const v = await run("ffmpeg", [
    "-nostdin", "-y", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=10:duration=2",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", path.join(mediaDir, "clip.mp4"),
  ]);
  assert.equal(v.code, 0, v.stderr);

  await fs.writeFile(
    path.join(content, "chapters", "uno", "chapter.json"),
    JSON.stringify({
      schema: 1, order: 1, kind: "chapter", title: "Uno", cover: "foto.jpg",
      media: [
        { type: "photo", file: "foto.jpg" },
        { type: "video", file: "clip.mp4" },
        { type: "pdf", file: "carta.pdf", alt: "Carta, hoja {n}" },
        { type: "quote", text: "hola" },
      ],
    }),
  );
  await fs.writeFile(
    path.join(content, "chapters", "dos", "chapter.json"),
    JSON.stringify({
      schema: 1, order: 2, kind: "chapter", title: "Dos", cover: "misma.jpg",
      media: [{ type: "photo", file: "misma.jpg" }],
    }),
  );
});

after(() => fs.rm(tmp, { recursive: true, force: true }));

test("builds manifest for photo, video and pdf; same bytes processed once", async () => {
  const { manifest, stats } = await runMedia(opts());
  assert.deepEqual(Object.keys(manifest), ["dos/misma.jpg", "uno/carta.pdf", "uno/clip.mp4", "uno/foto.jpg"]);
  assert.deepEqual(manifest["uno/foto.jpg"], { ...manifest["dos/misma.jpg"] });
  const photo = manifest["uno/foto.jpg"];
  assert.equal(photo.kind, "photo");
  assert.ok(photo.variants.every((v) => /^\/m\/[0-9a-f]{12}-\d+\.(webp|jpg)$/.test(v.url)));
  const video = manifest["uno/clip.mp4"];
  assert.equal(video.kind, "video");
  assert.match(video.url, /^\/m\/[0-9a-f]{12}\.mp4$/);
  assert.ok(video.duration > 1 && video.poster.variants.length > 0);
  const pdf = manifest["uno/carta.pdf"];
  assert.equal(pdf.kind, "pdf");
  assert.deepEqual(pdf.pages.map((p) => p.alt), ["Carta, hoja 1", "Carta, hoja 2"]);
  assert.equal(stats.reused, 0);

  // build/media holds exactly the referenced outputs
  const urls = new Set();
  const collect = (vs) => vs.forEach((v) => urls.add(v.url.slice(3)));
  for (const e of Object.values(manifest)) {
    if (e.variants) collect(e.variants);
    if (e.poster) collect(e.poster.variants);
    if (e.url) urls.add(e.url.slice(3));
    if (e.pages) e.pages.forEach((p) => collect(p.variants));
  }
  const files = await fs.readdir(path.join(build, "media"));
  assert.deepEqual(files.sort(), [...urls].sort());

  const raw = await fs.readFile(path.join(build, "media-manifest.json"), "utf8");
  assert.ok(!/\d{4}-\d\d-\d\dT/.test(raw));
  const report = JSON.parse(await fs.readFile(path.join(build, "media-report.json"), "utf8"));
  assert.deepEqual(Object.keys(report), ["heavy", "openItems", "warnings"]);
});

test("second run reuses the cache and yields identical manifest bytes", async () => {
  const file = path.join(build, "media-manifest.json");
  const before1 = await fs.readFile(file);
  const stale = path.join(build, "media", "stale.txt");
  await fs.writeFile(stale, "x");
  const { stats } = await runMedia(opts());
  assert.equal(stats.processed, 0);
  assert.ok(stats.reused > 0);
  assert.ok(before1.equals(await fs.readFile(file)));
  await assert.rejects(fs.access(stale)); // unreferenced output removed
});

test("zero chapters give an empty manifest", async () => {
  const empty = path.join(tmp, "empty");
  await fs.mkdir(empty);
  const b = path.join(tmp, "build-empty");
  await runMedia({ contentDir: empty, buildDir: b, cacheDir: path.join(tmp, "cache-empty"), ...quiet });
  assert.equal((await fs.readFile(path.join(b, "media-manifest.json"), "utf8")).trim(), "{}");
  assert.deepEqual(await fs.readdir(path.join(b, "media")), []);
});

test("invalid content exits 1 before any processing", async () => {
  const bad = path.join(tmp, "bad");
  const dir = path.join(bad, "chapters", "x");
  await fs.mkdir(path.join(dir, "media"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "chapter.json"),
    JSON.stringify({ schema: 1, order: 1, kind: "chapter", title: "X", cover: "Foto.JPG", media: [{ type: "photo", file: "Foto.JPG" }] }),
  );
  const exit = process.exit;
  const err = console.error;
  let code;
  process.exit = (c) => { code = c; throw new Error("exit"); };
  console.error = () => {};
  try {
    await assert.rejects(runMedia({ contentDir: bad, buildDir: path.join(tmp, "b2"), cacheDir: path.join(tmp, "c2"), ...quiet }));
  } finally {
    process.exit = exit;
    console.error = err;
  }
  assert.equal(code, 1);
  await assert.rejects(fs.access(path.join(tmp, "c2", "x")));
});
