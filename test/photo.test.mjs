import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { processPhoto, photoClass } from "../lib/media/photo.mjs";

let dir, wide, small, rotated;

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "photo-test-"));
  const mk = (w, h) =>
    sharp({ create: { width: w, height: h, channels: 3, background: "#c88" } }).jpeg().toBuffer();
  wide = await mk(1300, 650);
  small = await mk(300, 200);
  // 600x300 stored with EXIF orientation 6 -> displays as 300x600
  rotated = await sharp({ create: { width: 600, height: 300, channels: 3, background: "#468" } })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .toBuffer();
});
after(() => fs.rm(dir, { recursive: true, force: true }));

test("class order: letter, maxWidth, normal", () => {
  assert.equal(photoClass({ frame: "letter", maxWidth: 800 }), "letter");
  assert.equal(photoClass({ maxWidth: 800 }), "maxWidth");
  assert.equal(photoClass({}), "normal");
});

test("normal emits 480/800/1200 in webp and jpg", async () => {
  const r = await processPhoto({ input: wide, outDir: path.join(dir, "a"), key12: "k1" });
  const ws = r.variants.filter((v) => v.format === "webp").map((v) => v.width);
  assert.deepEqual(ws, [480, 800, 1200]);
  assert.equal(r.variants.filter((v) => v.format === "jpg").length, 3);
  await fs.access(path.join(dir, "a", "k1-800.webp"));
});

test("maxWidth caps variants; letter uses 800/1200/1800 on large source", async () => {
  const m = await processPhoto({ input: wide, outDir: path.join(dir, "b"), key12: "k2", maxWidth: 800 });
  assert.deepEqual(m.variants.filter((v) => v.format === "webp").map((v) => v.width), [480, 800]);
  const big = await sharp({ create: { width: 2000, height: 100, channels: 3, background: "#fff" } }).png().toBuffer();
  const l = await processPhoto({ input: big, outDir: path.join(dir, "c"), key12: "k3", frame: "letter" });
  assert.deepEqual(l.variants.filter((v) => v.format === "webp").map((v) => v.width), [800, 1200, 1800]);
});

test("small source emits only reachable widths, at least one", async () => {
  const r = await processPhoto({ input: small, outDir: path.join(dir, "d"), key12: "k4" });
  assert.deepEqual(r.variants.filter((v) => v.format === "webp").map((v) => v.width), [300]);
});

test("EXIF orientation applied, metadata stripped", async () => {
  const r = await processPhoto({ input: rotated, outDir: path.join(dir, "e"), key12: "k5" });
  const v = r.variants.find((x) => x.format === "jpg");
  assert.equal(v.width, 300);
  assert.equal(v.height, 600);
  const meta = await sharp(path.join(dir, "e", v.file)).metadata();
  assert.equal(meta.exif, undefined);
  assert.ok(!meta.orientation || meta.orientation === 1);
});

test("over budget is a warning, not fatal", async () => {
  const w = 900, h = 900;
  const noise = Buffer.alloc(w * h * 3);
  for (let i = 0; i < noise.length; i++) noise[i] = (i * 2654435761) >>> 24;
  const input = await sharp(noise, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
  const r = await processPhoto({ input, outDir: path.join(dir, "f"), key12: "k6", name: "ruido" });
  assert.ok(r.warnings.length > 0);
  assert.ok(r.heavy.length > 0);
});
