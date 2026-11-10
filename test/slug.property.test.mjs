import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { slugify } from "../lib/slug.mjs";

// Project test convention: fixtures are built in before(), never beforeAll.
describe("slugify properties", () => {
  let inputs;

  before(() => {
    // Mix of arbitrary unicode, accented Spanish text, punctuation and long strings.
    inputs = fc.oneof(
      fc.string({ unit: "binary", maxLength: 200 }),
      fc.string({ unit: "grapheme", maxLength: 200 }),
      fc.stringMatching(/^[A-Za-zÁÉÍÓÚÑáéíóúñü0-9 _.,!¡¿?-]{0,120}$/),
      fc.string({ minLength: 56, maxLength: 200 }),
    );
  });

  // Feature: digital-album, Property 5: Slugify is well-formed and idempotent
  // **Validates: Requirements 7.6, 7.7**
  it("Property 5: Slugify is well-formed and idempotent", () => {
    fc.assert(
      fc.property(inputs, (x) => {
        const s = slugify(x);
        assert.match(s, /^[a-z0-9-]{1,55}$/);
        assert.ok(!s.startsWith("-") && !s.endsWith("-"));
        assert.ok(!s.includes(" "));
        assert.equal(slugify(s), s);
      }),
      { numRuns: 100 },
    );
  });
});
