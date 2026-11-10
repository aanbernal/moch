// Media orchestrator (design 6): validate, process into a content-addressed cache,
// rebuild build/media with only referenced outputs and write the manifests.
// Sources under CONTENT_DIR are only ever read.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BUILD_DIR, CACHE_DIR, CONTENT_DIR, PIPELINE_VERSION } from "../lib/paths.mjs";
import { checkTools } from "../lib/exec.mjs";
import { assertContentValid } from "../lib/validate.mjs";
import { processPhoto } from "../lib/media/photo.mjs";
import { processVideo, WARN_BYTES } from "../lib/media/video.mjs";
import { expandPdf } from "../lib/media/pdf.mjs";

const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");
const exists = (p) => fs.access(p).then(() => true, () => false);

/** Recursively sort object keys (arrays keep their order). */
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  }
  return v;
}

const sortVariants = (list) =>
  [...list].sort((a, b) => a.format.localeCompare(b.format) || a.width - b.width);

/** Dimensions advertised for an `<img>`: the jpg variant closest to 800 px without exceeding it. */
function primaryDims(variants) {
  const jpgs = variants.filter((v) => v.format === "jpg");
  const pool = jpgs.length ? jpgs : variants;
  const under = pool.filter((v) => v.width <= 800);
  const pick = under.length
    ? under.reduce((a, b) => (b.width > a.width ? b : a))
    : pool.reduce((a, b) => (b.width < a.width ? b : a));
  return { width: pick.width, height: pick.height };
}

const manifestVariants = (variants) =>
  sortVariants(variants).map((v) => ({
    format: v.format,
    height: v.height,
    url: `/m/${v.file}`,
    width: v.width,
  }));

export async function runMedia({
  contentDir = CONTENT_DIR,
  buildDir = BUILD_DIR,
  cacheDir = CACHE_DIR,
  version = PIPELINE_VERSION,
  log = console.log,
} = {}) {
  // Fix 6: tools and validation before any sharp, ffmpeg or pdftoppm call.
  await checkTools();
  await assertContentValid({ contentDir });

  const chaptersRoot = path.join(contentDir, "chapters");
  let slugs = [];
  try {
    slugs = (await fs.readdir(chaptersRoot, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }

  await fs.mkdir(cacheDir, { recursive: true });

  const owners = new Map(); // output name -> full key (collision check)
  const done = new Map(); // full key -> cache result (processed once per run)
  const stats = { processed: 0, reused: 0 };
  const referenced = new Map(); // output name -> absolute cache path
  const manifest = {};
  const report = { warnings: [], heavy: [], openItems: [] };

  const keyOf = (hash, settings) => sha256(`${hash}\0${version}\0${settings}`);

  /** Run `produce(tmpDir)` unless `<cacheDir>/<key>/result.json` exists; returns {dir, meta}. */
  async function cached(key, produce) {
    if (done.has(key)) return done.get(key);
    const dir = path.join(cacheDir, key);
    const metaFile = path.join(dir, "result.json");
    let meta;
    if (await exists(metaFile)) {
      meta = JSON.parse(await fs.readFile(metaFile, "utf8"));
      stats.reused += 1;
    } else {
      const tmp = path.join(cacheDir, `${key}.tmp-${process.pid}`);
      await fs.rm(tmp, { recursive: true, force: true });
      await fs.mkdir(tmp, { recursive: true });
      meta = await produce(tmp);
      await fs.writeFile(path.join(tmp, "result.json"), JSON.stringify(meta));
      await fs.rm(dir, { recursive: true, force: true });
      await fs.rename(tmp, dir);
      stats.processed += 1;
    }
    const result = { dir, meta, key };
    done.set(key, result);
    return result;
  }

  function claim(files, key) {
    for (const f of files) {
      const owner = owners.get(f);
      if (owner && owner !== key) {
        throw new Error(`Dos claves distintas producen el mismo archivo "${f}" (${owner.slice(0, 12)} y ${key.slice(0, 12)})`);
      }
      owners.set(f, key);
    }
  }

  function use(result, files) {
    claim(files, result.key);
    for (const f of files) referenced.set(f, path.join(result.dir, f));
  }

  function recordHeavy(label, heavy) {
    for (const h of heavy) {
      report.heavy.push({ name: label, format: h.format, width: h.width, bytes: h.bytes, budget: h.budget });
      report.warnings.push(
        `Foto pesada: ${label} (${h.format} ${h.width}px = ${Math.round(h.bytes / 1024)} KB, límite ${Math.round(h.budget / 1024)} KB)`,
      );
    }
  }

  /** Photo from any path; `hash` identifies the source bytes. */
  async function photo({ input, hash, frame, maxWidth, label, settingsExtra = "" }) {
    const key = keyOf(hash, `photo|frame=${frame ?? ""}|maxWidth=${maxWidth ?? ""}${settingsExtra}`);
    const r = await cached(key, async (tmp) => {
      const p = await processPhoto({ input, outDir: tmp, key12: key.slice(0, 12), frame, maxWidth, name: label });
      return { cls: p.cls, variants: p.variants, heavy: p.heavy };
    });
    use(r, r.meta.variants.map((v) => v.file));
    recordHeavy(label, r.meta.heavy);
    return r.meta;
  }

  for (const slug of slugs) {
    const chDir = path.join(chaptersRoot, slug);
    const json = JSON.parse(await fs.readFile(path.join(chDir, "chapter.json"), "utf8"));
    for (const item of json.media ?? []) {
      if (item.type === "quote") continue;
      const label = `${slug}/${item.file}`;
      const src = path.join(chDir, "media", item.file);
      const bytes = await fs.readFile(src);
      const hash = sha256(bytes);

      if (item.type === "photo") {
        const m = await photo({ input: bytes, hash, frame: item.frame, maxWidth: item.maxWidth, label });
        manifest[label] = {
          kind: "photo",
          ...primaryDims(m.variants),
          variants: manifestVariants(m.variants),
        };
      } else if (item.type === "video") {
        const key = keyOf(hash, "video");
        const r = await cached(key, async (tmp) => {
          const key12 = key.slice(0, 12);
          const work = path.join(tmp, "work");
          const v = await processVideo(src, work, { name: label });
          const videoFile = `${key12}.mp4`;
          await fs.rename(v.video, path.join(tmp, videoFile));
          const poster = await processPhoto({
            input: v.posterSource, outDir: tmp, key12, name: `${label} (póster)`,
          });
          await fs.rm(work, { recursive: true, force: true });
          return {
            videoFile, width: v.width, height: v.height,
            duration: Math.round(v.duration * 1000) / 1000, bytes: v.bytes,
            poster: { variants: poster.variants, heavy: poster.heavy },
          };
        });
        const m = r.meta;
        use(r, [m.videoFile, ...m.poster.variants.map((v) => v.file)]);
        recordHeavy(`${label} (póster)`, m.poster.heavy);
        if (m.bytes > WARN_BYTES) {
          report.warnings.push(`El video ${label} pesa ${(m.bytes / 1048576).toFixed(1)} MB (aviso por encima de 6 MB).`);
        }
        manifest[label] = {
          kind: "video",
          duration: m.duration,
          height: m.height,
          poster: { ...primaryDims(m.poster.variants), variants: manifestVariants(m.poster.variants) },
          url: `/m/${m.videoFile}`,
          width: m.width,
        };
      } else if (item.type === "pdf") {
        const x = await expandPdf({
          file: src, name: item.file, pages: item.pages, alt: item.alt ?? "", frame: "letter",
          cacheRoot: path.join(cacheDir, `v${version}`),
          isLetter: /para[-_ ]?manuel/i.test(item.file),
        });
        for (const o of x.openItems) report.openItems.push(`${label}: ${o}`);
        const pages = [];
        for (const p of x.items) {
          const pngBytes = await fs.readFile(p.file);
          const m = await photo({
            input: pngBytes, hash: sha256(pngBytes), frame: "letter",
            label: `${label} p.${p.page}`, settingsExtra: "|pdfpage",
          });
          pages.push({
            alt: p.alt,
            frame: "letter",
            page: p.page,
            type: "photo",
            ...primaryDims(m.variants),
            variants: manifestVariants(m.variants),
          });
        }
        manifest[label] = { kind: "pdf", pageCount: x.pageCount, pages };
      }
    }
  }

  // Rebuild build/media with only the referenced outputs.
  const mediaDir = path.join(buildDir, "media");
  await fs.rm(mediaDir, { recursive: true, force: true });
  await fs.mkdir(mediaDir, { recursive: true });
  for (const name of [...referenced.keys()].sort()) {
    await fs.copyFile(referenced.get(name), path.join(mediaDir, name));
  }

  report.warnings = [...new Set(report.warnings)].sort();
  report.openItems = [...new Set(report.openItems)].sort();
  report.heavy.sort((a, b) => a.name.localeCompare(b.name) || a.format.localeCompare(b.format));

  const sortedManifest = sortKeys(manifest);
  const sortedReport = sortKeys(report);
  await fs.writeFile(
    path.join(buildDir, "media-manifest.json"),
    `${JSON.stringify(sortedManifest, null, 2)}\n`,
  );
  await fs.writeFile(
    path.join(buildDir, "media-report.json"),
    `${JSON.stringify(sortedReport, null, 2)}\n`,
  );

  log(
    `Medios: ${Object.keys(manifest).length} elementos, ${stats.processed} procesados, ${stats.reused} reutilizados del caché.`,
  );
  for (const w of report.warnings) log(`Aviso: ${w}`);
  return { manifest: sortedManifest, report: sortedReport, stats };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runMedia().catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
  });
}
