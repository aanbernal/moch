import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT, ALBUM_SRC } from "../lib/paths.mjs";

const run = (content, args = [], env = {}) =>
  spawnSync("node", ["scripts/seed.mjs", ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, CONTENT_DIR: content, ...env },
  });

const seed = JSON.parse(fs.readFileSync(path.join(ROOT, "seed", "chapters.seed.json"), "utf8"));
const groupShots = JSON.parse(fs.readFileSync(path.join(ROOT, "seed", "group-shots.json"), "utf8"));
const hasSrc = fs.existsSync(ALBUM_SRC);

test("no seed cover is a group shot and covers match the table", () => {
  assert.ok(groupShots.includes("ella-invita/img-20260929-wa0087.jpg"));
  for (const c of seed.chapters) {
    assert.equal(c.cover ?? null, seed.coverTable[c.slug]);
    assert.ok(!groupShots.includes(`${c.slug}/${c.cover}`));
    for (const m of c.media) if (m.from) assert.ok(!/setlog/i.test(m.from));
  }
  assert.equal(seed.chapters.find((c) => c.slug === "prologo").media[0].maxWidth, 800);
});

test("seed copies byte for byte, is idempotent and exits non-zero without source", { skip: !hasSrc }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seed-"));
  try {
    assert.equal(run(dir).status, 0);
    const a = fs.readFileSync(path.join(dir, "chapters/expo-aws/media/img-20260925-wa0032.jpg"));
    const b = fs.readFileSync(path.join(ALBUM_SRC, "new-drive/0925_Ensayo_expo_aws/IMG-20260925-WA0032.jpg"));
    assert.ok(a.equals(b));
    const before = fs.statSync(path.join(dir, "chapters/prologo/chapter.json")).mtimeMs;
    assert.equal(run(dir).status, 0);
    assert.equal(fs.statSync(path.join(dir, "chapters/prologo/chapter.json")).mtimeMs, before);
    assert.notEqual(run(dir, ["--force"], { ALBUM_SRC: path.join(dir, "nope") }).status, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
