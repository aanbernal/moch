import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { run } from "../lib/exec.mjs";
import { scaleDims, processVideo, probeVideo } from "../lib/media/video.mjs";

let dir;
let clip;
let longClip;

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "video-test-"));
  clip = path.join(dir, "in.mp4");
  longClip = path.join(dir, "long.mp4");
  // 1280x721 (odd height) with sine audio and metadata to be stripped.
  const a = await run("ffmpeg", [
    "-nostdin", "-y", "-f", "lavfi", "-i", "testsrc=size=1280x721:rate=10:duration=2",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
    "-metadata", "title=SECRETO", "-c:v", "mpeg4", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", clip,
  ]);
  assert.equal(a.code, 0, a.stderr);
  const b = await run("ffmpeg", [
    "-nostdin", "-y", "-f", "lavfi", "-i", "testsrc=size=64x64:rate=1:duration=130",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", longClip,
  ]);
  assert.equal(b.code, 0, b.stderr);
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("scaleDims caps the long edge at 960 and keeps sizes even", () => {
  assert.deepEqual(scaleDims(1920, 1080), { width: 960, height: 540 });
  assert.deepEqual(scaleDims(1080, 1920), { width: 540, height: 960 });
  assert.deepEqual(scaleDims(640, 480), { width: 640, height: 480 });
  assert.deepEqual(scaleDims(641, 481), { width: 640, height: 480 });
  assert.deepEqual(scaleDims(1280, 721), { width: 960, height: 540 });
});

test("processVideo encodes H.264/AAC, strips metadata, makes a poster", async () => {
  const r = await processVideo(clip, path.join(dir, "out"));
  assert.equal(r.width, 960);
  assert.equal(r.height % 2, 0);
  assert.deepEqual({ w: r.width, h: r.height }, { w: scaleDims(1280, 721).width, h: scaleDims(1280, 721).height });
  assert.ok(r.bytes < 6 * 1024 * 1024 && r.warnings.length === 0);
  assert.ok((await stat(r.posterSource)).size > 0);

  const p = await run("ffprobe", [
    "-v", "error", "-show_entries", "stream=codec_name,profile:format_tags", "-of", "json", r.video,
  ]);
  const info = JSON.parse(p.stdout);
  const codecs = info.streams.map((s) => s.codec_name).sort();
  assert.deepEqual(codecs, ["aac", "h264"]);
  assert.equal(info.streams.find((s) => s.codec_name === "h264").profile, "Main");
  assert.ok(!JSON.stringify(info.format?.tags ?? {}).includes("SECRETO"));
  assert.ok((await probeVideo(r.video)).duration > 1);
});

test("processVideo rejects clips longer than 120 s before encoding", async () => {
  await assert.rejects(processVideo(longClip, path.join(dir, "out2")), /120 s/);
});
