import test, { before } from "node:test";
import fc from "fast-check";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT, ALBUM_SRC } from "../lib/paths.mjs";

const run = (content, args = [], env = {}) =>
  spawnSync("node", ["scripts/seed.mjs", ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, CONTENT_DIR: content, ...env },
  });

const seed = JSON.parse(fs.readFileSync(path.join(ROOT, "seed", "chapters.seed.json"), "utf8"));
const groupShots = JSON.parse(fs.readFileSync(path.join(ROOT, "seed", "group-shots.json"), "utf8"));
const hasSrc = fs.existsSync(ALBUM_SRC);

// Design 4.4 cover table, hardcoded on purpose (independent of the seed file).
const COVER_TABLE = {
  prologo: "first-date-flowers.jpg",
  "expo-aws": "img-20260925-wa0032.jpg",
  "ella-invita": "whatsapp-convo-her-asking-me-out.jpg",
  "primera-cita": "first-date-flowers.jpg",
  "segunda-cita": "img-20261004-wa0062.jpg",
  "tercera-cita": "img-20261009-032021.jpg",
  gimnasio: "img-20261014-wa0097.jpg",
  "kaax-cafe": "img-20261015-wa0086.jpg",
  "en-su-casa": "mvimg-20261017-174928.jpg",
  cartas: "hoja1.jpeg",
  "spooky-fest": "img-20261024-wa0033.jpg",
  "clasico-calabazas": "img-20261025-135148.jpg",
  "la-loma": "mvimg-20261026-173232.jpg",
  "jsconf-gdl": "img-20261029-wa0106.jpg",
  "un-mes": "img-20261101-wa0039.jpg",
  "lienzo-boulevard": "img-20261105-wa0136.jpg",
  graduacion: "img-20261107-wa0085.jpg",
  continuara: null,
};
const SLUG_ORDER = Object.keys(COVER_TABLE);

// Excluded content (Req 17), compared case-insensitively on the full relative path.
const EXCLUDED = [
  "vid-20261025-wa0157.mp4",
  "1023/img-20261023-wa0106.jpg",
  "1025/img-20261025-wa0142.jpg",
];

// Videos named in Req 16 (anything else is unlisted and must be absent).
const ALLOWED_VIDEOS = new Set([
  "shorts/1014_karla_gym_short.mp4",
  "shorts/1014_angel_gym_short.mp4",
  "new-drive/1014/VID-20261014-WA0098.mp4",
  "shorts/1017_painting_costumes_short.mp4",
  "shorts/1017_first_kiss_short.mp4",
  "shorts/1025_karla_arranging_flowers_short.mp4",
  "new-drive/1026/VID-20261026-WA0165.mp4",
  "new-drive/1101/VID-20261101-WA0040.mp4",
]);

// Approved verbatim quotes (Req 18.2); long ones matched by their beginning.
const APPROVED_QUOTES = [
  "Si hay café yo soy feliz",
  "Siempre es hora de café",
  "Para la próxima sería divertido ir solo contigo",
  "Le enseñé las flores",
  "Me agradó el date",
  "Me da gusto haberme animado a mandarte mensaje",
  "Lo mejor de mi año yo creo conocerte / Del mío también / Hiciste feliz mi año",
];
const APPROVED_QUOTE_PREFIXES = [
  "Te entiendo. Yo no quiero solo la versión bonita de ti",
  "Me encantaron y más sabiendo que fue con intenciones",
];
const quoteApproved = (t) =>
  APPROVED_QUOTES.includes(t) || APPROVED_QUOTE_PREFIXES.some((p) => t.startsWith(p));

const isFullRelative = (p) =>
  typeof p === "string" && p.includes("/") && !p.startsWith("/") && !p.split("/").includes("..");
const isExcluded = (p) => {
  const l = p.toLowerCase();
  return /setlog/i.test(p) || EXCLUDED.some((e) => l === e || l.endsWith(`/${e}`));
};

let chapters;
let bySlug;
before(() => {
  // Static fixtures from the seed file only; the real seed is never run against ALBUM_SRC here.
  chapters = seed.chapters;
  bySlug = Object.fromEntries(chapters.map((c) => [c.slug, c]));
});

test("every seed cover equals the design 4.4 table", () => {
  assert.deepEqual(chapters.map((c) => c.slug), SLUG_ORDER);
  chapters.forEach((c, i) => assert.equal(c.order, i * 10, `order of ${c.slug}`));
  for (const c of chapters) assert.equal(c.cover ?? null, COVER_TABLE[c.slug], c.slug);
  assert.deepEqual(seed.coverTable, COVER_TABLE);
  assert.equal(bySlug.prologo.media[0].maxWidth, 800);
});

test("chapter 2 cover is the ask-out screenshot, not the group shot", () => {
  const c = bySlug["ella-invita"];
  assert.equal(c.cover, "whatsapp-convo-her-asking-me-out.jpg");
  assert.notEqual(c.cover, "img-20260929-wa0087.jpg");
});

test("no cover or hero is in seed/group-shots.json", () => {
  assert.ok(groupShots.includes("ella-invita/img-20260929-wa0087.jpg"));
  for (const c of chapters) {
    if (c.cover) assert.ok(!groupShots.includes(`${c.slug}/${c.cover}`), c.slug);
  }
  const hero = bySlug.prologo.media[0].from.split("/").pop().toLowerCase();
  assert.ok(!groupShots.some((g) => g.endsWith(`/${hero}`)));
});

test("Feature: digital-album, Property 20: Seed safety", () => {
  // Feature: digital-album, Property 20: Seed safety
  // **Validates: Requirements 9.5, 10.7, 16.19, 17.1, 17.2, 17.3, 18.2**
  const items = chapters.flatMap((c) => c.media.map((m, i) => ({ c, m, i })));
  fc.assert(
    fc.property(fc.constantFrom(...chapters), fc.nat(), (c, n) => {
      assert.equal(c.cover ?? null, COVER_TABLE[c.slug]);
      assert.ok(!groupShots.includes(`${c.slug}/${c.cover}`));
      if (c.media.length === 0) return true;
      const m = c.media[n % c.media.length];
      if (m.from) {
        assert.ok(isFullRelative(m.from), m.from);
        assert.ok(!isExcluded(m.from), m.from);
        if (m.type === "video") assert.ok(ALLOWED_VIDEOS.has(m.from), m.from);
      }
      if (m.type === "quote") assert.ok(quoteApproved(m.text), m.text);
      return true;
    }),
    { numRuns: 100 },
  );
  assert.ok(items.length > 0);
});

test("chapter 6 media order", () => {
  assert.deepEqual(
    bySlug.gimnasio.media.map((m) => m.from),
    [
      "new-drive/1014/IMG-20261014-WA0097.jpg",
      "shorts/1014_karla_gym_short.mp4",
      "shorts/1014_angel_gym_short.mp4",
      "new-drive/1014/VID-20261014-WA0098.mp4",
    ],
  );
});

test("chapter 7 pairs the second photo with the first", () => {
  const m = bySlug["kaax-cafe"].media;
  assert.equal(m.length, 4);
  assert.equal(m[0].from, "new-drive/1015/IMG-20261015-WA0086.jpg");
  assert.equal(m[1].from, "new-drive/1015/MVIMG_20261015_145404.jpg");
  assert.equal(m[1].pairWithPrevious, true);
  assert.deepEqual(m.map((x) => !!x.pairWithPrevious), [false, true, false, false]);
  assert.equal(m[2].from, "new-drive/1015/IMG_20261015_155423.jpg");
  assert.equal(m[3].from, "new-drive/1015/IMG-20261015-WA0122.jpg");
  assert.ok(m.every((x) => !x.caption), "no food captions");
});

test("Nov 6 quote is the last item of graduacion with when '6 de noviembre'", () => {
  const m = bySlug.graduacion.media;
  const last = m[m.length - 1];
  assert.equal(last.type, "quote");
  assert.equal(last.when, "6 de noviembre");
  assert.equal(last.text, "Lo mejor de mi año yo creo conocerte / Del mío también / Hiciste feliz mi año");
  assert.equal(m.filter((x) => x.type === "quote").length, 1);
});

test("`from` paths are full relative paths", () => {
  const froms = chapters.flatMap((c) => c.media.map((m) => m.from).filter(Boolean));
  assert.ok(froms.length > 0);
  for (const f of froms) assert.ok(isFullRelative(f), f);
  // Same file name in different folders stays distinguishable by full path.
  assert.ok(froms.includes("new-drive/1001/first-date-flowers.jpg"));
});

test("exclusions are absent and no setlog anywhere in the seed", () => {
  const froms = chapters.flatMap((c) => c.media.map((m) => m.from).filter(Boolean));
  for (const f of froms) assert.ok(!isExcluded(f), f);
  assert.ok(!froms.some((f) => /VID-20261025-WA0157/i.test(f)));
  assert.ok(!froms.some((f) => /1023\/IMG-20261023-WA0106/i.test(f)));
  assert.ok(!froms.some((f) => /1025\/IMG-20261025-WA0142/i.test(f)));
  assert.ok(!/setlog/i.test(JSON.stringify(seed)));
});

test("seed copies byte for byte, is idempotent and exits non-zero without source", { skip: !hasSrc }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seed-"));
  try {
    assert.equal(run(dir).status, 0);
    const a = fs.readFileSync(path.join(dir, "chapters/expo-aws/media/img-20260925-wa0032.jpg"));
    const b = fs.readFileSync(path.join(ALBUM_SRC, "new-drive/0925_Ensayo_expo_aws/IMG-20260925-WA0032.jpg"));
    assert.ok(a.equals(b));
    const before = fs.statSync(path.join(dir, "chapters/prologo/chapter.json")).mtimeMs;
    assert.equal(run(dir).status, 0);
    assert.equal(fs.statSync(path.join(dir, "chapters/prologo/chapter.json")).mtimeMs, before);
    assert.notEqual(run(dir, ["--force"], { ALBUM_SRC: path.join(dir, "nope") }).status, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
