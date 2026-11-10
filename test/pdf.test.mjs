import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { expandPdf, pdfPageCount, resolvePages } from "../lib/media/pdf.mjs";

/** Minimal valid PDF with `n` blank pages (200 x 300 pt). */
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

let dir, two, three, one;
before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-test-"));
  two = path.join(dir, "Para Manuel .pdf"); // spaces on purpose
  three = path.join(dir, "tres paginas.pdf");
  one = path.join(dir, "una .pdf");
  await fs.writeFile(two, makePdf(2));
  await fs.writeFile(three, makePdf(3));
  await fs.writeFile(one, makePdf(1));
});
after(() => fs.rm(dir, { recursive: true, force: true }));

test("pdfinfo page count, with spaces in the name", async () => {
  assert.equal(await pdfPageCount(two), 2);
  assert.equal(await pdfPageCount(three), 3);
});

test("resolvePages: unset is all, out of range names PDF and page, max 30", () => {
  assert.deepEqual(resolvePages({ pageCount: 3, name: "a.pdf" }), [1, 2, 3]);
  assert.throws(() => resolvePages({ pages: [1, 4], pageCount: 3, name: "a.pdf" }), /a\.pdf.*4/);
  assert.throws(() => resolvePages({ pages: [0], pageCount: 3, name: "a.pdf" }), /a\.pdf/);
  assert.throws(() => resolvePages({ pageCount: 31, name: "big.pdf" }), /big\.pdf.*30/);
});

test("expands letter PDF into letter photo items with exact page-N.png", async () => {
  const cacheRoot = path.join(dir, "cache");
  const r = await expandPdf({
    file: two, pages: [1, 2], alt: "Carta de Karla, hoja {n}", cacheRoot,
    outDir: path.join(dir, "out"),
  });
  assert.deepEqual(r.openItems, []);
  assert.deepEqual(r.items.map((i) => i.alt), ["Carta de Karla, hoja 1", "Carta de Karla, hoja 2"]);
  for (const [i, item] of r.items.entries()) {
    assert.equal(item.type, "photo");
    assert.equal(item.frame, "letter");
    assert.equal(path.basename(item.file), `page-${i + 1}.png`);
    assert.equal(path.basename(path.dirname(path.dirname(item.file))), "pdf");
    assert.equal((await sharp(item.file).metadata()).width, 1800);
    assert.equal(item.processed.cls, "letter");
    assert.deepEqual([...new Set(item.processed.variants.map((v) => v.width))], [800, 1200, 1800]);
  }
});

test("page count other than 2 for a letter PDF goes to open items, pages 1 and 2 used", async () => {
  const r = await expandPdf({ file: three, name: "Para Manuel .pdf", alt: "h {n}", cacheRoot: path.join(dir, "c2") });
  assert.equal(r.openItems.length, 1);
  assert.match(r.openItems[0], /Para Manuel \.pdf.*3/);
  assert.deepEqual(r.pages, [1, 2]);
});

test("non-letter PDF with pages unset expands all pages without open items", async () => {
  const r = await expandPdf({ file: three, frame: undefined, isLetter: false, cacheRoot: path.join(dir, "c3") });
  assert.deepEqual(r.pages, [1, 2, 3]);
  assert.deepEqual(r.openItems, []);
});

test("out-of-range page on a non-letter PDF is an error", async () => {
  await assert.rejects(
    expandPdf({ file: one, isLetter: false, pages: [2], cacheRoot: path.join(dir, "c4") }),
    /una \.pdf.*2/,
  );
});
