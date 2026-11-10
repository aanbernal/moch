import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { slugify, slugifyFileName } from "../lib/slug.mjs";
import {
  parseChapter, serializeChapter, applyEdits, updateMediaItem, isDefinitive, setDefinitive,
  editNote, editCaption, defaultOrder, orderBefore, removeMediaItem, coverProblem, setCover,
  newFolderName, randomSuffix,
} from "../src/admin/model.js";
import {
  validateUpload, planUploads, uniqueName, classify, base64Size, MB, LIMITS, MSG,
} from "../src/admin/uploads.js";
import { drawFlattened, prepareImage, chooseDecoded, targetSize, jpegName } from "../src/admin/image-prep.js";

const sample = {
  schema: 1, order: 30, kind: "chapter", title: "La primera cita", note: "Texto", draft: true,
  cover: "a.jpg", futureKey: { x: [1, 2] },
  media: [
    { type: "photo", file: "a.jpg", alt: "", caption: "", extra: 1 },
    { type: "video", file: "v.mp4" },
  ],
};
const text = JSON.stringify(sample, null, 2) + "\n";

test("round trip keeps bytes, key order and unknown keys", () => {
  assert.equal(serializeChapter(parseChapter(text)), text);
  const out = applyEdits(parseChapter(text), { title: "La primera cita" });
  assert.equal(serializeChapter(out), text);
});

test("only edited fields change; new keys are appended", () => {
  const out = applyEdits(sample, { place: "Tepic", title: "Otra" });
  assert.deepEqual(Object.keys(out), [...Object.keys(sample), "place"]);
  assert.equal(out.title, "Otra");
  assert.deepEqual(out.futureKey, sample.futureKey);
  assert.equal(sample.title, "La primera cita"); // input not mutated
  const m = updateMediaItem(sample, 0, { alt: "x" });
  assert.equal(m.media[0].extra, 1);
  assert.deepEqual(Object.keys(m.media[0]), Object.keys(sample.media[0]));
});

test("property: no-op edits never change serialization", () => {
  fc.assert(fc.property(fc.dictionary(fc.string({ minLength: 1, maxLength: 6 }), fc.jsonValue()), (obj) => {
    const t = serializeChapter(obj);
    return serializeChapter(applyEdits(parseChapter(t), {})) === t;
  }));
});

test("draft is bound to Texto definitivo, with auto-tick", () => {
  assert.equal(isDefinitive(sample), false);
  assert.equal(setDefinitive(sample, true).draft, false);
  assert.equal(editNote(sample, "Nuevo").draft, false);
  assert.equal(editNote(sample, "Texto").draft, true); // unchanged note: no tick
  assert.equal(editCaption(sample, 0, "Hola").draft, false);
  assert.equal(editCaption(sample, 0, "").draft, true);
  const noDraftKey = { ...sample };
  delete noDraftKey.draft;
  assert.equal(isDefinitive(noDraftKey), true);
  assert.equal(editNote(noDraftKey, "z").draft, undefined);
});

const chapters = [
  { slug: "p", order: 0, kind: "prologue" },
  { slug: "a", order: 10, kind: "chapter" },
  { slug: "b", order: 20, kind: "chapter" },
  { slug: "t", order: 30, kind: "teaser" },
];

test("default order: before teaser, else max+10", () => {
  assert.deepEqual(defaultOrder(chapters), { order: 25, renumbered: {} });
  assert.deepEqual(defaultOrder(chapters.slice(0, 3)), { order: 30, renumbered: {} });
  assert.equal(defaultOrder([]).order, 10);
});

test("insert before: first, midpoint", () => {
  assert.equal(orderBefore(chapters, "p").order, -10);
  assert.equal(orderBefore(chapters, "b").order, 15);
});

test("insert before renumbers to multiples of 10 on float exhaustion", () => {
  const tight = [
    { slug: "p", order: 0, kind: "prologue" },
    { slug: "a", order: 1, kind: "chapter" },
    { slug: "b", order: 1 + Number.EPSILON, kind: "chapter" },
    { slug: "c", order: 50, kind: "chapter" },
  ];
  const r = orderBefore(tight, "b");
  assert.equal(r.order, 20);
  assert.deepEqual(r.renumbered, { a: 10, b: 30, c: 40 });
  assert.throws(() => orderBefore(chapters, "zz"));
});

test("deleting the cover item forces a new cover", () => {
  const r = removeMediaItem(sample, 0);
  assert.equal(r.needsNewCover, true);
  assert.equal("cover" in r.chapter, false);
  assert.deepEqual(r.candidates, ["v.mp4"]);
  assert.ok(coverProblem(r.chapter));
  assert.equal(coverProblem(setCover(r.chapter, "v.mp4")), null);
  assert.equal(removeMediaItem(sample, 1).needsNewCover, false);
  assert.throws(() => setCover(sample, "nope.jpg"));
  const teaser = { kind: "teaser", media: [] };
  assert.equal(coverProblem(teaser), null);
});

test("folder name is slugify(title)-xxxx", () => {
  const n = newFolderName("La primera cita", slugify);
  assert.match(n, /^la-primera-cita-[a-z0-9]{4}$/);
  assert.match(randomSuffix(), /^[a-z0-9]{4}$/);
  assert.equal(newFolderName("Á", slugify, () => 0), "a-aaaa");
});

// ---- uploads ----

test("allow-list and HEIC rejection", () => {
  assert.equal(classify("A.JPG"), "photo");
  assert.equal(classify("x.mov"), "video");
  assert.equal(classify("x.pdf"), "pdf");
  assert.equal(classify("x.gif"), null);
  assert.deepEqual(validateUpload({ name: "x.HEIC", size: 1 }).errors, [MSG.heic]);
  assert.equal(validateUpload({ name: "x.gif", size: 1 }).errors.length, 1);
});

test("video and pdf limits", () => {
  assert.equal(validateUpload({ name: "v.mp4", size: 5 * MB }).errors.length, 0);
  const warn = validateUpload({ name: "v.mp4", size: 13 * MB });
  assert.equal(warn.errors.length, 0);
  assert.match(warn.warnings[0], /12 MB/);
  assert.match(validateUpload({ name: "v.mp4", size: 26 * MB }).errors[0], /25 MB/);
  assert.match(validateUpload({ name: "v.mp4", size: MB, duration: 121 }).errors[0], /120 segundos/);
  assert.equal(validateUpload({ name: "v.mp4", size: MB, duration: null }).errors.length, 0);
  assert.match(validateUpload({ name: "c.pdf", size: 26 * MB }).errors[0], /25 MB/);
  assert.equal(validateUpload({ name: "c.pdf", size: 24 * MB }).errors.length, 0);
});

test("base64 blob limit of 34 MB", () => {
  assert.equal(base64Size(3), 4);
  // 25 MiB (the largest video/PDF) encodes to ~33.3 MiB and must pass.
  assert.equal(validateUpload({ name: "c.pdf", size: 25 * MB }).errors.length, 0);
  assert.equal(validateUpload({ name: "v.mp4", size: 25 * MB }).errors.length, 0);
  const r = validateUpload({ name: "big.jpg", size: 26 * MB }); // ~34.7 MiB encoded
  assert.match(r.errors[0] ?? "", /34 MB/);
});

test("batch: 40 file cap and -2/-3 collision renaming", () => {
  const many = Array.from({ length: 41 }, (_, i) => ({ name: `f${i}.jpg`, size: 1 }));
  assert.ok(planUploads(many, { slugifyFileName }).errors.includes(MSG.tooMany));
  assert.equal(planUploads(many.slice(0, LIMITS.maxFiles), { slugifyFileName }).ok, true);
  const r = planUploads(
    [{ name: "Foto A.JPG", size: 1 }, { name: "foto a.jpg", size: 1 }, { name: "Foto-A.jpg", size: 1 }],
    { existing: [], slugifyFileName },
  );
  assert.deepEqual(r.items.map((i) => i.name), ["foto-a.jpg", "foto-a-2.jpg", "foto-a-3.jpg"]);
  assert.equal(uniqueName("a.pdf", ["a.pdf", "a-2.pdf"]), "a-3.pdf");
  assert.throws(() => planUploads([], {}));
});

// ---- image prep ----

test("white fill happens before drawImage", () => {
  const calls = [];
  const ctx = {
    set fillStyle(v) { calls.push(["fillStyle", v]); },
    fillRect: (...a) => calls.push(["fillRect", ...a]),
    drawImage: (...a) => calls.push(["drawImage", ...a.slice(1)]),
  };
  drawFlattened(ctx, {}, 100, 50);
  assert.deepEqual(calls.map((c) => c[0]), ["fillStyle", "fillRect", "drawImage"]);
  assert.deepEqual(calls[0], ["fillStyle", "#ffffff"]);
  assert.deepEqual(calls[1], ["fillRect", 0, 0, 100, 50]);
});

test("prepareImage scales to 2400 long edge and encodes JPEG", async () => {
  const calls = [];
  const canvas = {
    getContext: () => ({
      set fillStyle(v) {}, fillRect: () => calls.push("fill"), drawImage: () => calls.push("draw"),
    }),
  };
  let released = false;
  const env = {
    decodeOriented: async () => ({ source: {}, width: 4800, height: 3200, release: () => (released = true) }),
    createCanvas: () => canvas,
    canvasToBlob: async (c, type, q) => ({ type, q, w: c.width, h: c.height }),
  };
  const blob = await prepareImage({}, {}, env);
  assert.deepEqual(blob, { type: "image/jpeg", q: 0.88, w: 2400, h: 1600 });
  assert.deepEqual(calls, ["fill", "draw"]);
  assert.equal(released, true);
  assert.deepEqual(targetSize(100, 50), { width: 100, height: 50 });
  assert.equal(jpegName("Foto 1.PNG"), "Foto 1.jpg");
});

test("bitmap is discarded when its size disagrees with the <img>", () => {
  const bmp = { width: 3000, height: 4000 };
  const agree = { naturalWidth: 3000, naturalHeight: 4000 };
  const rotated = { naturalWidth: 4000, naturalHeight: 3000 };
  assert.equal(chooseDecoded(bmp, agree).kind, "bitmap");
  const c = chooseDecoded(bmp, rotated);
  assert.equal(c.kind, "img");
  assert.equal(c.width, 4000);
  assert.equal(chooseDecoded(bmp, null).kind, "bitmap");
  assert.equal(chooseDecoded(null, agree).kind, "img");
  assert.throws(() => chooseDecoded(null, null));
});
