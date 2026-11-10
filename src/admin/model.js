// Admin chapter model: round trip, draft binding, order rules, cover rule, folder names.
// Pure logic, no DOM and no imports, so it runs in the browser and under node:test.
//
// slugify lives in lib/slug.mjs, which the build copies to dist/admin/slug.js. The admin
// entry point does `import { slugify } from "./slug.js"` and passes it to newFolderName();
// model.js stays import-free so Node tests do not need the build copy.

const clone = (v) => JSON.parse(JSON.stringify(v));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---------- Round trip (Req 13.3) ----------

export function parseChapter(text) {
  return JSON.parse(text); // JSON.parse keeps key order and unknown keys
}

// 2-space JSON. A trailing newline keeps git diffs clean.
export function serializeChapter(chapter) {
  return JSON.stringify(chapter, null, 2) + "\n";
}

// Returns a copy of `chapter` where only keys in `edits` whose value differs change.
// Existing keys keep their position, new keys are appended, unknown keys are untouched.
// A value of undefined removes the key.
export function applyEdits(chapter, edits) {
  const out = clone(chapter);
  for (const [key, value] of Object.entries(edits)) {
    if (value === undefined) {
      delete out[key];
    } else if (!same(out[key], value)) {
      out[key] = clone(value);
    }
  }
  return out;
}

// Same rule for one media item: merge a patch into media[index].
export function updateMediaItem(chapter, index, patch) {
  const out = clone(chapter);
  const item = out.media?.[index];
  if (!item) throw new RangeError("No existe ese elemento de la lista.");
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete item[key];
    else if (!same(item[key], value)) item[key] = clone(value);
  }
  return out;
}

// ---------- "Texto definitivo" is !draft (Req 13.4) ----------

export function isDefinitive(chapter) {
  return chapter.draft !== true;
}

// Ticking writes draft:false (the key is kept in place or appended).
export function setDefinitive(chapter, definitive) {
  return applyEdits(chapter, { draft: !definitive });
}

// Editing the note on a draft chapter ticks "Texto definitivo" automatically.
export function editNote(chapter, note) {
  if (chapter.note === note) return clone(chapter);
  const out = applyEdits(chapter, { note });
  return chapter.draft === true ? setDefinitive(out, true) : out;
}

// Same for a caption edit on media[index].
export function editCaption(chapter, index, caption) {
  const current = chapter.media?.[index]?.caption;
  if (current === caption) return clone(chapter);
  const out = updateMediaItem(chapter, index, { caption });
  return chapter.draft === true ? setDefinitive(out, true) : out;
}

// ---------- Order rules (Req 13.5) ----------
// `chapters` is a list of { slug, order, kind }. Results: { order, renumbered }
// where renumbered maps slug -> new order for every existing chapter whose order changed
// (empty unless float exhaustion forced a renumbering, to be written in the same commit).

const byOrder = (a, b) => a.order - b.order || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0);

export function defaultOrder(chapters) {
  const teaser = [...chapters].sort(byOrder).find((c) => c.kind === "teaser");
  if (teaser) return orderBefore(chapters, teaser.slug);
  const max = chapters.length ? Math.max(...chapters.map((c) => c.order)) : 0;
  return { order: max + 10, renumbered: {} };
}

export function orderBefore(chapters, targetSlug) {
  const sorted = [...chapters].sort(byOrder);
  const i = sorted.findIndex((c) => c.slug === targetSlug);
  if (i < 0) throw new RangeError("No se encontró el capítulo de referencia.");
  const target = sorted[i];
  if (i === 0) return { order: target.order - 10, renumbered: {} };
  const prev = sorted[i - 1];
  const mid = (prev.order + target.order) / 2;
  if (mid > prev.order && mid < target.order) return { order: mid, renumbered: {} };
  // Float exhaustion (or equal orders): renumber everyone to multiples of 10.
  const renumbered = {};
  let newOrder = 0;
  const list = [...sorted.slice(0, i), null, ...sorted.slice(i)];
  list.forEach((c, n) => {
    const value = n * 10;
    if (c === null) newOrder = value;
    else if (c.order !== value) renumbered[c.slug] = value;
  });
  return { order: newOrder, renumbered };
}

// ---------- Cover rule (Req 13.6) ----------

const needsCover = (chapter) => chapter.kind === "prologue" || chapter.kind === "chapter";
const isVisual = (item) => item.type === "photo" || item.type === "video";

export function coverCandidates(chapter) {
  return (chapter.media || []).filter(isVisual).map((m) => m.file);
}

export function setCover(chapter, file) {
  if (!coverCandidates(chapter).includes(file)) {
    throw new RangeError("La portada debe ser una foto o un video del capítulo.");
  }
  return applyEdits(chapter, { cover: file });
}

// Removes media[index]. If that was the cover, the cover key is dropped and
// needsNewCover is true: the UI must make Angel pick another one before saving.
export function removeMediaItem(chapter, index) {
  const removed = chapter.media?.[index];
  if (!removed) throw new RangeError("No existe ese elemento de la lista.");
  const out = clone(chapter);
  out.media.splice(index, 1);
  // Never leave a dangling cover, whatever the kind; only cover-requiring kinds must pick a new one.
  const droppedCover =
    removed.file !== undefined && removed.file === chapter.cover &&
    !out.media.some((m) => m.file === removed.file);
  if (droppedCover) delete out.cover;
  const lostCover = droppedCover && needsCover(out);
  return { chapter: out, needsNewCover: lostCover, candidates: coverCandidates(out) };
}

// Message for the save button; null when the chapter satisfies the cover rule.
export function coverProblem(chapter) {
  if (!needsCover(chapter)) return null;
  const files = coverCandidates(chapter);
  if (files.includes(chapter.cover)) return null;
  return files.length
    ? "Elige una nueva portada: la anterior se quitó."
    : "Agrega al menos una foto o un video para usar como portada.";
}

// ---------- Folder names (Req 13.3) ----------

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

export function randomSuffix(random = Math.random, length = 4) {
  let s = "";
  for (let i = 0; i < length; i++) s += ALPHABET[Math.floor(random() * ALPHABET.length) % ALPHABET.length];
  return s;
}

// slugify(title)-xxxx
export function newFolderName(title, slugify, random = Math.random) {
  return `${slugify(title)}-${randomSuffix(random)}`;
}
