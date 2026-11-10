// Template helper (callable from Nunjucks as `picset.pick(entry, maxW)`).
// Turns a media-manifest entry (photo, or video poster) into what <picture> needs.
// Never returns metadata beyond urls and sizes.

const FALLBACK_LIMIT = 800;

const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : Infinity);

function byWidth(list) {
  return [...list].sort((a, b) => a.width - b.width);
}

/** Variants up to maxW; if none qualify, the smallest one so there is always something to show. */
function upTo(list, maxW) {
  const sorted = byWidth(list);
  const keep = sorted.filter((v) => v.width <= maxW);
  return keep.length ? keep : sorted.slice(0, 1);
}

const toSet = (list) => list.map((v) => `${v.url} ${v.width}w`).join(", ");
const dims = (v) => ({ url: v.url, width: v.width, height: v.height });

/**
 * @param entry manifest entry; a video entry uses its poster
 * @param maxW  optional item maxWidth: variants wider than this are never emitted
 * @returns {null | {fallback, webpSet, jpgSet, full}}
 */
export function pick(entry, maxW) {
  const src = entry && entry.poster ? entry.poster : entry;
  const variants = (src && src.variants) || [];
  const limit = num(maxW);
  const jpgs = upTo(variants.filter((v) => v.format === "jpg"), limit);
  const webps = upTo(variants.filter((v) => v.format === "webp"), limit);
  if (!jpgs.length) return null;
  const fbPool = jpgs.filter((v) => v.width <= FALLBACK_LIMIT);
  const fallback = fbPool.length ? fbPool[fbPool.length - 1] : jpgs[0];
  const allJpg = byWidth(variants.filter((v) => v.format === "jpg"));
  return {
    fallback: dims(fallback),
    webpSet: webps.length ? toSet(webps) : "",
    jpgSet: toSet(jpgs),
    // Largest JPEG: target of the plain link and of the zoom dialog.
    full: dims(allJpg[allJpg.length - 1]),
  };
}

/** Index of the first item that renders an <img> (photo or pdf page); -1 if none. */
export function firstImage(items) {
  return (items || []).findIndex((it) => it && (it.type === "photo" || it.type === "pdf"));
}

export default { pick, firstImage };
