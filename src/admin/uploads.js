// Upload validation (design 2.4, Req 13.8-13.10, 20.5). Messages are plain Spanish
// and state the limit. Pure except readVideoDuration (browser only).
//
// File-name slugging comes from slug.js (copy of lib/slug.mjs). To keep this module
// importable in Node without that build copy, planUploads takes slugifyFileName as an option.

export const MB = 1024 * 1024;
export const EXTENSIONS = {
  photo: ["jpg", "jpeg", "png", "webp"],
  video: ["mp4", "mov", "m4v"],
  pdf: ["pdf"],
};
export const LIMITS = {
  videoMax: 25 * MB,
  videoWarn: 12 * MB,
  videoSeconds: 120,
  pdfMax: 25 * MB,
  maxFiles: 40,
  blobBase64Max: 34 * MB, // a 25 MB file encodes to ~33.3 MB; GitHub's blob API accepts this
};

export const MSG = {
  heic: "Las fotos HEIC no se pueden usar. Expórtalas como JPG o PNG e inténtalo de nuevo.",
  type: (name) => `No se puede subir "${name}". Solo se aceptan fotos (JPG, PNG, WebP), videos (MP4, MOV, M4V) y PDF.`,
  videoSize: (name) => `El video "${name}" pesa más de 25 MB. El máximo es 25 MB.`,
  videoWarn: (name) => `El video "${name}" pesa más de 12 MB. Puede tardar en subir; lo ideal es menos de 12 MB.`,
  videoSeconds: (name) => `El video "${name}" dura más de 120 segundos. El máximo es 120 segundos.`,
  pdfSize: (name) => `El PDF "${name}" pesa más de 25 MB. El máximo es 25 MB.`,
  blob: (name) => `"${name}" es demasiado grande para subirlo (el máximo es 34 MB ya codificado). Usa un archivo más pequeño.`,
  tooMany: "Son demasiados archivos. El máximo es 40 archivos por publicación.",
};

export function extOf(name) {
  const s = String(name);
  const i = s.lastIndexOf(".");
  return i > 0 && i < s.length - 1 ? s.slice(i + 1).toLowerCase() : "";
}

// "photo" | "video" | "pdf" | "heic" | null
export function classify(name) {
  const ext = extOf(name);
  if (ext === "heic" || ext === "heif") return "heic";
  for (const [kind, list] of Object.entries(EXTENSIONS)) if (list.includes(ext)) return kind;
  return null;
}

export function base64Size(bytes) {
  return 4 * Math.ceil(bytes / 3);
}

// file: { name, size, duration? } (duration in seconds, null/undefined if unreadable).
// Returns { kind, errors, warnings }. `size` for photos is the size of the prepared blob if known.
export function validateUpload(file) {
  const errors = [];
  const warnings = [];
  const kind = classify(file.name);
  if (kind === "heic") return { kind: null, errors: [MSG.heic], warnings };
  if (kind === null) return { kind: null, errors: [MSG.type(file.name)], warnings };

  if (kind === "video") {
    if (file.size > LIMITS.videoMax) errors.push(MSG.videoSize(file.name));
    else if (file.size > LIMITS.videoWarn) warnings.push(MSG.videoWarn(file.name));
    // Unreadable duration: accept, the build decides.
    if (typeof file.duration === "number" && file.duration > LIMITS.videoSeconds) {
      errors.push(MSG.videoSeconds(file.name));
    }
  }
  if (kind === "pdf" && file.size > LIMITS.pdfMax) errors.push(MSG.pdfSize(file.name));
  if (!errors.length && base64Size(file.size) > LIMITS.blobBase64Max) errors.push(MSG.blob(file.name));
  return { kind, errors, warnings };
}

// "a.jpg" taken -> "a-2.jpg" -> "a-3.jpg". Comparison is lowercase.
export function uniqueName(name, taken) {
  const used = new Set([...taken].map((n) => n.toLowerCase()));
  if (!used.has(name.toLowerCase())) return name;
  const i = name.lastIndexOf(".");
  const base = i > 0 ? name.slice(0, i) : name;
  const ext = i > 0 ? name.slice(i) : "";
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}${ext}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}

// Validates a batch and assigns final names.
// files: [{ name, size, duration? }]; existing: names already in the chapter folder.
// Returns { ok, errors, warnings, items: [{ original, name, kind }] }.
export function planUploads(files, { existing = [], slugifyFileName }) {
  if (typeof slugifyFileName !== "function") throw new TypeError("slugifyFileName es obligatorio");
  const errors = [];
  const warnings = [];
  const items = [];
  if (files.length > LIMITS.maxFiles) errors.push(MSG.tooMany);
  const taken = [...existing];
  for (const file of files) {
    const r = validateUpload(file);
    errors.push(...r.errors);
    warnings.push(...r.warnings);
    if (r.errors.length) continue;
    const name = uniqueName(slugifyFileName(file.name), taken);
    taken.push(name);
    items.push({ original: file.name, name, kind: r.kind });
  }
  return { ok: errors.length === 0, errors, warnings, items };
}

// Browser only: hidden <video> metadata. Resolves to seconds, or null if unreadable.
export function readVideoDuration(file, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(url);
      resolve(Number.isFinite(value) ? value : null);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    video.preload = "metadata";
    video.muted = true;
    video.onloadedmetadata = () => finish(video.duration);
    video.onerror = () => finish(null);
    video.src = url;
  });
}
