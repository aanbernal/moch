import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { scaleDims, MAX_EDGE } from "../lib/media/video.mjs";
import { expandPdf, resolvePages } from "../lib/media/pdf.mjs";
import { run } from "../lib/exec.mjs";

const NUM_RUNS = 100;

/** Minimal valid PDF with `n` blank pages. */
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

// Feature: digital-album, Property 15: Video target dimensions
// Validates: Requirements 7.1
test("Property 15: scaleDims long edge <= 960, even, not larger than source, aspect kept", () => {
  fc.assert(
    fc.property(fc.integer({ min: 2, max: 8000 }), fc.integer({ min: 2, max: 8000 }), (w, h) => {
      const t = scaleDims(w, h);
      assert.ok(Math.max(t.width, t.height) <= MAX_EDGE, `long edge ${JSON.stringify(t)}`);
      assert.equal(t.width % 2, 0);
      assert.equal(t.height % 2, 0);
      // "Never larger than the source" allows the even rounding of an odd source side (+1).
      assert.ok(t.width <= w + 1 && t.height <= h + 1, `larger than source ${JSON.stringify(t)}`);
      // Short edge within one pixel of the exact aspect-preserving value.
      const landscape = w > h;
      const [long, short] = landscape ? [w, h] : [h, w];
      const [tLong, tShort] = landscape ? [t.width, t.height] : [t.height, t.width];
      // The smallest valid even side is 2, so an ideal below 2 is clamped to 2.
      const ideal = Math.max(2, (short * tLong) / long);
      assert.ok(Math.abs(tShort - ideal) <= 1, `aspect ${JSON.stringify(t)} ideal ${ideal}`);
    }),
    { numRuns: NUM_RUNS },
  );
});

// Feature: digital-album, Property 16: PDF page selection (pure resolvePages)
// Validates: Requirements 19.6
test("Property 16: resolvePages returns the selection in order, all pages when unset", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 30 }),
      fc.option(fc.array(fc.nat(), { maxLength: 30 }), { nil: undefined }),
      (count, raw) => {
        const pages = raw && raw.map((n) => (n % count) + 1);
        const got = resolvePages({ pages, pageCount: count, name: "x.pdf" });
        const expected = pages ?? Array.from({ length: count }, (_, i) => i + 1);
        assert.deepEqual(got, expected);
      },
    ),
    { numRuns: NUM_RUNS },
  );
});

test("Property 16: resolvePages rejects out-of-range pages naming PDF and page", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 30 }),
      fc.oneof(fc.integer({ min: -50, max: 0 }), fc.integer({ min: 31, max: 100 })),
      fc.nat(),
      (count, bad, pos) => {
        const base = Array.from({ length: Math.min(count, 5) }, (_, i) => i + 1);
        const pages = [...base];
        pages.splice(pos % (pages.length + 1), 0, bad);
        const outOfRange = bad < 1 || bad > count;
        if (!outOfRange) return;
        assert.throws(
          () => resolvePages({ pages, pageCount: count, name: "doc.pdf" }),
          (e) => e.message.includes("doc.pdf") && e.message.includes(String(bad)),
        );
      },
    ),
    { numRuns: NUM_RUNS },
  );
});

// Feature: digital-album, Property 16: PDF page selection (real PDFs through expandPdf)
// Validates: Requirements 7.5, 19.6
let dir, pdfs, hasPdftoppm;
before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-prop-"));
  pdfs = {};
  for (const n of [2, 12]) {
    pdfs[n] = path.join(dir, `doc ${n}.pdf`);
    await fs.writeFile(pdfs[n], makePdf(n));
  }
  try {
    hasPdftoppm = (await run("pdftoppm", ["-v"])).code !== undefined && (await run("pdfinfo", ["-v"])).code !== undefined;
  } catch {
    hasPdftoppm = false;
  }
  if (!hasPdftoppm) console.warn("AVISO: pdftoppm/pdfinfo no disponible; se omite la propiedad 16 con PDFs reales");
});
after(() => fs.rm(dir, { recursive: true, force: true }));

test("Property 16: expandPdf yields exactly the selected pages as page-N.png", async (t) => {
  if (!hasPdftoppm) return t.skip("pdftoppm no disponible");
  const cacheRoot = path.join(dir, "cache");
  await fc.assert(
    fc.asyncProperty(
      fc.constantFrom(2, 12),
      fc.option(fc.array(fc.nat(), { minLength: 1, maxLength: 6 }), { nil: undefined }),
      fc.nat(),
      async (count, raw, badSeed) => {
        const file = pdfs[count];
        const opts = { file, name: path.basename(file), isLetter: false, cacheRoot };
        const pages = raw && raw.map((n) => (n % count) + 1);
        const r = await expandPdf({ ...opts, pages });
        const expected = pages ?? Array.from({ length: count }, (_, i) => i + 1);
        assert.deepEqual(r.items.map((i) => i.page), expected);
        assert.deepEqual(r.items.map((i) => path.basename(i.file)), expected.map((n) => `page-${n}.png`));

        const bad = badSeed % 2 ? count + 1 + (badSeed % 7) : 0;
        await assert.rejects(
          expandPdf({ ...opts, pages: [1, bad] }),
          (e) => e.message.includes(path.basename(file)) && e.message.includes(String(bad)),
        );
      },
    ),
    { numRuns: NUM_RUNS },
  );
});
