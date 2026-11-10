import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { shipAdmin, checkAdminShip, buildAdminConfig } from "../lib/admin-ship.mjs";
import { mimeFor } from "../scripts/serve.mjs";
import { ROOT } from "../lib/paths.mjs";

let tmp;
before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "admin-ship-"));
  fs.mkdirSync(path.join(tmp, "content"));
  fs.writeFileSync(
    path.join(tmp, "content", "site.json"),
    JSON.stringify({ title: "T", repo: { owner: "o", repo: "r", branch: "main" } })
  );
  shipAdmin({ distDir: path.join(tmp, "dist"), contentDir: path.join(tmp, "content") });
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test("shipped copies are identical, JS MIME, no import in validate-core", () => {
  assert.deepEqual(checkAdminShip({ distDir: path.join(tmp, "dist"), mimeFor }), []);
});

test("validate-core.mjs source has no import and exports validateAll/TOP_LEVEL_KEYS", async () => {
  const src = fs.readFileSync(path.join(ROOT, "lib/validate-core.mjs"), "utf8");
  assert.ok(!/^\s*import\s/m.test(src));
  const m = await import(path.join(tmp, "dist/admin/validate-core.mjs"));
  assert.equal(typeof m.validateAll, "function");
  assert.ok(Array.isArray(m.TOP_LEVEL_KEYS));
  const s = await import(path.join(tmp, "dist/admin/slug.js"));
  assert.equal(typeof s.slugifyFileName, "function");
  assert.equal(typeof s.slugify, "function");
});

test("config.json is templated from site.json repo", () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(tmp, "dist/admin/config.json"), "utf8"));
  assert.deepEqual(cfg, { repo: { owner: "o", repo: "r", branch: "main" } });
  assert.deepEqual(JSON.parse(buildAdminConfig({})), { repo: {} });
});

test("nothing shipped is committed under src/admin", () => {
  assert.ok(!fs.existsSync(path.join(ROOT, "src/admin/validate-core.mjs")));
  assert.ok(!fs.existsSync(path.join(ROOT, "src/admin/slug.js")));
});

test("check reports an import and a missing file", () => {
  const d = path.join(tmp, "bad");
  fs.mkdirSync(path.join(d, "admin"), { recursive: true });
  fs.writeFileSync(path.join(d, "admin/validate-core.mjs"), 'import x from "./y.js";\n');
  const problems = checkAdminShip({ distDir: d, mimeFor });
  assert.ok(problems.some((p) => p.includes("contiene import")));
  assert.ok(problems.some((p) => p.includes("slug.js")));
});
