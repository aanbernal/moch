import { test } from "node:test";
import assert from "node:assert/strict";
import { slugify, slugifyFileName } from "../lib/slug.mjs";

test("slugify strips accents, lowercases, hyphenates", () => {
  assert.equal(slugify("  Cumpleaños de Ángel!! "), "cumpleanos-de-angel");
});

test("slugify falls back to capitulo", () => {
  assert.equal(slugify("¡¿?!"), "capitulo");
  assert.equal(slugify(""), "capitulo");
});

test("slugify cuts at 55 and is idempotent with no trailing hyphen", () => {
  const out = slugify("a".repeat(54) + " b" + "c".repeat(10));
  assert.ok(out.length <= 55);
  assert.ok(!out.endsWith("-"));
  assert.equal(slugify(out), out);
});

test("slugifyFileName keeps lowercased extension", () => {
  assert.equal(slugifyFileName("Para Manuel .pdf"), "para-manuel.pdf");
  assert.equal(slugifyFileName("IMG_2026 01.JPG"), "img-2026-01.jpg");
  assert.equal(slugifyFileName("README"), "readme");
});
