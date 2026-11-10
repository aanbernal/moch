import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import path from "node:path";
import { spawnSync } from "node:child_process";

const GUARD = path.resolve(import.meta.dirname, "../scripts/guard.mjs");
const REAL_NAME = "Screenshot_2026-10-09-09-33-10-861_com.newchat.setlog-edit.jpg";
const SECRET = "denied-image-bytes";

let root;
const dir = (name) => path.join(root, name);
const write = (file, data = "x") => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
};
const run = (stage, env) =>
  spawnSync("node", [GUARD, stage], { env: { ...process.env, ...env }, encoding: "utf8" });

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "guard-cli-"));
  const chapter = (title) => JSON.stringify({ title, items: [{ alt: "ok" }] });

  write(dir("clean-content/c1/chapter.json"), chapter("Hola"));
  write(dir("clean-content/c1/foto.jpg"), "clean-bytes");
  write(dir("clean-dist/index.html"), "<p>hola</p>");

  write(dir("folder-content/c1-setlog/chapter.json"), chapter("Hola"));
  write(dir("json-content/c1/chapter.json"), chapter("Captura de SetLog"));
  write(dir("real-content/c1/chapter.json"), chapter("Hola"));
  write(dir(`real-content/c1/${REAL_NAME}`), "bytes");

  write(dir("name-dist/setlog-page.html"), "<p>hola</p>");
  write(dir("text-dist/index.html"), "<p>texto SETLOG aqui</p>");

  write(dir("hash-content/c1/chapter.json"), chapter("Hola"));
  write(dir("hash-content/c1/renamed-innocent.jpg"), SECRET);
  write(
    dir("denied.json"),
    JSON.stringify([{ label: "excluded-test", sha256: crypto.createHash("sha256").update(SECRET).digest("hex") }]),
  );
});

after(() => fs.rmSync(root, { recursive: true, force: true }));

test("pre: clean tree exits 0", () => {
  const r = run("pre", { CONTENT_DIR: dir("clean-content") });
  assert.equal(r.status, 0, r.stderr);
});

test("post: clean dist exits 0", () => {
  const r = run("post", { DIST_DIR: dir("clean-dist") });
  assert.equal(r.status, 0, r.stderr);
});

test("pre: hit in a folder name exits 3 naming the folder", () => {
  const r = run("pre", { CONTENT_DIR: dir("folder-content") });
  assert.equal(r.status, 3);
  assert.match(r.stderr, /guard pre.*c1-setlog/);
});

test("pre: hit in a JSON string exits 3 naming the file and pointer", () => {
  const r = run("pre", { CONTENT_DIR: dir("json-content") });
  assert.equal(r.status, 3);
  assert.match(r.stderr, /json.*chapter\.json \.title/);
});

test("pre: the real excluded file name exits 3", () => {
  const r = run("pre", { CONTENT_DIR: dir("real-content") });
  assert.equal(r.status, 3);
  assert.ok(r.stderr.includes(REAL_NAME), r.stderr);
});

test("pre: renamed file with a denied hash exits 3 with its label", () => {
  const r = run("pre", { CONTENT_DIR: dir("hash-content"), GUARD_DENIED_HASHES: dir("denied.json") });
  assert.equal(r.status, 3);
  assert.match(r.stderr, /hash excluded-test.*renamed-innocent\.jpg/);
});

test("post: hit in a dist file name exits 3", () => {
  const r = run("post", { DIST_DIR: dir("name-dist") });
  assert.equal(r.status, 3);
  assert.match(r.stderr, /guard post.*setlog-page\.html/);
});

test("post: hit in dist text exits 3 naming the file", () => {
  const r = run("post", { DIST_DIR: dir("text-dist") });
  assert.equal(r.status, 3);
  assert.match(r.stderr, /text.*index\.html/);
});
