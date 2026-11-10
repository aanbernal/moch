import test from "node:test";
import assert from "node:assert/strict";
import { createGitHubClient, resolveApiBase, GitHubError, MSG } from "../src/admin/github.js";

const TOKEN = "github_pat_SECRET";

function json(status, body) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

// Router stub: handlers keyed "METHOD path-prefix" -> fn(call) | response | array of responses.
function makeStub(routes) {
  const calls = [];
  const counters = {};
  const fetch = async (url, init) => {
    const path = new URL(url).pathname + new URL(url).search;
    const key = Object.keys(routes).find((k) => {
      const [m, p] = k.split(" ");
      return m === init.method && path.startsWith("/repos/o/r" + p);
    });
    calls.push({ method: init.method, path, body: init.body ? JSON.parse(init.body) : undefined, headers: init.headers });
    assert.ok(key, `unexpected ${init.method} ${path}`);
    let h = routes[key];
    if (Array.isArray(h)) {
      counters[key] = (counters[key] ?? -1) + 1;
      h = h[Math.min(counters[key], h.length - 1)];
    }
    if (typeof h === "function") h = h();
    if (h instanceof Error) throw h;
    return h;
  };
  return { fetch, calls };
}

function client(routes, extra = {}) {
  const delays = [];
  const stub = makeStub(routes);
  const c = createGitHubClient({
    token: TOKEN, owner: "o", repo: "r", fetch: stub.fetch,
    delay: async (ms) => { delays.push(ms); }, ...extra,
  });
  return { c, delays, calls: stub.calls };
}

const happy = (over = {}) => ({
  "GET /git/ref/heads/main": json(200, { object: { sha: "c1" } }),
  "GET /git/commits/": json(200, { tree: { sha: "t1" } }),
  "GET /git/trees/": json(200, { truncated: false, tree: [
    { path: "content/chapters/x/chapter.json", type: "blob" },
    { path: "content/chapters/x/media/a.jpg", type: "blob" },
    { path: "content/site.json", type: "blob" },
  ] }),
  "POST /git/blobs": json(201, { sha: "b1" }),
  "POST /git/trees": json(201, { sha: "t2" }),
  "POST /git/commits": json(201, { sha: "c2" }),
  "PATCH /git/refs/heads/main": json(200, {}),
  ...over,
});

test("checkRepo rejects permissions.push === false", async () => {
  const { c } = client({ "GET ": json(200, { permissions: { push: false } }) });
  await assert.rejects(c.checkRepo(), { code: "no-push" });
});

test("checkRepo tolerates absent permissions and accepts push true", async () => {
  assert.ok(await client({ "GET ": json(200, { name: "r" }) }).c.checkRepo());
  assert.ok(await client({ "GET ": json(200, { permissions: { push: true } }) }).c.checkRepo());
});

test("401/403/404 map to Spanish messages", async () => {
  for (const [status, text] of [[401, "El token no es válido o venció"], [403, "sin permiso"], [404, "No encuentro el repositorio"]]) {
    const { c } = client({ "GET ": json(status, {}) });
    await assert.rejects(c.checkRepo(), (e) => e instanceof GitHubError && e.message.includes(text));
  }
});

test("publish performs steps 1-6 with force:false, sha:null deletions, bearer token only in header", async () => {
  const { c, calls } = client(happy());
  const res = await c.publish({
    message: "Capítulo: X",
    files: [{ path: "content/chapters/y/chapter.json", base64: "e30=" }],
    deletePrefixes: ["content/chapters/x/"],
  });
  assert.equal(res.commitSha, "c2");
  const treeCall = calls.find((x) => x.method === "POST" && x.path.endsWith("/git/trees"));
  assert.equal(treeCall.body.base_tree, "t1");
  const dels = treeCall.body.tree.filter((e) => e.sha === null).map((e) => e.path);
  assert.deepEqual(dels, ["content/chapters/x/chapter.json", "content/chapters/x/media/a.jpg"]);
  const patch = calls.find((x) => x.method === "PATCH");
  assert.equal(patch.body.force, false);
  assert.equal(patch.body.sha, "c2");
  for (const call of calls) assert.ok(!JSON.stringify(call.body ?? {}).includes(TOKEN));
});

test("truncated tree is refused and nothing is written", async () => {
  const { c, calls } = client(happy({ "GET /git/trees/": json(200, { truncated: true, tree: [] }) }));
  await assert.rejects(c.publish({ message: "m", files: [{ path: "a", base64: "" }] }), { code: "truncated", message: MSG.truncated });
  assert.ok(calls.every((x) => x.method === "GET"));
});

test("422 on PATCH re-reads the ref and retries once", async () => {
  const { c, calls } = client(happy({
    "GET /git/ref/heads/main": [json(200, { object: { sha: "c1" } }), json(200, { object: { sha: "c9" } })],
    "PATCH /git/refs/heads/main": [json(422, {}), json(200, {})],
  }));
  const res = await c.publish({ message: "m", files: [{ path: "a", base64: "" }] });
  assert.equal(res.commitSha, "c2");
  assert.equal(calls.filter((x) => x.method === "PATCH").length, 2);
  const commits = calls.filter((x) => x.method === "POST" && x.path.endsWith("/git/commits"));
  assert.deepEqual(commits.map((x) => x.body.parents[0]), ["c1", "c9"]);
});

test("second 422 shows the conflict message", async () => {
  const { c } = client(happy({ "PATCH /git/refs/heads/main": json(422, {}) }));
  await assert.rejects(c.publish({ message: "m" }), { code: "conflict", message: "Alguien más cambió el álbum. Recarga e inténtalo otra vez." });
});

test("5xx retries twice with 1 s and 3 s delays, then succeeds", async () => {
  const { c, delays } = client(happy({ "POST /git/blobs": [json(502, {}), json(503, {}), json(201, { sha: "b1" })] }));
  await c.publish({ message: "m", files: [{ path: "a", base64: "" }] });
  assert.deepEqual(delays, [1000, 3000]);
});

test("persistent network failure gives up after 2 retries with the publish message", async () => {
  const { c, delays } = client(happy({ "POST /git/blobs": new TypeError("fetch failed") }));
  await assert.rejects(c.publish({ message: "m", files: [{ path: "a", base64: "" }] }), (e) => e.message.startsWith("No se pudo publicar. No se perdió nada"));
  assert.deepEqual(delays, [1000, 3000]);
});

test("apiBase override is honoured only on localhost/127.0.0.1", () => {
  assert.equal(resolveApiBase("http://127.0.0.1:9/", "localhost"), "http://127.0.0.1:9");
  assert.equal(resolveApiBase("http://127.0.0.1:9", "127.0.0.1"), "http://127.0.0.1:9");
  assert.equal(resolveApiBase("http://evil.test", "album-x.pages.dev"), "https://api.github.com");
  assert.equal(resolveApiBase("http://evil.test", undefined), "https://api.github.com");
});
