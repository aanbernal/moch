import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startMockGithub } from "../scripts/mock-github.mjs";
import { createGitHubClient } from "../src/admin/github.js";

async function makeSeed() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mock-seed-"));
  await fs.mkdir(path.join(dir, "content/chapters/uno"), { recursive: true });
  await fs.writeFile(path.join(dir, "content/chapters/uno/chapter.json"), '{"title":"Uno"}\n');
  await fs.writeFile(path.join(dir, "content/site.json"), '{"title":"Album"}\n');
  return dir;
}

const R = "/repos/o/r";
const auth = (t = "test-token") => ({ Authorization: `Bearer ${t}`, Accept: "application/vnd.github+json" });
async function call(mock, method, p, body, token) {
  const res = await fetch(mock.url + p, {
    method,
    headers: { ...auth(token), ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null), res };
}

test("auth: 401 without/with bad token, 403 for read-only write, 404 unknown", async (t) => {
  const seed = await makeSeed();
  const mock = await startMockGithub({ seed });
  t.after(() => mock.close());
  assert.equal((await fetch(mock.url + R)).status, 401);
  assert.equal((await call(mock, "GET", R, null, "nope")).status, 401);
  const ok = await call(mock, "GET", R);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.permissions.push, true);
  const ro = await call(mock, "GET", R, null, "readonly-token");
  assert.equal(ro.body.permissions.push, false);
  assert.equal((await call(mock, "POST", R + "/git/blobs", { content: "x" }, "readonly-token")).status, 403);
  assert.equal((await call(mock, "GET", R + "/git/ref/heads/nope")).status, 404);
  assert.equal((await call(mock, "GET", "/other")).status, 404);
});

test("CORS: preflight 204 and headers on responses", async (t) => {
  const mock = await startMockGithub({ origin: "http://127.0.0.1:9999" });
  t.after(() => mock.close());
  const pre = await fetch(mock.url + R + "/git/refs/heads/main", {
    method: "OPTIONS",
    headers: { Origin: "http://127.0.0.1:9999", "Access-Control-Request-Method": "PATCH", "Access-Control-Request-Headers": "authorization,content-type" },
  });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("access-control-allow-origin"), "http://127.0.0.1:9999");
  assert.equal(pre.headers.get("vary"), "Origin");
  assert.match(pre.headers.get("access-control-allow-headers"), /Authorization.*Content-Type.*Accept.*X-GitHub-Api-Version/);
  assert.match(pre.headers.get("access-control-allow-methods"), /PATCH/);
  const r = await fetch(mock.url + R); // 401 still carries CORS
  assert.equal(r.headers.get("access-control-allow-origin"), "http://127.0.0.1:9999");
});

test("commit flow via the admin client, deletions, 422 hook and export", async (t) => {
  const seed = await makeSeed();
  const mock = await startMockGithub({ seed });
  t.after(() => mock.close());
  const client = createGitHubClient({ token: "test-token", owner: "o", repo: "r", apiBase: mock.url, hostname: "127.0.0.1", delay: async () => {} });
  await client.checkRepo();
  const first = mock.head();

  // First PATCH 422 -> client retries once and succeeds.
  mock.setHooks({ failFirstPatch: true });
  const b64 = (s) => Buffer.from(s).toString("base64");
  const { commitSha } = await client.publish({
    message: "Capítulo: Dos",
    files: [{ path: "content/chapters/dos/chapter.json", base64: b64('{"title":"Dos"}\n') }],
    deletePrefixes: ["content/chapters/uno/"],
  });
  assert.equal(mock.head(), commitSha);
  assert.equal(mock.commitCount(), 1);
  assert.equal(mock.hooks().failFirstPatch, false);

  const state = await client.readState();
  const paths = state.entries.filter((e) => e.type === "blob").map((e) => e.path).sort();
  assert.deepEqual(paths, ["content/chapters/dos/chapter.json", "content/site.json"]);

  // contents + blob round trip
  const c = await call(mock, "GET", R + "/contents/content/chapters/dos/chapter.json");
  assert.equal(Buffer.from(c.body.content, "base64").toString(), '{"title":"Dos"}\n');

  // compare / runs / jobs / build.json
  assert.equal((await call(mock, "GET", `${R}/compare/${first}...${commitSha}`)).body.status, "ahead");
  assert.equal((await call(mock, "GET", `${R}/compare/${commitSha}...${first}`)).body.status, "behind");
  const runs = await call(mock, "GET", `${R}/actions/runs?head_sha=${commitSha}`);
  assert.equal(runs.body.workflow_runs[0].conclusion, "success");
  const jobs = await call(mock, "GET", `${R}/actions/runs/${runs.body.workflow_runs[0].id}/jobs`);
  assert.equal(jobs.body.jobs[0].conclusion, "success");
  assert.equal((await (await fetch(mock.url + "/build.json")).json()).sha, commitSha);

  // failed run keeps the next deploy from being "served"
  mock.setHooks({ runConclusion: "failure" });
  const failed = await call(mock, "GET", `${R}/actions/runs?head_sha=${commitSha}`);
  assert.equal(failed.body.workflow_runs[0].conclusion, "failure");
  assert.equal((await (await fetch(mock.url + "/build.json")).json()).sha, first);
  await call(mock, "POST", "/__mock/hooks", { buildSha: "abc123" });
  assert.equal((await (await fetch(mock.url + "/build.json")).json()).sha, "abc123");

  // export to a directory
  const out = path.join(os.tmpdir(), `mock-export-${process.pid}-${Date.now()}`);
  t.after(() => fs.rm(out, { recursive: true, force: true }));
  const exp = await (await fetch(mock.url + "/__mock/export", { method: "POST", body: JSON.stringify({ dir: out }) })).json();
  assert.equal(exp.files, 2);
  assert.equal(await fs.readFile(path.join(out, "content/chapters/dos/chapter.json"), "utf8"), '{"title":"Dos"}\n');
  await assert.rejects(fs.stat(path.join(out, "content/chapters/uno")));
});

test("non fast-forward PATCH is 422 and force:true is accepted; request log tracks auth", async (t) => {
  const mock = await startMockGithub({ seed: await makeSeed() });
  t.after(() => mock.close());
  const head = await call(mock, "GET", R + "/git/ref/heads/main");
  const base = head.body.object.sha;
  const commit = await call(mock, "GET", `${R}/git/commits/${base}`);
  const mk = async (msg) => (await call(mock, "POST", R + "/git/commits", { message: msg, tree: commit.body.tree.sha, parents: [base] })).body.sha;
  const a = await mk("a");
  const b = await mk("b");
  assert.equal((await call(mock, "PATCH", R + "/git/refs/heads/main", { sha: a, force: false })).status, 200);
  assert.equal((await call(mock, "PATCH", R + "/git/refs/heads/main", { sha: b, force: false })).status, 422);
  assert.equal((await call(mock, "PATCH", R + "/git/refs/heads/main", { sha: b, force: true })).status, 200);
  assert.equal((await call(mock, "POST", R + "/git/trees", { tree: [{ path: "x", mode: "100644", type: "blob", sha: "0".repeat(40) }] })).status, 422);
  await fetch(mock.url + R);
  const log = mock.requests();
  assert.equal(log.at(-1).authenticated, false);
  assert.ok(log.some((r) => r.authenticated));
});
