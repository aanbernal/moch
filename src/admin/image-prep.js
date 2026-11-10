// Client-side photo prep (design 2.4): resize to a 2400 px long edge, apply EXIF
// orientation, flatten on white, re-encode as JPEG (drops EXIF/GPS).

export function targetSize(width, height, longEdge = 2400) {
  const scale = Math.min(1, longEdge / Math.max(width, height));
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

// White fill BEFORE drawImage so transparent PNG pixels do not turn black in the JPEG.
export function drawFlattened(ctx, source, width, height) {
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(source, 0, 0, width, height);
}

// Pick the bitmap unless its size disagrees with the <img> (some browsers ignore
// orientation in createImageBitmap); then the <img> wins. Pure, for tests.
export function chooseDecoded(bitmap, img) {
  if (bitmap && img) {
    const agree = bitmap.width === img.naturalWidth && bitmap.height === img.naturalHeight;
    return agree
      ? { source: bitmap, width: bitmap.width, height: bitmap.height, kind: "bitmap" }
      : { source: img, width: img.naturalWidth, height: img.naturalHeight, kind: "img" };
  }
  if (img) return { source: img, width: img.naturalWidth, height: img.naturalHeight, kind: "img" };
  if (bitmap) return { source: bitmap, width: bitmap.width, height: bitmap.height, kind: "bitmap" };
  throw new Error("No se pudo leer la foto. Prueba con otra.");
}

export async function decodeOriented(file) {
  let bitmap = null;
  let img = null;
  let url = null;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    bitmap = null;
  }
  try {
    url = URL.createObjectURL(file);
    const el = new Image();
    el.src = url;
    await el.decode();
    img = el;
  } catch {
    img = null;
  }
  const chosen = chooseDecoded(bitmap, img);
  if (chosen.kind === "img" && bitmap && bitmap.close) bitmap.close();
  chosen.release = () => {
    if (url) URL.revokeObjectURL(url);
    if (chosen.kind === "bitmap" && bitmap.close) bitmap.close();
  };
  return chosen;
}

export function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("No se pudo preparar la foto."))), type, quality);
  });
}

const browserEnv = {
  decodeOriented,
  createCanvas: () => document.createElement("canvas"),
  canvasToBlob,
};

// `env` is injectable for tests.
export async function prepareImage(file, { longEdge = 2400, quality = 0.88 } = {}, env = browserEnv) {
  const decoded = await env.decodeOriented(file);
  try {
    const { width, height } = targetSize(decoded.width, decoded.height, longEdge);
    const canvas = env.createCanvas();
    canvas.width = width;
    canvas.height = height;
    drawFlattened(canvas.getContext("2d"), decoded.source, width, height);
    return await env.canvasToBlob(canvas, "image/jpeg", quality);
  } finally {
    if (decoded.release) decoded.release();
  }
}

// Prepared photos are always JPEG: "Foto 1.PNG" -> "Foto 1.jpg".
export function jpegName(name) {
  const i = String(name).lastIndexOf(".");
  return (i > 0 ? name.slice(0, i) : name) + ".jpg";
}
