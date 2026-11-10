import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import fc from "fast-check";
import { processPhoto, PHOTO_TABLE } from "../lib/media/photo.mjs";

let dir;
let n = 0;
const fresh = () => ({ outDir: path.join(dir, `o${n}`), key12: `k${n++}` });

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "photo-prop-"));
});
after(() => fs.rm(dir, { recursive: true, force: true }));

const GPS = {
  IFD3: {
    GPSLatitudeRef: "N",
    GPSLatitude: "19/1 25/1 0/1",
    GPSLongitudeRef: "W",
    GPSLongitude: "99/1 8/1 0/1",
  },
};

/** JPEG with orientation, optional GPS EXIF, optional trailing bytes (MVIMG-like). */
async function makeJpeg({ w, h, orientation, gps, trailing }) {
  const exif = gps ? GPS : undefined;
  let buf = await sharp({ create: { width: w, height: h, channels: 3, background: "#3a7" } })
    .jpeg()
    .withMetadata({ orientation, ...(exif ? { exif } : {}) })
    .toBuffer();
  if (trailing > 0) buf = Buffer.concat([buf, Buffer.alloc(trailing, 0x41)]);
  return buf;
}

const bytesFor = (variants, format, width) =>
  variants.filter((v) => v.format === format && v.width === width);

// Feature: digital-album, Property 12: Photo derivative invariants
test("Property 12: derivative invariants (widths, both formats, orientation, no EXIF, no trailer)", async () => {
  // Validates: Requirements 6.1, 6.3, 23.5
  await fc.assert(
    fc.asyncProperty(
      fc.record({
        w: fc.integer({ min: 1, max: 64 }),
        h: fc.integer({ min: 1, max: 64 }),
        orientation: fc.integer({ min: 1, max: 8 }),
        gps: fc.boolean(),
        trailing: fc.oneof(fc.constant(0), fc.integer({ min: 1, max: 300 })),
      }),
      async (spec) => {
        const input = await makeJpeg(spec);
        const swap = spec.orientation >= 5;
        const srcW = swap ? spec.h : spec.w;
        const srcH = swap ? spec.w : spec.h;
        const { outDir, key12 } = fresh();
        const r = await processPhoto({ input, outDir, key12 });

        const widths = [...new Set(r.variants.map((v) => v.width))];
        assert.ok(widths.length >= 1);
        for (const w of widths) {
          assert.ok(w <= srcW, `width ${w} > source ${srcW}`);
          assert.equal(bytesFor(r.variants, "webp", w).length, 1);
          assert.equal(bytesFor(r.variants, "jpg", w).length, 1);
        }
        for (const v of r.variants) {
          // aspect ratio of the rotated source preserved (up to rounding)
          assert.ok(Math.abs(v.width / v.height - srcW / srcH) <= 1 / v.height + 1e-9 + 1 / v.width);
          const file = path.join(outDir, v.file);
          const data = await fs.readFile(file);
          const m = await sharp(data).metadata();
          assert.equal(m.width, v.width);
          assert.equal(m.height, v.height);
          assert.equal(m.exif, undefined);
          assert.ok(!m.orientation || m.orientation === 1);
          if (v.format === "jpg") {
            assert.equal(data.at(-2), 0xff);
            assert.equal(data.at(-1), 0xd9); // EOI is the last byte: no trailer
          } else {
            assert.equal(data.readUInt32LE(4) + 8, data.length); // RIFF size == file size
          }
        }
        // Full-size (unscaled) case: dimensions show the rotation was applied.
        const full = r.variants.find((v) => v.width === srcW);
        if (full) assert.equal(full.height, srcH);
      },
    ),
    { numRuns: 100 },
  );
});

// Noise image; amplitude controls entropy so the ladder lands on different steps.
function noisePng(w, h, amp, seed) {
  const buf = Buffer.alloc(w * h * 3);
  let s = seed >>> 0 || 1;
  for (let i = 0; i < buf.length; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    buf[i] = 128 + (((s >>> 24) % (2 * amp + 1)) - amp);
  }
  return sharp(buf, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

async function ref(input, width, format, quality, extra = {}) {
  const p = sharp(input).rotate().resize({ width, fit: "inside", withoutEnlargement: true }).toColourspace("srgb");
  return (format === "webp" ? p.webp({ quality }) : p.jpeg({ quality, ...extra })).toBuffer();
}

// Feature: digital-album, Property 13: Compression ladder
test("Property 13: normal ladder picks first step within budget, never fails; letter is fixed", async () => {
  // Validates: Requirements 6.4, 13.9, 19.2
  const t = PHOTO_TABLE.normal;
  const steps = new Set();
  // Reduced numRuns (20): each run encodes several 800-1200 px images; 100 runs would take minutes.
  await fc.assert(
    fc.asyncProperty(
      fc.record({
        w: fc.constant(800),
        // High-entropy noise: 800 px WebP lands near the 250 KB budget for h in ~450-750,
        // so q72, q65, q58 and the over-budget case are all reachable.
        // second arm concentrates on the narrow window where q72 is over budget but q65 fits
        h: fc.oneof(fc.integer({ min: 450, max: 750 }), fc.integer({ min: 515, max: 560 })),
        amp: fc.constantFrom(125, 126, 127),
        seed: fc.integer({ min: 1, max: 2 ** 31 }),
      }),
      async ({ w, h, amp, seed }) => {
        const input = await noisePng(w, h, amp, seed);
        const { outDir, key12 } = fresh();
        const r = await processPhoto({ input, outDir, key12 }); // must not throw

        // Expected WebP quality from an independent ladder walk at 800 px.
        let expected = t.webpLadder.at(-1);
        let over = true;
        for (const q of t.webpLadder) {
          if ((await ref(input, 800, "webp", q)).length <= t.webpBudget) {
            expected = q;
            over = false;
            break;
          }
        }
        steps.add(expected + (over ? "!" : ""));
        const kept = await fs.readFile(path.join(outDir, `${key12}-800.webp`));
        const want = await ref(input, 800, "webp", expected);
        assert.ok(kept.equals(want), `800px webp is not q${expected} (amp ${amp}, ${w}x${h})`);
        const webpWarn = r.heavy.filter((x) => x.format === "webp");
        assert.equal(webpWarn.length, over ? 1 : 0);
        assert.equal(r.warnings.length, r.heavy.length);
        if (over) assert.ok(kept.length > t.webpBudget);
        else assert.ok(kept.length <= t.webpBudget);
      },
    ),
    { numRuns: 20 },
  );
  console.log("  ladder steps exercised:", [...steps].join(", "));
});

test("Property 13: letter frame uses fixed settings (q86 webp, q88 4:4:4 jpeg), no ladder, no warnings", async () => {
  // Validates: Requirements 19.2
  await fc.assert(
    fc.asyncProperty(
      fc.record({
        w: fc.integer({ min: 1, max: 64 }),
        h: fc.integer({ min: 1, max: 64 }),
        amp: fc.integer({ min: 1, max: 127 }),
        seed: fc.integer({ min: 1, max: 2 ** 31 }),
      }),
      async ({ w, h, amp, seed }) => {
        const input = await noisePng(w, h, amp, seed);
        const { outDir, key12 } = fresh();
        const r = await processPhoto({ input, outDir, key12, frame: "letter" });
        assert.equal(r.cls, "letter");
        assert.deepEqual(r.warnings, []);
        assert.deepEqual(r.heavy, []);
        for (const v of r.variants) {
          const got = await fs.readFile(path.join(outDir, v.file));
          const want =
            v.format === "webp"
              ? await ref(input, v.width, "webp", 86)
              : await ref(input, v.width, "jpg", 88, { mozjpeg: true, progressive: true, chromaSubsampling: "4:4:4" });
          assert.ok(got.equals(want), `${v.file} differs from fixed letter settings`);
        }
      },
    ),
    { numRuns: 100 },
  );
});

// Feature: digital-album, Property 14: maxWidth caps variants
test("Property 14: every variant width is at most maxWidth", async () => {
  // Validates: Requirements 6.2, 6.6
  // Solid-colour images are cheap, so wide sources (up to 1500 px) are fine here.
  await fc.assert(
    fc.asyncProperty(
      fc.constantFrom(480, 800, 1200),
      fc.integer({ min: 1, max: 1500 }),
      fc.integer({ min: 1, max: 40 }),
      async (maxWidth, w, h) => {
        const input = await sharp({ create: { width: w, height: h, channels: 3, background: "#ccd" } })
          .jpeg()
          .toBuffer();
        const { outDir, key12 } = fresh();
        const r = await processPhoto({ input, outDir, key12, maxWidth });
        assert.equal(r.cls, "maxWidth");
        assert.ok(r.variants.length >= 2);
        for (const v of r.variants) assert.ok(v.width <= maxWidth, `${v.width} > ${maxWidth}`);
        assert.ok(r.variants.every((v) => v.width <= w));
      },
    ),
    { numRuns: 100 },
  );
});
