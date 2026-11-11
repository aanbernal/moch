// Page model and sequencing of the flipbook (design 3.3). Pure, build time.
// No imports other than constants and `themeFor` from ./themes.mjs.
import { themeFor } from "./themes.mjs";

export const PAGE_ASPECT = 2 / 3; // width / height
export const INDEX_PER_PAGE = 9;
export const NOTE_SPLIT_MAX = 380;

/**
 * Split a note for the title page. Whole if it has at most `max` characters; otherwise cut at the last
 * sentence end (". ", "? ", "! ") or line break at or before `max`, else at the last space, else hard at
 * `max`. Returns [first, rest]. Pieces are trimmed.
 */
export function splitNote(note, max = NOTE_SPLIT_MAX) {
  if (typeof note !== "string") return [];
  if (note.length <= max) return [note];
  let cut = -1; // length of the first piece
  for (let i = Math.min(max, note.length - 1); i >= 1; i--) {
    const c = note[i];
    if (c === "\n") {
      if (i <= max) { cut = i; break; }
    } else if ((c === "." || c === "?" || c === "!") && /\s/.test(note[i + 1] ?? "") && i + 1 <= max) {
      cut = i + 1;
      break;
    }
  }
  if (cut < 0) {
    const sp = note.lastIndexOf(" ", max);
    cut = sp > 0 ? sp : max;
  }
  const first = note.slice(0, cut).trim();
  const rest = note.slice(cut).trim();
  return rest ? [first, rest] : [first];
}

const byOrder = (a, b) => a.order - b.order || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0);
const isEmpty = (v) => v === undefined || v === null || v === "";

/** Expand a chapter's media into one unit per Page: item, pair, quote (PDF pages one by one). */
function toUnits(ch) {
  const media = Array.isArray(ch.media) ? ch.media : [];
  const units = [];
  const withSlug = (m) => ({ ...m, slug: ch.slug });
  for (let i = 0; i < media.length; i++) {
    const m = media[i];
    if (m.type === "quote") {
      units.push({ kind: "quote", item: withSlug(m) });
    } else if (m.type === "pdf") {
      const pages = Array.isArray(m.pages) && m.pages.length ? m.pages : [1];
      pages.forEach((p, k) => {
        units.push({ kind: "item", item: { ...withSlug(m), pdfPage: p, pdfIndex: k, frame: m.frame ?? "letter" } });
      });
    } else if (m.type === "photo" && !m.pairWithPrevious && media[i + 1]?.type === "photo" && media[i + 1].pairWithPrevious) {
      units.push({ kind: "item", items: [withSlug(m), withSlug(media[i + 1])] });
      i++;
    } else {
      units.push({ kind: "item", item: withSlug(m) });
    }
  }
  return units;
}

/** Take the cover item out of the units; a pair that holds it leaves its partner as a single item. */
function takeCover(units, cover) {
  const holds = (u) => (u.items ? u.items.some((x) => x.file === cover) : u.kind === "item" && u.item.file === cover);
  let idx = isEmpty(cover) ? -1 : units.findIndex(holds);
  if (idx < 0) idx = units.findIndex((u) => u.kind === "item");
  if (idx < 0) return { cover: null, rest: units };
  const u = units[idx];
  if (u.items) {
    const k = u.items.findIndex((x) => x.file === cover);
    const at = k < 0 ? 0 : k;
    return { cover: u.items[at], rest: units.toSpliced(idx, 1, { kind: "item", item: u.items[1 - at] }) };
  }
  return { cover: u.item, rest: units.toSpliced(idx, 1) };
}

/** The Cover photo: the prologue cover (never a video), else the first photo of the first chapter that has one. */
function coverPhoto(chapters) {
  const photoOf = (ch) => {
    const media = (ch.media ?? []).filter((m) => m.type === "photo");
    return media.find((m) => m.file === ch.cover) ?? media[0] ?? null;
  };
  const prologue = chapters.find((c) => c.kind === "prologue");
  const order = prologue ? [prologue, ...chapters.filter((c) => c !== prologue)] : chapters;
  for (const ch of order) {
    const p = photoOf(ch);
    if (p) return { ...p, slug: ch.slug };
  }
  return null;
}

/**
 * Full Page list in desktop order, blanks included (design 3.3).
 * Descriptor: { id, kind, label, theme, chapterSlug?, number?, item?, items?, text?, entries?, blank? }.
 */
export function buildPages(chapters, site = {}) {
  const list = [...(chapters ?? [])].sort(byOrder);
  let rank = 0;
  const info = list.map((ch) => {
    const number = ch.kind === "chapter" ? ++rank : null;
    return {
      ch,
      number,
      theme: themeFor(ch, number),
      label: ch.kind === "prologue" ? "Prólogo" : ch.kind === "teaser" ? "Continuará" : `Capítulo ${number}`,
    };
  });

  const pages = [];
  let fill = 0;
  const blank = (theme) => ({ id: `relleno-${++fill}`, kind: "blank", label: null, theme, blank: true });

  // Cover, alone.
  pages.push({
    id: "portada",
    kind: "cover",
    label: "Portada",
    theme: null,
    title: site.title ?? "",
    subtitle: site.subtitle ?? site.volume ?? "",
    item: coverPhoto(list),
  });

  // TOC, chunked and padded to whole Spreads.
  const entries = info.map(({ ch, number, label }) => ({
    id: `capitulo-${ch.slug}`,
    slug: ch.slug,
    number,
    label,
    title: ch.title ?? "",
    dateText: ch.kind === "teaser" || isEmpty(ch.dateText) ? null : ch.dateText,
    teaser: ch.kind === "teaser",
  }));
  const chunks = [];
  for (let i = 0; i < entries.length; i += INDEX_PER_PAGE) chunks.push(entries.slice(i, i + INDEX_PER_PAGE));
  if (!chunks.length) chunks.push([]);
  chunks.forEach((chunk, i) => {
    pages.push({
      id: i === 0 ? "indice" : `indice-${i + 1}`,
      kind: "toc",
      label: i === 0 ? "Índice" : `Índice, página ${i + 1}`,
      theme: null,
      entries: chunk,
      heading: i === 0,
    });
  });
  if (chunks.length % 2) pages.push(blank(null));

  // Chapters.
  for (const { ch, number, theme, label } of info) {
    const start = pages.length;
    const base = `capitulo-${ch.slug}`;
    const title = ch.title ?? "";
    const common = { theme, chapterSlug: ch.slug, number };

    if (ch.kind === "teaser") {
      pages.push({ id: base, kind: "teaser", label, ...common, title, text: title });
      pages.push(blank(theme));
      continue;
    }

    const head = ch.kind === "prologue" ? "Prólogo" : `${label}, ${title}`;
    const { cover, rest } = takeCover(toUnits(ch), ch.cover);
    let n = 1;
    pages.push({ id: base, kind: "title-media", label: head, ...common, title, item: cover });

    const [first, ...more] = splitNote(ch.note);
    const kicker = ch.kind === "prologue" ? "Prólogo" : `${site.volume ?? ""} · ${label}`.replace(/^ · /, "");
    n++;
    pages.push({
      id: `${base}-${n}`,
      kind: "title-text",
      label: `${head}, página ${n}`,
      ...common,
      title,
      kicker,
      dateText: isEmpty(ch.dateText) ? null : ch.dateText,
      place: isEmpty(ch.place) ? null : ch.place,
      text: first ?? null,
    });
    if (more.length) {
      n++;
      pages.push({ id: `${base}-${n}`, kind: "note-cont", label: `${head}, página ${n}`, ...common, title, text: more[0] });
    }

    rest.forEach((u, k) => {
      n++;
      const closing =
        u.kind === "quote" && ch.slug === "graduacion" && k === rest.length - 1 && u.item.when === "6 de noviembre";
      const d = {
        id: `${base}-${n}`,
        kind: u.kind,
        label: closing ? "Cierre" : `${head}, página ${n}`,
        ...common,
      };
      if (u.kind === "quote") Object.assign(d, { item: u.item, text: u.item.text, when: u.item.when ?? null, closing });
      else if (u.items) d.items = u.items;
      else d.item = u.item;
      pages.push(d);
    });

    if ((pages.length - start) % 2) pages.push(blank(theme));
  }
  return pages;
}

/** The same list with every blank removed (phone sequence). */
export function toPhoneSequence(pages) {
  return pages.filter((p) => p.kind !== "blank");
}

/** [[null, cover], [p1, p2], ...]; a last odd Page pairs with null. */
export function toSpreads(pages) {
  if (!pages.length) return [];
  const spreads = [[null, pages[0]]];
  for (let i = 1; i < pages.length; i += 2) spreads.push([pages[i], pages[i + 1] ?? null]);
  return spreads;
}

/** "/indice/" -> "#indice"; "/capitulo/<slug>/" -> "#capitulo-<slug>"; anything else -> null. */
export function legacyToHash(pathname) {
  if (typeof pathname !== "string") return null;
  const p = pathname.replace(/index\.html$/, "");
  if (/^\/indice\/?$/.test(p)) return "#indice";
  const m = /^\/capitulo\/([a-z0-9][a-z0-9-]*)\/?$/.exec(p);
  return m ? `#capitulo-${m[1]}` : null;
}
