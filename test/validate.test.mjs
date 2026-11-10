import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateChapter, validateAll } from "../lib/validate-core.mjs";
import { validateContent } from "../lib/validate.mjs";
import { loadChapters } from "../lib/chapters-loader.mjs";

const base = (over = {}) => ({
  schema: 1, order: 10, kind: "chapter", title: "Uno", cover: "a.jpg",
  media: [{ type: "photo", file: "a.jpg" }],
  ...over,
});
const check = (json, files = ["a.jpg", "b.jpg", "c.jpg", "d.jpg"]) =>
  validateChapter(json, { files, slug: "uno" });

describe("validateChapter", () => {
  test("valid chapter has no errors", () => {
    assert.deepEqual(check(base()), []);
  });

  test("missing media file", () => {
    const e = check(base(), []);
    assert.ok(e.some((m) => m.startsWith('[capítulo:uno] media[0] "a.jpg": archivo no existe')), e.join("\n"));
  });

  test("missing cover", () => {
    const j = base(); delete j.cover;
    assert.ok(check(j).some((m) => m.includes("cover: es obligatoria")));
    assert.ok(check(base({ cover: "zzz.jpg" })).some((m) => m.includes("cover:")));
  });

  test("bad extension", () => {
    const j = base({ cover: "a.heic", media: [{ type: "photo", file: "a.heic" }] });
    assert.ok(check(j, ["a.heic"]).some((m) => m.includes("extensión no permitida")));
  });

  test("uppercase name is rejected, not slugified", () => {
    const j = base({ cover: "A.jpg", media: [{ type: "photo", file: "A.jpg" }] });
    assert.ok(check(j, ["A.jpg"]).some((m) => m.includes("nombre inválido")));
  });

  test("external URL anywhere is rejected", () => {
    const j = base({ note: "mira https://example.com" });
    assert.ok(check(j).some((m) => m.includes("note") && m.includes("URLs externas")));
  });

  test("run of three pairWithPrevious is rejected, two is fine", () => {
    const m = (extra) => base({ media: [
      { type: "photo", file: "a.jpg" },
      { type: "photo", file: "b.jpg", pairWithPrevious: true },
      { type: "photo", file: "c.jpg", ...extra },
    ] });
    assert.deepEqual(check(m({})), []);
    assert.ok(check(m({ pairWithPrevious: true })).some((x) => x.includes("pairWithPrevious")));
  });

  test("unknown top-level key and teaser with empty media", () => {
    assert.ok(check(base({ foo: 1 })).some((m) => m.includes("foo: campo desconocido")));
    assert.deepEqual(check({ schema: 1, order: 1, kind: "teaser", title: "x", media: [] }), []);
  });
});

describe("validateAll", () => {
  const ch = (slug, over) => ({ slug, json: base(over), files: ["a.jpg"] });

  test("duplicate slug", () => {
    const e = validateAll([ch("uno"), ch("uno")]);
    assert.ok(e.some((m) => m.includes("slug: repetido")));
  });

  test("normalised slug collision", () => {
    const e = validateAll([ch("primera-cita"), ch("Primera Cita")]);
    assert.ok(e.some((m) => m.includes("colisiona")));
  });

  test("at most one prologue", () => {
    const e = validateAll([ch("p1", { kind: "prologue" }), ch("p2", { kind: "prologue" })]);
    assert.ok(e.some((m) => m.includes("[capítulo:p2]") && m.includes("prólogo")));
  });
});

describe("validate-core source", () => {
  test("has no import statements", () => {
    const src = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "../lib/validate-core.mjs"), "utf8");
    assert.ok(!/^\s*import\b/m.test(src));
    assert.ok(!/\bimport\s*\(/.test(src));
    assert.ok(!/\brequire\s*\(/.test(src));
  });
});

describe("disk validation and loader", () => {
  let dir;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "album-validate-"));
    const mk = (slug, json, files = ["a.jpg"]) => {
      const d = path.join(dir, "chapters", slug);
      fs.mkdirSync(path.join(d, "media"), { recursive: true });
      fs.writeFileSync(path.join(d, "chapter.json"), JSON.stringify(json));
      for (const f of files) fs.writeFileSync(path.join(d, "media", f), "x");
    };
    mk("zeta", base({ order: 20 }));
    mk("alfa", base({ order: 20 }));
    mk("prologo", base({ order: 0, kind: "prologue" }));
    mk("fin", { schema: 1, order: 99, kind: "teaser", title: "Continuará", media: [] }, []);
    mk("roto", base({ cover: "nope.jpg" }));
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  test("validateContent collects all violations at once", async () => {
    const errors = await validateContent({ contentDir: dir });
    assert.ok(errors.length >= 1);
    assert.ok(errors.every((e) => e.startsWith("[capítulo:roto]")), errors.join("\n"));
  });

  test("loader sorts by (order, slug) and numbers chapters only", () => {
    const list = loadChapters(dir);
    assert.deepEqual(list.map((c) => c.slug), ["prologo", "alfa", "roto", "zeta", "fin"].sort(
      (a, b) => ({ prologo: 0, alfa: 20, roto: 10, zeta: 20, fin: 99 }[a] - { prologo: 0, alfa: 20, roto: 10, zeta: 20, fin: 99 }[b]
        || (a < b ? -1 : 1))));
    const bySlug = Object.fromEntries(list.map((c) => [c.slug, c]));
    assert.equal(bySlug.prologo.label, "Prólogo");
    assert.equal(bySlug.roto.label, "Capítulo 1");
    assert.equal(bySlug.alfa.label, "Capítulo 2");
    assert.equal(bySlug.zeta.label, "Capítulo 3");
    assert.equal(bySlug.fin.number, null);
    assert.equal(list[0].prevUrl, "/indice/");
    assert.equal(list.at(-1).nextUrl, "/indice/");
    assert.equal(list[1].prevUrl, "/capitulo/prologo/");
  });

  test("missing or empty chapters dir returns []", () => {
    assert.deepEqual(loadChapters(path.join(dir, "no-existe")), []);
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "album-empty-"));
    fs.mkdirSync(path.join(empty, "chapters"));
    assert.deepEqual(loadChapters(empty), []);
    fs.rmSync(empty, { recursive: true });
  });
});
