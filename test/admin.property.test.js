import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fc from "fast-check";
import { encryptToken, decryptToken } from "../src/admin/crypto.js";
import {
  parseChapter,
  serializeChapter,
  applyEdits,
  editNote,
  editCaption,
  removeMediaItem,
  coverCandidates,
} from "../src/admin/model.js";

const ADMIN_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "admin");

// Project test convention: fixtures are built in before(), never beforeAll.
describe("admin crypto properties", () => {
  let tokens;
  let passwords;

  before(() => {
    tokens = fc.string({ unit: "grapheme", minLength: 1, maxLength: 80 });
    passwords = fc.string({ unit: "grapheme", minLength: 1, maxLength: 40 });
  });

  // Feature: digital-album, Property 25: Admin crypto round trip
  // **Validates: Requirements 13.1, 13.2**
  // PBKDF2 iterations are lowered to 1000 here (production is 310000) so 100 runs stay fast;
  // the algorithm path is identical, only the work factor differs.
  it("Property 25: Admin crypto round trip", async () => {
    await fc.assert(
      fc.asyncProperty(tokens, passwords, passwords, async (token, pw, other) => {
        const rec = await encryptToken(token, pw, { iterations: 1000 });
        assert.equal(rec.iter, 1000);
        assert.ok(!JSON.stringify(rec).includes(JSON.stringify(token).slice(1, -1)) || token.length < 3);
        assert.equal(await decryptToken(rec, pw), token);
        if (other !== pw) {
          await assert.rejects(decryptToken(rec, other), (e) => e.code === "wrong-password");
        }
      }),
      { numRuns: 100 },
    );
  });
});

describe("admin model properties", () => {
  let chapters;
  let editsFor;

  before(() => {
    const word = fc.string({ maxLength: 30 });
    const file = fc.stringMatching(/^[a-z0-9]{1,8}\.(jpg|mp4|m4a)$/);
    const mediaItem = fc.record(
      {
        file,
        type: fc.constantFrom("photo", "video", "audio"),
        caption: word,
        extra_k: fc.integer(),
      },
      { requiredKeys: ["file", "type"] },
    );
    const unknownKeys = fc.dictionary(fc.stringMatching(/^x_[a-z]{1,6}$/), fc.jsonValue({ maxDepth: 2 }), { maxKeys: 4 });

    // Known keys in a shuffled order, plus unknown extra keys, to exercise key-order preservation.
    chapters = fc
      .tuple(
        fc.record(
          {
            title: word,
            kind: fc.constantFrom("prologue", "chapter", "teaser"),
            order: fc.integer({ min: 0, max: 1000 }),
            note: word,
            draft: fc.boolean(),
            media: fc.array(mediaItem, { maxLength: 6 }),
          },
          { requiredKeys: ["title", "kind", "order", "media"] },
        ),
        unknownKeys,
        fc.boolean(),
      )
      .chain(([known, extra, extraFirst]) => {
        const base = extraFirst ? { ...extra, ...known } : { ...known, ...extra };
        const visual = (base.media || []).filter((m) => m.type === "photo" || m.type === "video");
        const coverArb = visual.length ? fc.option(fc.constantFrom(...visual.map((m) => m.file)), { nil: undefined }) : fc.constant(undefined);
        return coverArb.map((cover) => (cover === undefined ? base : { ...base, cover }));
      })
      .map((c) => parseChapter(JSON.stringify(c)));

    editsFor = fc.record(
      { title: fc.string({ maxLength: 30 }), order: fc.integer({ min: 0, max: 1000 }), note: fc.string({ maxLength: 30 }), x_new: fc.integer() },
      { requiredKeys: [] },
    );
  });

  // Feature: digital-album, Property 26: Admin model round trip
  // **Validates: Requirements 13.5, 13.6**
  it("Property 26: Admin model round trip", () => {
    fc.assert(
      fc.property(chapters, editsFor, fc.nat(10), fc.string({ maxLength: 20 }), (chapter, edits, idx, text) => {
        const text0 = serializeChapter(chapter);

        // Parse -> serialize is lossless (unknown keys and order included).
        assert.equal(serializeChapter(parseChapter(text0)), text0);

        // No edits: byte-identical.
        assert.equal(serializeChapter(applyEdits(chapter, {})), text0);

        // Subset edit: only edited keys change; others keep value and relative order.
        const edited = applyEdits(chapter, edits);
        const oldKeys = Object.keys(chapter);
        const newKeys = Object.keys(edited);
        assert.deepEqual(newKeys.slice(0, oldKeys.length), oldKeys);
        for (const k of oldKeys) {
          if (!(k in edits)) assert.deepEqual(edited[k], chapter[k]);
          else assert.deepEqual(edited[k], edits[k]);
        }
        assert.deepEqual(newKeys.slice(oldKeys.length).sort(), Object.keys(edits).filter((k) => !(k in chapter)).sort());
        assert.deepEqual(parseChapter(serializeChapter(edited)), edited);

        // "Texto definitivo" rule: a note edit only touches note (+ draft when it was a draft).
        const afterNote = editNote(chapter, text);
        for (const k of oldKeys) {
          if (k !== "note" && k !== "draft") assert.deepEqual(afterNote[k], chapter[k]);
        }
        assert.deepEqual(Object.keys(afterNote).slice(0, oldKeys.length), oldKeys);
        if (chapter.note !== text && chapter.draft === true) assert.equal(afterNote.draft, false);
        else assert.deepEqual(afterNote.draft, chapter.draft);

        // Caption edit follows the same rule.
        if (chapter.media.length) {
          const i = idx % chapter.media.length;
          const afterCap = editCaption(chapter, i, text);
          assert.equal(afterCap.media[i].caption, chapter.media[i].caption === text ? chapter.media[i].caption : text);
          assert.deepEqual(afterCap.media.filter((_, j) => j !== i), chapter.media.filter((_, j) => j !== i));
          if (chapter.media[i].caption !== text && chapter.draft === true) assert.equal(afterCap.draft, false);
        }

        // Removal: cover keeps pointing at an existing photo/video, or is dropped with needsNewCover.
        if (chapter.media.length) {
          const i = idx % chapter.media.length;
          const r = removeMediaItem(chapter, i);
          assert.equal(r.chapter.media.length, chapter.media.length - 1);
          if (r.chapter.cover !== undefined) {
            assert.ok(coverCandidates(r.chapter).includes(r.chapter.cover));
            assert.equal(r.needsNewCover, false);
          } else if (chapter.cover !== undefined && (chapter.kind === "prologue" || chapter.kind === "chapter")) {
            assert.equal(r.needsNewCover, true);
          }
        }
      }),
      { numRuns: 100 },
    );
  });
});

describe("admin source safety", () => {
  // Requirement 13: no HTML injection sinks anywhere in src/admin/.
  it("src/admin/ never uses innerHTML, insertAdjacentHTML, outerHTML or document.write", () => {
    const files = readdirSync(ADMIN_DIR, { recursive: true, withFileTypes: true }).filter((d) => d.isFile());
    assert.ok(files.length > 0);
    const banned = /innerHTML|insertAdjacentHTML|outerHTML|document\s*\.\s*write/;
    for (const f of files) {
      const full = path.join(f.parentPath ?? f.path, f.name);
      assert.doesNotMatch(readFileSync(full, "utf8"), banned, `${full} uses a banned HTML sink`);
    }
  });
});
