import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import sharp from "sharp";
import { runMedia } from "../scripts/media.mjs";

let tmp;
let counter = 0;
const jpgs = new Map(); // "r-g-b-w-h" -> Buffer
const quiet = { log: () => {} };

const colorArb = fc.record({
  r: fc.integer({ min: 0, max: 255 }),
  g: fc.integer({ min: 0, max: 255 }),
  b: fc.integer({ min: 0, max: 255 }),
  w: fc.integer({ min: 16, max: 48 }),
  h: fc.integer({ min: 16, max: 48 }),
});
const keyOf = (c) => `${c.r}-${c.g}-${c.b}-${c.w}-${c.h}`;

async function jpeg(c) {
  const k = keyOf(c);
  if (!jpgs.has(k)) {
    jpgs.set(k, await sharp({
      create: { width: c.w, height: c.h, channels: 3, background: { r: c.r, g: c.g, b: c.b } },
    }).jpeg().toBuffer());
  }
  return jpgs.get(k);
}

/** chapters: [{slug, photos: [color,...]}]; created in `order` (indexes). */
async function writeContent(root, chapters, order = chapters.map((_, i) => i)) {
  for (const i of order) {
    const ch = chapters[i];
    const dir = path.join(root, "chapters", ch.slug);
    await fs.mkdir(path.join(dir, "media"), { recursive: true });
    const media = [];
    for (let p = 0; p < ch.photos.length; p++) {
      const file = `f${p}.jpg`;
      await fs.writeFile(path.join(dir, "media", file), await jpeg(ch.photos[p]));
      media.push({ type: "photo", file });
    }
    await fs.writeFile(
      path.join(dir, "chapter.json"),
      JSON.stringify({
        schema: 1, order: i + 1, kind: "chapter", title: ch.slug,
        cover: ch.cover ?? "f0.jpg", media: ch.media ?? media,
      }),
    );
  }
}

const dirs = () => {
  const n = counter++;
  return {
    content: path.join(tmp, `content-${n}`),
    build: path.join(tmp, `build-${n}`),
    cache: path.join(tmp, `cache-${n}`),
  };
};

const exists = (p) => fs.access(p).then(() => true, () => false);

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "media-prop-"));
});
after(() => fs.rm(tmp, { recursive: true, force: true }));

const chaptersArb = fc
  .array(fc.array(colorArb, { minLength: 1, maxLength: 3 }), { minLength: 1, maxLength: 3 })
  .map((sets) => sets.map((photos, i) => ({ slug: `cap-${i}`, photos })));

// Feature: digital-album, Property 4: Validation precedes processing
// Validates: Requirements 4.1, 4.2, 4.3
test("Property 4: invalid content exits non-zero and writes nothing", async () => {
  // Cheap (validation fails before any processing): full 100 runs.
  const breakArb = fc.constantFrom(
    (ch) => { ch.cover = "missing.jpg"; },                       // cover not in media
    (ch) => { ch.media = [{ type: "photo", file: "nope.jpg" }]; }, // referenced file absent
    (ch) => { ch.media = [{ type: "photo", file: "F0.JPG" }]; },   // case mismatch
  );
  await fc.assert(
    fc.asyncProperty(chaptersArb, fc.nat(), breakArb, async (chapters, pick, brk) => {
      const d = dirs();
      brk(chapters[pick % chapters.length]);
      await writeContent(d.content, chapters);
      const exit = process.exit;
      const err = console.error;
      let code;
      process.exit = (c) => { code = c; throw new Error("exit"); };
      console.error = () => {};
      try {
        await assert.rejects(runMedia({ contentDir: d.content, buildDir: d.build, cacheDir: d.cache, ...quiet }));
      } finally {
        process.exit = exit;
        console.error = err;
      }
      assert.ok(code !== undefined && code !== 0);
      assert.equal(await exists(d.cache), false);
      assert.equal(await exists(path.join(d.build, "media")), false);
      assert.equal(await exists(path.join(d.build, "media-manifest.json")), false);
    }),
    { numRuns: 100 },
  );
});

// Feature: digital-album, Property 17: Pipeline determinism and idempotence
// Validates: Requirements 7.8, 9.4
test("Property 17: two runs are byte-identical, second processes 0, creation order is irrelevant", async () => {
  // Processing-heavy (sharp encodes per run, three pipeline runs per case): 20 runs.
  await fc.assert(
    fc.asyncProperty(
      chaptersArb,
      fc.infiniteStream(fc.nat()).map((s) => s.take(8)),
      async (chapters, rnd) => {
        const d = dirs();
        await writeContent(d.content, chapters);
        const o = { contentDir: d.content, buildDir: d.build, cacheDir: d.cache, ...quiet };
        const r1 = await runMedia(o);
        const m1 = await fs.readFile(path.join(d.build, "media-manifest.json"));
        const files1 = (await fs.readdir(path.join(d.build, "media"))).sort();
        const r2 = await runMedia(o);
        const m2 = await fs.readFile(path.join(d.build, "media-manifest.json"));
        assert.ok(m1.equals(m2));
        assert.equal(r2.stats.processed, 0);
        assert.deepEqual((await fs.readdir(path.join(d.build, "media"))).sort(), files1);
        assert.deepEqual(r1.manifest, r2.manifest);

        // Distinct byte sets processed once each: outputs match unique sources.
        // Shuffled creation order with fresh dirs and cache.
        const order = chapters.map((_, i) => i);
        const nums = [...rnd];
        for (let i = order.length - 1; i > 0; i--) {
          const j = nums[i % nums.length] % (i + 1);
          [order[i], order[j]] = [order[j], order[i]];
        }
        const e = dirs();
        await writeContent(e.content, chapters, order);
        await runMedia({ contentDir: e.content, buildDir: e.build, cacheDir: e.cache, ...quiet });
        const m3 = await fs.readFile(path.join(e.build, "media-manifest.json"));
        assert.ok(m1.equals(m3));

        // Identical bytes across the set produce one set of outputs.
        const unique = new Set(chapters.flatMap((c) => c.photos.map(keyOf))).size;
        assert.equal(r1.stats.processed, unique);
      },
    ),
    { numRuns: 20 },
  );
});
