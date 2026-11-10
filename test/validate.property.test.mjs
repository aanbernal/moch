import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { validateChapter, validateAll } from "../lib/validate-core.mjs";

const RUNS = { numRuns: 100 };
const word = fc.array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789-".split("")), { minLength: 1, maxLength: 12 })
  .map((a) => "x" + a.join("").replace(/^-+|-+$/g, "q"));
const slugArb = word;
// distinct lowercase stems -> photo files
const stemsArb = fc.uniqueArray(word, { minLength: 2, maxLength: 8 });

const build = (stems) => ({
  json: {
    schema: 1, order: 10, kind: "chapter", title: "T", cover: `${stems[0]}.jpg`,
    media: stems.map((s) => ({ type: "photo", file: `${s}.jpg` })),
  },
  files: stems.map((s) => `${s}.jpg`),
});
const run = (json, files, slug) => validateChapter(json, { files, slug });
const names = (errs, slug, file) =>
  errs.length > 0 && errs.every((e) => e.includes(slug)) && (file === undefined || errs.some((e) => e.includes(file)));

describe("Feature: digital-album, Property 3: Validation names the offender", () => {
  let cases;
  before(() => { cases = { build }; });

  test("valid generated chapters yield no errors", () => {
    fc.assert(fc.property(slugArb, stemsArb, (slug, stems) => {
      const { json, files } = cases.build(stems);
      assert.deepEqual(run(json, files, slug), []);
    }), RUNS);
  });

  test("missing media file names slug and file", () => {
    fc.assert(fc.property(slugArb, stemsArb, (slug, stems) => {
      const { json, files } = cases.build(stems);
      const missing = files[files.length - 1];
      const errs = run(json, files.filter((f) => f !== missing), slug);
      assert.ok(names(errs, slug, missing), errs.join("\n"));
    }), RUNS);
  });

  test("missing or invalid cover names slug", () => {
    fc.assert(fc.property(slugArb, stemsArb, fc.boolean(), (slug, stems, drop) => {
      const { json, files } = cases.build(stems);
      if (drop) delete json.cover; else json.cover = "nope-zz.jpg";
      const errs = run(json, files, slug);
      assert.ok(names(errs, slug) && errs.some((e) => e.includes("cover")), errs.join("\n"));
    }), RUNS);
  });

  test("uppercase or bad-extension file names slug and file", () => {
    fc.assert(fc.property(slugArb, stemsArb, fc.constantFrom("upper", "ext"), (slug, stems, mode) => {
      const { json, files } = cases.build(stems);
      const bad = mode === "upper" ? `${stems[1].toUpperCase()}.jpg` : `${stems[1]}.heic`;
      json.media[1].file = bad;
      const errs = run(json, [...files, bad], slug);
      assert.ok(names(errs, slug, bad), errs.join("\n"));
    }), RUNS);
  });

  test("duplicated file names slug and file", () => {
    fc.assert(fc.property(slugArb, stemsArb, (slug, stems) => {
      const { json, files } = cases.build(stems);
      json.media.push({ type: "photo", file: files[0] });
      const errs = run(json, files, slug);
      assert.ok(names(errs, slug, files[0]) && errs.some((e) => e.includes("repetido")), errs.join("\n"));
    }), RUNS);
  });

  test("bad type, overlong field and external URL name slug", () => {
    fc.assert(fc.property(slugArb, stemsArb, fc.constantFrom("type", "title", "url"), (slug, stems, mode) => {
      const { json, files } = cases.build(stems);
      if (mode === "type") json.media[1].type = "gif";
      if (mode === "title") json.title = "t".repeat(121);
      if (mode === "url") json.note = "ver https://example.com/x";
      const errs = run(json, files, slug);
      assert.ok(names(errs, slug), errs.join("\n"));
    }), RUNS);
  });

  test("run of three pairWithPrevious names slug", () => {
    fc.assert(fc.property(slugArb, fc.uniqueArray(word, { minLength: 3, maxLength: 8 }), (slug, stems) => {
      const { json, files } = cases.build(stems);
      json.media[1].pairWithPrevious = true;
      json.media[2].pairWithPrevious = true;
      const errs = run(json, files, slug);
      assert.ok(names(errs, slug) && errs.some((e) => e.includes("pairWithPrevious")), errs.join("\n"));
    }), RUNS);
  });

  test("duplicate slug names the slug", () => {
    fc.assert(fc.property(slugArb, stemsArb, (slug, stems) => {
      const { json, files } = cases.build(stems);
      const errs = validateAll([{ slug, json, files }, { slug, json, files }]);
      assert.ok(names(errs, slug) && errs.some((e) => e.includes("repetido")), errs.join("\n"));
    }), RUNS);
  });
});
