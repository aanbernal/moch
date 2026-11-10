// Photo processing (design 6.1): one compression table, three classes.
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const KB = 1024;

export const PHOTO_TABLE = {
  normal: {
    widths: [480, 800, 1200],
    webpLadder: [72, 65, 58],
    webpBudget: 250 * KB,
    jpegLadder: [75, 68, 60],
    jpegBudget: 350 * KB,
  },
  maxWidth: {
    widths: [480, 800, 1200],
    webpLadder: [65, 58],
    webpBudget: 120 * KB,
    jpegLadder: [75, 68, 60],
    jpegBudget: 350 * KB,
  },
  letter: { widths: [800, 1200, 1800], webpQuality: 86, jpegQuality: 88 },
};

/** Class order: frame "letter", then maxWidth, else normal. */
export function photoClass({ frame, maxWidth } = {}) {
  if (frame === "letter") return "letter";
  if (maxWidth) return "maxWidth";
  return "normal";
}

function open(input) {
  return sharp(input, { failOn: "error", limitInputPixels: 268402689 }).rotate();
}

async function encode(input, width, format, quality) {
  let p = open(input)
    .resize({ width, fit: "inside", withoutEnlargement: true })
    .toColourspace("srgb"); // no withMetadata: EXIF, GPS and MVIMG trailer dropped
  if (format === "webp") p = p.webp({ quality });
  else if (format === "jpg") {
    p = p.jpeg(
      quality === 88
        ? { quality, mozjpeg: true, progressive: true, chromaSubsampling: "4:4:4" }
        : { quality, mozjpeg: true, progressive: true },
    );
  }
  const { data, info } = await p.toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/** Source width after EXIF rotation. */
async function sourceWidth(input) {
  const m = await sharp(input, { failOn: "error", limitInputPixels: 268402689 }).metadata();
  return m.orientation && m.orientation >= 5 ? m.height : m.width;
}

/**
 * Ladder on the budget width; returns the chosen quality and whether it is over budget.
 * Keeps the last (lowest) quality when nothing fits.
 */
async function pickQuality(input, width, format, ladder, budget) {
  let last;
  for (const q of ladder) {
    last = await encode(input, width, format, q);
    if (last.data.length <= budget) return { quality: q, overBudget: false, first: last };
  }
  return { quality: ladder[ladder.length - 1], overBudget: true, first: last };
}

/**
 * Process one photo.
 * @param {object} o
 * @param {string|Buffer} o.input source path or bytes
 * @param {string} o.outDir directory for outputs (created)
 * @param {string} o.key12 content-addressed key prefix
 * @param {string} [o.frame] "letter" or absent
 * @param {number} [o.maxWidth]
 * @param {string} [o.name] label for warnings
 * @returns {{cls, variants:[{width,height,format,file,bytes}], heavy:[...], warnings:[string]}}
 */
export async function processPhoto({ input, outDir, key12, frame, maxWidth, name = key12 }) {
  const cls = photoClass({ frame, maxWidth });
  const t = PHOTO_TABLE[cls];
  const srcW = await sourceWidth(input);
  const cap = cls === "maxWidth" ? maxWidth : Infinity;
  let widths = t.widths.filter((w) => w <= cap && w <= srcW);
  if (widths.length === 0) widths = [Math.min(srcW, cap)];
  // Budget is measured at 800 px, or the largest reachable width below it.
  const budgetWidth = Math.max(...widths.filter((w) => w <= 800), widths[0]);

  const warnings = [];
  const heavy = [];
  await fs.mkdir(outDir, { recursive: true });
  const variants = [];

  const formats = [
    ["webp", "webp"],
    ["jpg", "jpeg"],
  ];
  for (const [format, kind] of formats) {
    let quality;
    if (cls === "letter") {
      quality = kind === "webp" ? t.webpQuality : t.jpegQuality;
    } else {
      const ladder = kind === "webp" ? t.webpLadder : t.jpegLadder;
      const budget = kind === "webp" ? t.webpBudget : t.jpegBudget;
      const r = await pickQuality(input, budgetWidth, format, ladder, budget);
      quality = r.quality;
      if (r.overBudget) {
        const msg = `Foto pesada: ${name} (${format} ${budgetWidth}px = ${Math.round(r.first.data.length / KB)} KB, límite ${Math.round(budget / KB)} KB)`;
        warnings.push(msg);
        heavy.push({ name, format, width: budgetWidth, bytes: r.first.data.length, budget });
      }
    }
    for (const w of widths) {
      const e = await encode(input, w, format, quality);
      const file = `${key12}-${w}.${format}`;
      await fs.writeFile(path.join(outDir, file), e.data);
      variants.push({ width: e.width, height: e.height, format, file, bytes: e.data.length });
    }
  }
  return { cls, variants, heavy, warnings };
}
