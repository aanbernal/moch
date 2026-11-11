// Pure flipbook logic (design 3.7). No DOM, no imports; unit-tested from Node and loaded by book.js.

/** Two Pages iff landscape (square counts), at least 768 wide and 480 tall. Same rule as the CSS query. */
export function modeFromViewport(w, h) {
  return w >= h && w >= 768 && h >= 480 ? 2 : 1;
}

const phoneList = (pages) => pages.filter((p) => p.kind !== "blank");

function idFromHash(hash) {
  let id = String(hash ?? "").replace(/^#/, "");
  try { id = decodeURIComponent(id); } catch { /* keep raw */ }
  return id;
}

/** Index of the Spread that holds Page `id` in the full desktop-order list; -1 if unknown. */
export function spreadIndexOf(pages, id) {
  const i = pages.findIndex((p) => p.id === id);
  return i < 0 ? -1 : Math.ceil(i / 2);
}

/**
 * Cursor for a hash. Desktop (mode 2): Spread index. Phone (mode 1): index in the sequence without blanks;
 * a blank id maps to the nearest non-blank Page (the previous one on a tie). Unknown or empty hash: 0 (Cover).
 */
export function resolveHash(hash, pages, mode) {
  const id = idFromHash(hash);
  const at = id ? pages.findIndex((p) => p.id === id) : -1;
  if (at < 0) return 0;
  if (mode === 2) return Math.ceil(at / 2);
  let best = -1;
  for (let d = 0; d < pages.length && best < 0; d++) {
    for (const j of [at - d, at + d]) {
      if (pages[j] && pages[j].kind !== "blank") { best = j; break; }
    }
  }
  if (best < 0) return 0;
  return phoneList(pages).indexOf(pages[best]);
}

/** New cursor after a step of `dir` (-1 or +1) in a list of `length`, or null at the limits. */
export function stepTarget(cursor, dir, length) {
  const next = cursor + dir;
  return next < 0 || next >= length ? null : next;
}

/** Cursors to preload: desktop current Spread +/- 2, phone current Page +/- 3 (clipped to the list). */
export function nearWindow(cursor, mode, length) {
  const r = mode === 2 ? 2 : 3;
  const out = [];
  for (let i = Math.max(0, cursor - r); i <= Math.min(length - 1, cursor + r); i++) out.push(i);
  return out;
}

/** Largest size from `start` down to `floor` (by `step`) for which fits(size) is true; `floor` if none. */
export function fitSize({ start, floor, step, fits }) {
  let size = start;
  while (size > floor) {
    if (fits(size)) return size;
    size = Math.max(floor, size - step);
  }
  return floor;
}

/**
 * Video plan per Page id (design 3.7). Displayed: load, preload auto, play unless hidden or user-paused.
 * Near (not displayed): load, preload metadata, no play, muted. Far: nothing loads, muted, no play.
 */
export function videoPlan({ videoPages, displayed, near, userPaused, hidden }) {
  const has = (c, id) => (c ? (c.has ? c.has(id) : c.includes(id)) : false);
  return [...videoPages].map((id) => {
    if (has(displayed, id)) {
      return { id, loadSource: true, preload: "auto", play: !hidden && !has(userPaused, id) };
    }
    if (has(near, id)) return { id, loadSource: true, preload: "metadata", play: false, mute: true };
    return { id, loadSource: false, preload: "none", play: false, mute: true };
  });
}
