import { test } from "node:test";
import assert from "node:assert/strict";
import { loadChapters } from "../lib/chapters-loader.mjs";
import {
  PAGE_ASPECT, INDEX_PER_PAGE, NOTE_SPLIT_MAX, splitNote, buildPages, toPhoneSequence, toSpreads, legacyToHash,
} from "../lib/book-model.mjs";
import { PALETTE, themeFor } from "../lib/themes.mjs";
import {
  modeFromViewport, resolveHash, spreadIndexOf, stepTarget, nearWindow, fitSize, videoPlan,
} from "../src/assets/book-logic.js";

const site = { title: "Álbum", volume: "Volumen I" };
const photo = (file, extra = {}) => ({ type: "photo", file, ...extra });
const ch = (slug, order, n, extra = {}) => ({
  slug, order, kind: "chapter", title: slug, cover: "f0.jpg",
  media: Array.from({ length: n }, (_, i) => photo(`f${i}.jpg`)), ...extra,
});
const of = (pages, slug) => pages.filter((p) => p.chapterSlug === slug);

test("constants", () => {
  assert.equal(PAGE_ASPECT, 2 / 3);
  assert.equal(INDEX_PER_PAGE, 9);
  assert.equal(NOTE_SPLIT_MAX, 380);
});

test("seed list: cover alone, 2 TOC pages, every chapter starts on a left page, ids unique", () => {
  const chapters = loadChapters();
  assert.equal(chapters.length, 18);
  const pages = buildPages(chapters, site);
  assert.equal(pages[0].kind, "cover");
  assert.equal(pages[0].id, "portada");
  assert.equal(pages[0].theme, null);
  assert.equal(pages.filter((p) => p.kind === "toc").length, 2);
  assert.deepEqual(pages.slice(1, 3).map((p) => p.id), ["indice", "indice-2"]);
  for (const c of chapters) {
    const idx = pages.findIndex((p) => p.id === `capitulo-${c.slug}`);
    assert.ok(idx > 0, c.slug);
    assert.equal(idx % 2, 1, `${c.slug} starts on a left page (odd index)`);
  }
  assert.equal(new Set(pages.map((p) => p.id)).size, pages.length);
  assert.equal(pages.length % 2, 1, "cover plus whole spreads");
  assert.equal(toSpreads(pages).every((s, i) => i === 0 || (s[0] && s[1])), true);
});

test("chapters with 1, 2, 3 and 8 items; odd count gets one trailing blank", () => {
  for (const [n, total, blanks] of [[1, 2, 0], [2, 4, 1], [3, 4, 0], [8, 10, 1]]) {
    // title-media holds the cover (item 1); the remaining items get one Page each
    const pages = buildPages([ch("a", 10, n)], site).filter((p) => p.chapterSlug === "a" || (p.kind === "blank" && p.theme));
    const own = pages.filter((p) => p.kind !== "blank");
    assert.equal(own.length + blanks, total, `${n} items`);
    assert.equal(pages.filter((p) => p.kind === "blank").length, blanks, `${n} items blanks`);
  }
  const p = buildPages([ch("a", 10, 2)], site);
  assert.equal(p.at(-1).kind, "blank");
  assert.equal(p.at(-1).theme, p.at(-2).theme);
});

test("teaser is one page plus a blank (back cover), crema", () => {
  const p = buildPages([ch("a", 10, 3), { slug: "continuara", order: 20, kind: "teaser", title: "Continuará…", media: [] }], site);
  const t = p.findIndex((x) => x.kind === "teaser");
  assert.equal(p[t].id, "capitulo-continuara");
  assert.equal(p[t].label, "Continuará");
  assert.equal(p[t + 1].kind, "blank");
  assert.equal(t + 2, p.length);
  assert.equal(p[t].theme, "crema");
  assert.equal(p[t + 1].theme, "crema");
});

test("Nov 6 quote is the last page of graduacion, with no 'Capítulo N'", () => {
  const pages = buildPages(loadChapters(), site);
  const own = of(pages, "graduacion").filter((p) => p.kind !== "blank");
  const last = own.at(-1);
  assert.equal(last.kind, "quote");
  assert.equal(last.when, "6 de noviembre");
  assert.doesNotMatch(last.label, /Capítulo/);
  const i = pages.indexOf(last);
  assert.ok(["blank", "teaser"].includes(pages[i + 1].kind));
  assert.equal(pages.find((p) => p.kind === "teaser") === undefined, false);
});

test("letters chapter gives four letter pages; a pair is one page; quotes are one page each", () => {
  const pages = buildPages(loadChapters(), site);
  const letters = of(pages, "cartas").filter((p) => p.item && (p.item.frame === "letter"));
  assert.equal(letters.length, 4);
  const c = {
    slug: "p", order: 10, kind: "chapter", title: "P", cover: "a.jpg",
    media: [photo("a.jpg"), photo("b.jpg"), photo("c.jpg", { pairWithPrevious: true }),
      { type: "quote", text: "uno", when: "x" }, { type: "quote", text: "dos" }],
  };
  const q = of(buildPages([c], site), "p");
  const kinds = q.map((x) => x.kind);
  assert.deepEqual(kinds.slice(0, 5), ["title-media", "title-text", "item", "quote", "quote"]);
  assert.equal(q[2].items.length, 2);
  assert.equal(q[3].text, "uno");
});

test("19 entries give four TOC pages; 18 give two", () => {
  const many = Array.from({ length: 19 }, (_, i) => ch(`c${String(i).padStart(2, "0")}`, i + 1, 1));
  const p = buildPages(many, site);
  const tocIds = p.slice(1, 5);
  assert.deepEqual(tocIds.map((x) => x.kind), ["toc", "toc", "toc", "blank"]);
  assert.equal(tocIds[3].theme, null);
  assert.deepEqual(tocIds.map((x) => x.entries?.length), [9, 9, 1, undefined]);
  assert.equal(buildPages(many.slice(0, 18), site).filter((x) => x.kind === "toc").length, 2);
});

test("splitNote: 380, 381 and 600 characters", () => {
  assert.deepEqual(splitNote("a".repeat(380)), ["a".repeat(380)]);
  const words = (n) => ("palabra ".repeat(100)).slice(0, n).trim();
  const s381 = words(381);
  const two = splitNote(s381);
  assert.equal(two.length, 2);
  assert.ok(two[0].length <= 380);
  assert.equal(two.join(" "), s381);
  const sent = ("Una frase corta. ".repeat(40)).slice(0, 600);
  const parts = splitNote(sent);
  assert.equal(parts.length, 2);
  assert.ok(parts[0].length <= 380);
  assert.ok(parts[0].endsWith("."));
  assert.equal(splitNote("x".repeat(600)).length, 2);
  assert.deepEqual(splitNote("x".repeat(381)).map((s) => s.length), [380, 1]);
});

test("note continuation Page and ids", () => {
  const long = "Frase de prueba. ".repeat(30);
  const p = of(buildPages([ch("n", 10, 3, { note: long })], site), "n");
  assert.deepEqual(p.slice(0, 4).map((x) => x.id), ["capitulo-n", "capitulo-n-2", "capitulo-n-3", "capitulo-n-4"]);
  assert.equal(p[2].kind, "note-cont");
  assert.ok(p[1].text.length <= 380);
});

test("title-text carries label, title, date, place; missing ones are null", () => {
  const p = buildPages([ch("t", 10, 1, { dateText: "Jue 1", place: "Tepic", note: "Nota" })], site);
  const tt = p.find((x) => x.kind === "title-text");
  assert.equal(tt.kicker, "Volumen I · Capítulo 1");
  assert.equal(tt.dateText, "Jue 1");
  assert.equal(tt.place, "Tepic");
  assert.equal(tt.text, "Nota");
  const bare = buildPages([ch("t", 10, 1)], site).find((x) => x.kind === "title-text");
  assert.equal(bare.dateText, null);
  assert.equal(bare.text, null);
});

test("cover descriptor: title and exactly one photo, never a video", () => {
  const chapters = loadChapters();
  const cover = buildPages(chapters, site)[0];
  assert.equal(cover.title, "Álbum");
  assert.equal(cover.item.type, "photo");
  const vid = { slug: "prologo", order: 0, kind: "prologue", title: "P", cover: "v.mp4",
    media: [{ type: "video", file: "v.mp4" }, photo("p.jpg")] };
  assert.equal(buildPages([vid], site)[0].item.file, "p.jpg");
  assert.equal(buildPages([{ ...vid, media: [{ type: "video", file: "v.mp4" }] }], site)[0].item, null);
});

test("themes: prologue, ranks 1 to 16, explicit, teaser, blanks, TOC, cover", () => {
  const pro = { slug: "pro", order: 0, kind: "prologue", title: "P", media: [photo("a.jpg")], cover: "a.jpg" };
  const chs = Array.from({ length: 16 }, (_, i) => ch(`c${String(i + 1).padStart(2, "0")}`, i + 1, 2));
  const tea = { slug: "fin", order: 99, kind: "teaser", title: "F", media: [] };
  const pages = buildPages([pro, ...chs, tea], site);
  assert.equal(pages[0].theme, null);
  for (const p of pages.filter((x) => x.kind === "toc")) assert.equal(p.theme, null);
  assert.ok(of(pages, "pro").every((p) => p.theme === "crema"));
  chs.forEach((c, i) => {
    const want = PALETTE[(i + 1) % 8].name;
    const own = of(pages, c.slug);
    assert.ok(own.every((p) => p.theme === want), c.slug);
  });
  assert.deepEqual(chs.slice(0, 8).map((c) => of(pages, c.slug)[0].theme),
    ["rosa", "salvia", "cielo", "lavanda", "terracota", "miel", "noche", "crema"]);
  // every Chapter blank carries the Chapter theme
  for (const p of pages.filter((x) => x.kind === "blank" && x.theme)) assert.ok(PALETTE.some((t) => t.name === p.theme));
  assert.ok(of(pages, "fin").every((p) => p.theme === "crema"));
  // explicit theme, including its trailing blank and the teaser's own theme
  const ex = buildPages([ch("x", 1, 2, { theme: "noche" }), { ...tea, theme: "miel" }], site);
  assert.ok(of(ex, "x").every((p) => p.theme === "noche"));
  const xi = ex.findIndex((p) => p.id === "capitulo-x");
  assert.equal(ex[xi + 3].kind, "blank");
  assert.equal(ex[xi + 3].theme, "noche");
  assert.equal(ex.at(-1).kind, "blank");
  assert.equal(ex.at(-1).theme, "miel");
  assert.equal(themeFor({ kind: "chapter" }, 9), "rosa");
});

test("toPhoneSequence drops blanks; toSpreads pairs", () => {
  const pages = buildPages([ch("a", 10, 2)], site);
  assert.ok(toPhoneSequence(pages).every((p) => p.kind !== "blank"));
  const sp = toSpreads(pages);
  assert.equal(sp[0][0], null);
  assert.equal(sp[0][1].id, "portada");
  assert.equal(sp[1][0].id, "indice");
  assert.equal(sp[1][1].kind, "blank");
});

test("legacyToHash", () => {
  assert.equal(legacyToHash("/indice/"), "#indice");
  assert.equal(legacyToHash("/indice"), "#indice");
  assert.equal(legacyToHash("/capitulo/expo-aws/"), "#capitulo-expo-aws");
  assert.equal(legacyToHash("/capitulo/expo-aws/index.html"), "#capitulo-expo-aws");
  assert.equal(legacyToHash("/"), null);
  assert.equal(legacyToHash("/admin/"), null);
  assert.equal(legacyToHash("/capitulo/"), null);
});

test("modeFromViewport", () => {
  // 1280x480 is exactly on the boundary (h >= 480), so the rule gives two Pages.
  for (const [w, h] of [[1440, 900], [1180, 820], [1024, 768], [1024, 600], [800, 800], [1280, 480]]) {
    assert.equal(modeFromViewport(w, h), 2, `${w}x${h}`);
  }
  for (const [w, h] of [[820, 1180], [768, 1024], [390, 844], [360, 640], [844, 390], [767, 1024], [1024, 479], [1280, 479]]) {
    assert.equal(modeFromViewport(w, h), 1, `${w}x${h}`);
  }
});

test("resolveHash: right slot, blank ids, unknown", () => {
  const pages = buildPages([ch("a", 10, 2), ch("b", 20, 3)], site);
  const phone = toPhoneSequence(pages);
  // desktop: cover is spread 0; indice and the blank next to it are spread 1
  assert.equal(resolveHash("#portada", pages, 2), 0);
  assert.equal(resolveHash("#indice", pages, 2), 1);
  assert.equal(resolveHash(`#${pages[2].id}`, pages, 2), 1, "right slot (blank)");
  assert.equal(resolveHash(`#${pages[4].id}`, pages, 2), 2, "right slot");
  const a2 = pages.findIndex((p) => p.id === "capitulo-a-3");
  assert.equal(resolveHash("#capitulo-a-3", pages, 2), Math.ceil(a2 / 2));
  const blank = pages.find((p) => p.kind === "blank" && p.theme);
  assert.equal(resolveHash(`#${blank.id}`, pages, 2), Math.ceil(pages.indexOf(blank) / 2));
  // phone: a blank id resolves to the previous non-blank page
  const k = resolveHash(`#${blank.id}`, pages, 1);
  assert.equal(phone[k], pages[pages.indexOf(blank) - 1]);
  assert.equal(phone[resolveHash("#indice", pages, 1)].id, "indice");
  for (const h of ["", "#", "#nada", undefined]) {
    assert.equal(resolveHash(h, pages, 1), 0);
    assert.equal(resolveHash(h, pages, 2), 0);
  }
  assert.equal(spreadIndexOf(pages, "portada"), 0);
  assert.equal(spreadIndexOf(pages, "zzz"), -1);
});

test("stepTarget limits and nearWindow", () => {
  assert.equal(stepTarget(0, -1, 5), null);
  assert.equal(stepTarget(4, 1, 5), null);
  assert.equal(stepTarget(0, 1, 5), 1);
  assert.equal(stepTarget(3, -1, 5), 2);
  assert.deepEqual(nearWindow(0, 2, 10), [0, 1, 2]);
  assert.deepEqual(nearWindow(5, 2, 20), [3, 4, 5, 6, 7]);
  assert.deepEqual(nearWindow(5, 1, 20), [2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(nearWindow(19, 1, 20), [16, 17, 18, 19]);
});

test("fitSize shrinks until it fits, never below the floor", () => {
  assert.equal(fitSize({ start: 20, floor: 11, step: 1, fits: (s) => s <= 15 }), 15);
  assert.equal(fitSize({ start: 20, floor: 11, step: 1, fits: () => false }), 11);
  assert.equal(fitSize({ start: 20, floor: 11, step: 1, fits: () => true }), 20);
  assert.equal(fitSize({ start: 20, floor: 11, step: 4, fits: (s) => s <= 12 }), 12);
  assert.equal(fitSize({ start: 20, floor: 11, step: 4, fits: (s) => s <= 11 }), 11);
});

test("videoPlan: displayed, near, far, hidden, userPaused", () => {
  const args = { videoPages: ["a", "b", "c"], displayed: new Set(["a"]), near: new Set(["a", "b"]), userPaused: new Set(), hidden: false };
  const by = (plan) => Object.fromEntries(plan.map((p) => [p.id, p]));
  let p = by(videoPlan(args));
  assert.deepEqual(p.a, { id: "a", loadSource: true, preload: "auto", play: true });
  assert.deepEqual(p.b, { id: "b", loadSource: true, preload: "metadata", play: false, mute: true });
  assert.deepEqual(p.c, { id: "c", loadSource: false, preload: "none", play: false, mute: true });
  assert.equal(by(videoPlan({ ...args, hidden: true })).a.play, false);
  assert.equal(by(videoPlan({ ...args, userPaused: new Set(["a"]) })).a.play, false);
  p = by(videoPlan({ ...args, displayed: ["b"], userPaused: ["a"] }));
  assert.equal(p.a.play, false);
  assert.equal(p.a.mute, true);
  assert.equal(p.b.play, true);
});
