import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import path from "node:path";
import { spawnSync } from "node:child_process";
import fc from "fast-check";
import { isSetlog, scanPaths, scanJsonStrings, scanTextFiles, scanHashes } from "../lib/setlog-guard.mjs";

const GUARD = path.resolve(import.meta.dirname, "../scripts/guard.mjs");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "guard-"));

test("isSetlog matches anywhere in the path, case-insensitive", () => {
  assert.equal(isSetlog("a/b/SetLog-1.mov"), true);
  assert.equal(isSetlog("x/com.newchat.setlog-edit.jpg"), true);
  assert.equal(isSetlog("a/b/foto.jpg"), false);
});

test("property: any string containing setlog (any case) is flagged", () => {
  fc.assert(
    fc.property(fc.string(), fc.string(), fc.constantFrom("setlog", "SETLOG", "SetLog"), (a, b, w) =>
      isSetlog(a + w + b),
    ),
  );
});

test("scanPaths, scanJsonStrings, scanTextFiles, scanHashes find offenders", () => {
  const d = tmp();
  fs.mkdirSync(path.join(d, "ch"));
  fs.writeFileSync(path.join(d, "ch", "my-setlog.jpg"), "x");
  fs.writeFileSync(path.join(d, "ch", "chapter.json"), JSON.stringify({ a: [{ b: "ok" }, { c: "xSETLOGx" }] }));
  fs.writeFileSync(path.join(d, "p.html"), "<p>setlog</p>");
  fs.writeFileSync(path.join(d, "q.html"), "<p>clean</p>");
  fs.writeFileSync(path.join(d, "ch", "pic.bin"), "secret-bytes");
  assert.equal(scanPaths(d).length, 1);
  assert.equal(scanJsonStrings([path.join(d, "ch", "chapter.json")]).length, 1);
  assert.deepEqual(scanTextFiles(d).map((h) => h.where), ["ch/chapter.json", "p.html"]);
  const sha = crypto.createHash("sha256").update("secret-bytes").digest("hex");
  const hits = scanHashes([path.join(d, "ch", "pic.bin")], [{ label: "excluded-9", sha256: sha }]);
  assert.equal(hits[0].label, "excluded-9");
  fs.rmSync(d, { recursive: true });
});

test("guard CLI: exit 3 on hit, 0 when clean, clear error when dir missing", () => {
  const content = tmp();
  fs.writeFileSync(path.join(content, "site.json"), JSON.stringify({ title: "ok" }));
  const run = (stage, env) =>
    spawnSync("node", [GUARD, stage], { env: { ...process.env, ...env }, encoding: "utf8" });
  assert.equal(run("pre", { CONTENT_DIR: content }).status, 0);
  fs.writeFileSync(path.join(content, "SETLOG.mov"), "x");
  const bad = run("pre", { CONTENT_DIR: content });
  assert.equal(bad.status, 3);
  assert.match(bad.stderr, /guard pre.*SETLOG\.mov/);
  const missing = run("post", { DIST_DIR: path.join(content, "nope") });
  assert.notEqual(missing.status, 3);
  assert.match(missing.stderr, /DIST_DIR no existe/);
  fs.rmSync(content, { recursive: true });
});
