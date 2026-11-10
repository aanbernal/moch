import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { run } from "../exec.mjs";

export const MAX_EDGE = 960;
export const WARN_BYTES = 6 * 1024 * 1024;
export const FAIL_BYTES = 15 * 1024 * 1024;
export const MAX_DURATION_S = 120;

const evenFloor = (n) => Math.max(2, Math.floor(n / 2) * 2);
const evenRound = (n) => Math.max(2, Math.round(n / 2) * 2);

/**
 * Target dimensions: long edge at most 960, both sides even, aspect kept.
 * Mirrors the ffmpeg scale filter (the short side is derived like `-2`).
 */
export function scaleDims(w, h) {
  if (!(w > 0) || !(h > 0)) throw new Error(`Dimensiones de video inválidas: ${w}x${h}`);
  const landscape = w > h;
  const long = landscape ? w : h;
  const short = landscape ? h : w;
  const targetLong = evenFloor(Math.min(MAX_EDGE, long));
  const targetShort = evenRound((short * targetLong) / long);
  return landscape
    ? { width: targetLong, height: targetShort }
    : { width: targetShort, height: targetLong };
}

/** Design 6.3 ffmpeg arguments. The long edge is also forced even so x264 never sees odd sizes. */
export function ffmpegArgs(input, output) {
  const vf =
    "scale='if(gt(iw,ih),min(960,trunc(iw/2)*2),-2)':'if(gt(iw,ih),-2,min(960,trunc(ih/2)*2))',format=yuv420p";
  return [
    "-nostdin", "-y", "-i", input,
    "-map", "0:v:0", "-map", "0:a:0?", "-map_metadata", "-1", "-map_chapters", "-1",
    "-vf", vf,
    "-c:v", "libx264", "-preset", "slow", "-crf", "28", "-maxrate", "1400k", "-bufsize", "2800k",
    "-profile:v", "main", "-level", "4.0",
    "-c:a", "aac", "-b:a", "96k", "-ac", "2",
    "-movflags", "+faststart", output,
  ];
}

/** Probe first video stream size and container duration. */
export async function probeVideo(input) {
  const r = await run("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height:format=duration",
    "-of", "json", input,
  ]);
  if (r.code !== 0) throw new Error(`ffprobe falló para ${path.basename(input)}: ${r.stderr.trim()}`);
  const info = JSON.parse(r.stdout);
  const s = info.streams?.[0];
  const duration = Number(info.format?.duration);
  if (!s || !Number.isFinite(duration)) {
    throw new Error(`No se pudo leer el video ${path.basename(input)}`);
  }
  return { width: s.width, height: s.height, duration };
}

/**
 * Encode a clip and extract its poster frame.
 *
 * Returns { video, posterSource, width, height, duration, bytes, warnings }.
 * HOOK (task 4.4): `posterSource` is a JPEG file at full video resolution; the
 * orchestrator must feed it through the photo path (480/800 widths, JPEG/WebP)
 * and point `<video poster>` at the 800 px JPEG. This module does not depend on photo.mjs.
 *
 * Fails (throws) above 120 s or 15 MB; warnings (array of strings) above 6 MB.
 */
export async function processVideo(input, outDir, { name } = {}) {
  const label = name ?? path.basename(input);
  const probe = await probeVideo(input);
  if (probe.duration > MAX_DURATION_S) {
    throw new Error(
      `El video ${label} dura ${probe.duration.toFixed(1)} s; el máximo es ${MAX_DURATION_S} s.`,
    );
  }

  await mkdir(outDir, { recursive: true });
  const base = path.basename(input, path.extname(input));
  const video = path.join(outDir, `${base}.mp4`);
  const posterSource = path.join(outDir, `${base}.poster.jpg`);

  const enc = await run("ffmpeg", ffmpegArgs(input, video));
  if (enc.code !== 0) {
    throw new Error(`ffmpeg falló con ${label}: ${enc.stderr.trim().split("\n").slice(-3).join(" | ")}`);
  }

  const t = Math.min(1, probe.duration / 2);
  const pic = await run("ffmpeg", [
    "-nostdin", "-y", "-ss", String(t), "-i", video,
    "-frames:v", "1", "-map_metadata", "-1", "-q:v", "2", posterSource,
  ]);
  if (pic.code !== 0) {
    throw new Error(`No se pudo extraer el póster de ${label}: ${pic.stderr.trim().split("\n").pop()}`);
  }

  const { size: bytes } = await stat(video);
  const warnings = [];
  if (bytes > FAIL_BYTES) {
    throw new Error(
      `El video ${label} pesa ${(bytes / 1048576).toFixed(1)} MB tras comprimir; el máximo es 15 MB.`,
    );
  }
  if (bytes > WARN_BYTES) {
    warnings.push(`El video ${label} pesa ${(bytes / 1048576).toFixed(1)} MB (aviso por encima de 6 MB).`);
  }

  const out = await probeVideo(video);
  return {
    video,
    posterSource,
    width: out.width,
    height: out.height,
    duration: probe.duration,
    bytes,
    warnings,
  };
}
