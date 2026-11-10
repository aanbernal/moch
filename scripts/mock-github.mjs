#!/usr/bin/env node
// Local mock of the GitHub REST API subset used by the admin (design 2.4, 2.6, 14.4).
// In-memory git repo seeded from a directory (the directory is the repo root, so
// <seed>/content/... is "content/..." in the repo). Real status codes, full CORS,
// control hooks under /__mock/. No real network access is ever made.
//
// CLI: node scripts/mock-github.mjs --seed <dir> [--port N] [--origin <serve origin>]
//        [--token test-token] [--owner O] [--repo R] [--fail-first-patch]
//        [--run-conclusion success|failure|pending] [--build-sha <sha>]
//
// Hooks (CLI flags or POST /__mock/hooks with JSON):
//   failFirstPatch  true  -> the next PATCH git/refs answers 422 once, then clears
//   runConclusion   "success" | "failure" | "pending" (evaluated at query time)
//   buildSha        string|null -> sha served by GET /build.json (null = follow deploys)
// Control: GET /__mock/state, GET /__mock/requests, POST /__mock/export {dir},
//          POST /__mock/hooks, POST /__mock/reset.
//
// Object ids: blobs use real git hashing; trees and commits are flat/synthetic
// (stable and unique, not byte-identical to git).

import http from "node:http";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const DEFAULT_TOKEN = "test-token";
export const READONLY_TOKEN = "readonly-token";
const ALLOW_HEADERS = "Authorization, Content-Type, Accept, X-GitHub-Api-Version";
const ALLOW_METHODS = "GET, POST, PATCH, PUT, DELETE, OPTIONS";
const MAX_BODY = 120 * 1024 * 1024;
const SKIP_DIRS = new Set([".git", "node_modules"]);

const sha1 = (...parts) => {
  const h = crypto.createHash("sha1");
  for (const p of parts) h.update(p);
  return h.digest("hex");
};
const blobSha = (buf) => sha1(`blob ${buf.length}\0`, buf);

async function walk(dir, rel = "") {
  const out = [];
  for (const e of await fs.readdir(path.join(dir, rel), { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      out.push(...(await walk(dir, path.posix.join(rel, e.name))));
    } else if (e.isFile()) {
      out.push(path.posix.join(rel, e.name));
    }
  }
  return out;
}

function isSafeRepoPath(p) {
  return typeof p === "string" && p.length > 0 && !p.startsWith("/") && !p.split("/").some((s) => s === "" || s === "." || s === "..");
}

/** Create the mock. Returns { start, close, ... } (see below). */
export async function startMockGithub({
  seed = null,
  port = 0,
  host = "127.0.0.1",
  origin = null, // Access-Control-Allow-Origin value (the serve origin); null -> "*"
  token = DEFAULT_TOKEN,
  readonlyToken = READONLY_TOKEN,
  owner = null, // null accepts any owner/repo
  repo = null,
  branch = "main",
  failFirstPatch = false,
  runConclusion = "success",
  buildSha = null,
} = {}) {
  const blobs = new Map(); // sha -> Buffer
  const trees = new Map(); // sha -> Map(path -> {mode, sha})
  const commits = new Map(); // sha -> {sha, tree, parents, message, date, n}
  const runs = []; // {id, head_sha, head_branch, created}
  const refs = new Map(); // branch -> commit sha
  const log = []; // {method, path, authenticated, status}
  let hooks;
  let counter = 0;
  let initialSha;

  const defaults = () => ({ failFirstPatch, runConclusion, buildSha });
  hooks = defaults();

  function storeTree(entries) {
    const sorted = [...entries.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
    const sha = sha1("tree\0", sorted.map(([p, e]) => `${e.mode} ${p}\0${e.sha}\n`).join(""));
    if (!trees.has(sha)) trees.set(sha, new Map(sorted));
    return sha;
  }

  function storeCommit({ tree, parents, message }) {
    const n = ++counter;
    const date = new Date().toISOString();
    const sha = sha1(`commit\0${tree}\0${parents.join(",")}\0${message}\0${date}\0${n}`);
    commits.set(sha, { sha, tree, parents, message, date, n });
    return commits.get(sha);
  }

  async function seedRepo() {
    blobs.clear(); trees.clear(); commits.clear(); runs.length = 0; refs.clear();
    const entries = new Map();
    if (seed) {
      for (const rel of await walk(path.resolve(seed))) {
        const buf = await fs.readFile(path.join(path.resolve(seed), rel));
        const sha = blobSha(buf);
        blobs.set(sha, buf);
        entries.set(rel, { mode: "100644", sha });
      }
    }
    const c = storeCommit({ tree: storeTree(entries), parents: [], message: "Seed" });
    refs.set(branch, c.sha);
    initialSha = c.sha;
  }
  await seedRepo();

  const originRef = { value: null };

  // ---- helpers -----------------------------------------------------------
  function isAncestor(ancestor, descendant) {
    const seen = new Set();
    const stack = [descendant];
    while (stack.length) {
      const s = stack.pop();
      if (s === ancestor) return true;
      if (seen.has(s)) continue;
      seen.add(s);
      const c = commits.get(s);
      if (c) stack.push(...c.parents);
    }
    return false;
  }
  function countUnique(from, notIn) {
    const exclude = new Set();
    const stack = [notIn];
    while (stack.length) {
      const s = stack.pop();
      if (exclude.has(s)) continue;
      exclude.add(s);
      const c = commits.get(s);
      if (c) stack.push(...c.parents);
    }
    let n = 0;
    const seen = new Set();
    const st = [from];
    while (st.length) {
      const s = st.pop();
      if (seen.has(s) || exclude.has(s)) continue;
      seen.add(s);
      n++;
      const c = commits.get(s);
      if (c) st.push(...c.parents);
    }
    return n;
  }
  function runView(r) {
    const base = { id: r.id, name: "deploy", head_sha: r.head_sha, head_branch: r.head_branch, event: "push", html_url: `${originRef.value}/runs/${r.id}`, created_at: r.created };
    if (hooks.runConclusion === "pending") return { ...base, status: "in_progress", conclusion: null };
    return { ...base, status: "completed", conclusion: hooks.runConclusion };
  }
  function deployedSha() {
    if (hooks.buildSha) return hooks.buildSha;
    let sha = refs.get(branch);
    while (sha) {
      if (sha === initialSha) return sha;
      const r = runs.find((x) => x.head_sha === sha);
      if (r && runView(r).conclusion === "success") return sha;
      sha = commits.get(sha)?.parents[0];
    }
    return initialSha;
  }
  function treeEntries(sha, recursive) {
    const flat = trees.get(sha);
    const out = [];
    const dirs = new Map();
    for (const [p, e] of flat) {
      const parts = p.split("/");
      for (let i = 1; i < parts.length; i++) {
        const d = parts.slice(0, i).join("/");
        if (!dirs.has(d)) dirs.set(d, sha1("dir\0", d, "\0", sha));
      }
    }
    const inRoot = (p) => !p.includes("/");
    for (const [d, dsha] of dirs) if (recursive || inRoot(d)) out.push({ path: d, mode: "040000", type: "tree", sha: dsha });
    for (const [p, e] of flat) if (recursive || inRoot(p)) out.push({ path: p, mode: e.mode, type: "blob", sha: e.sha, size: blobs.get(e.sha)?.length ?? 0 });
    return out.sort((a, b) => (a.path < b.path ? -1 : 1));
  }

  async function exportTo(dir) {
    const target = path.resolve(dir);
    const cwd = process.cwd();
    const inside = (root) => target !== root && target.startsWith(root + path.sep);
    if (!inside(cwd) && !inside(os.tmpdir())) throw new Error(`export dir must be inside the working directory or tmp: ${target}`);
    await fs.rm(target, { recursive: true, force: true });
    await fs.mkdir(target, { recursive: true });
    const flat = trees.get(commits.get(refs.get(branch)).tree);
    for (const [p, e] of flat) {
      const file = path.join(target, ...p.split("/"));
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, blobs.get(e.sha));
    }
    return { dir: target, files: flat.size };
  }

  // ---- HTTP --------------------------------------------------------------
  function cors(res) {
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Expose-Headers", "ETag, Link, X-RateLimit-Remaining");
  }
  function send(res, status, body, extra = {}) {
    cors(res);
    const text = body === undefined || body === null ? "" : JSON.stringify(body);
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extra,
    });
    res.end(status === 204 ? undefined : text);
  }
  const err = (res, status, message) => send(res, status, { message, documentation_url: "https://docs.github.com/rest" });

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on("data", (c) => {
        size += c.length;
        if (size > MAX_BODY) { reject(Object.assign(new Error("too large"), { status: 413 })); req.destroy(); return; }
        chunks.push(c);
      });
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });
  }
  async function readJson(req) {
    const buf = await readBody(req);
    if (!buf.length) return {};
    try { return JSON.parse(buf.toString("utf8")); } catch { throw Object.assign(new Error("Problems parsing JSON"), { status: 400 }); }
  }

  async function handleControl(req, res, url) {
    const p = url.pathname;
    if (p === "/__mock/state" && req.method === "GET") {
      const head = refs.get(branch);
      return send(res, 200, { head, initial: initialSha, hooks, commits: countUnique(head, initialSha), deployed: deployedSha(), runs: runs.map(runView) });
    }
    if (p === "/__mock/requests" && req.method === "GET") return send(res, 200, { requests: log });
    if (p === "/__mock/hooks" && (req.method === "POST" || req.method === "PUT")) {
      const body = await readJson(req);
      for (const k of Object.keys(body)) if (!(k in hooks)) return err(res, 422, `Unknown hook ${k}`);
      if ("runConclusion" in body && !["success", "failure", "pending"].includes(body.runConclusion)) return err(res, 422, "Bad runConclusion");
      Object.assign(hooks, body);
      return send(res, 200, hooks);
    }
    if (p === "/__mock/export" && req.method === "POST") {
      const body = await readJson(req);
      if (!body.dir) return err(res, 422, "dir required");
      try { return send(res, 200, await exportTo(body.dir)); } catch (e) { return err(res, 422, e.message); }
    }
    if (p === "/__mock/reset" && req.method === "POST") {
      await seedRepo();
      hooks = defaults();
      log.length = 0;
      return send(res, 200, { head: refs.get(branch) });
    }
    return err(res, 404, "Not Found");
  }

  async function handleApi(req, res, url, auth) {
    const m = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/);
    if (!m) return err(res, 404, "Not Found");
    const [, o, r, rest = ""] = m;
    if ((owner && decodeURIComponent(o) !== owner) || (repo && decodeURIComponent(r) !== repo)) return err(res, 404, "Not Found");
    const canWrite = auth === "write";
    const write = () => {
      if (!canWrite) { err(res, 403, "Resource not accessible by personal access token"); return false; }
      return true;
    };
    const method = req.method;

    if (rest === "" && method === "GET") {
      return send(res, 200, { full_name: `${decodeURIComponent(o)}/${decodeURIComponent(r)}`, private: true, default_branch: branch, permissions: { admin: false, push: canWrite, pull: true } });
    }

    let mm;
    if ((mm = rest.match(/^\/git\/ref\/heads\/(.+)$/)) && method === "GET") {
      const b = decodeURIComponent(mm[1]);
      if (!refs.has(b)) return err(res, 404, "Not Found");
      return send(res, 200, { ref: `refs/heads/${b}`, object: { sha: refs.get(b), type: "commit" } });
    }

    if ((mm = rest.match(/^\/git\/commits\/([0-9a-f]+)$/)) && method === "GET") {
      const c = commits.get(mm[1]);
      if (!c) return err(res, 404, "Not Found");
      return send(res, 200, { sha: c.sha, message: c.message, tree: { sha: c.tree }, parents: c.parents.map((sha) => ({ sha })), author: { date: c.date } });
    }
    if (rest === "/git/commits" && method === "POST") {
      if (!write()) return;
      const b = await readJson(req);
      if (typeof b.message !== "string" || !b.message) return err(res, 422, "Invalid request. message is required");
      if (!trees.has(b.tree)) return err(res, 422, "Tree SHA does not exist");
      const parents = b.parents ?? [];
      if (!Array.isArray(parents) || parents.some((p) => !commits.has(p))) return err(res, 422, "Parent SHA does not exist");
      const c = storeCommit({ tree: b.tree, parents, message: b.message });
      return send(res, 201, { sha: c.sha, message: c.message, tree: { sha: c.tree }, parents: c.parents.map((sha) => ({ sha })) });
    }

    if ((mm = rest.match(/^\/git\/trees\/([0-9a-f]+)$/)) && method === "GET") {
      if (!trees.has(mm[1])) return err(res, 404, "Not Found");
      return send(res, 200, { sha: mm[1], tree: treeEntries(mm[1], url.searchParams.has("recursive")), truncated: false });
    }
    if (rest === "/git/trees" && method === "POST") {
      if (!write()) return;
      const b = await readJson(req);
      if (!Array.isArray(b.tree)) return err(res, 422, "Invalid request. tree must be an array");
      let entries = new Map();
      if (b.base_tree) {
        if (!trees.has(b.base_tree)) return err(res, 422, "base_tree does not exist");
        entries = new Map(trees.get(b.base_tree));
      }
      for (const t of b.tree) {
        if (!t || !isSafeRepoPath(t.path)) return err(res, 422, "Invalid tree path");
        if (t.sha === null) { entries.delete(t.path); continue; }
        if (typeof t.content === "string") {
          const buf = Buffer.from(t.content, "utf8");
          const sha = blobSha(buf);
          blobs.set(sha, buf);
          entries.set(t.path, { mode: t.mode || "100644", sha });
          continue;
        }
        if (!blobs.has(t.sha)) return err(res, 422, `GitRPC::BadObjectState: blob ${t.sha} does not exist`);
        entries.set(t.path, { mode: t.mode || "100644", sha: t.sha });
      }
      const sha = storeTree(entries);
      return send(res, 201, { sha, tree: treeEntries(sha, true), truncated: false });
    }

    if (rest === "/git/blobs" && method === "POST") {
      if (!write()) return;
      const b = await readJson(req);
      if (typeof b.content !== "string") return err(res, 422, "Invalid request. content is required");
      const enc = b.encoding || "utf-8";
      if (enc !== "base64" && enc !== "utf-8") return err(res, 422, "Invalid encoding");
      const buf = Buffer.from(b.content, enc === "base64" ? "base64" : "utf8");
      const sha = blobSha(buf);
      blobs.set(sha, buf);
      return send(res, 201, { sha, url: `${originRef.value}/repos/${o}/${r}/git/blobs/${sha}` });
    }
    if ((mm = rest.match(/^\/git\/blobs\/([0-9a-f]+)$/)) && method === "GET") {
      const buf = blobs.get(mm[1]);
      if (!buf) return err(res, 404, "Not Found");
      return send(res, 200, { sha: mm[1], size: buf.length, encoding: "base64", content: buf.toString("base64") });
    }

    if ((mm = rest.match(/^\/git\/refs\/heads\/(.+)$/)) && method === "PATCH") {
      if (!write()) return;
      const b = await readJson(req);
      const name = decodeURIComponent(mm[1]);
      if (!refs.has(name)) return err(res, 404, "Not Found");
      if (hooks.failFirstPatch) {
        hooks.failFirstPatch = false;
        return err(res, 422, "Update is not a fast forward");
      }
      if (!commits.has(b.sha)) return err(res, 422, "Object does not exist");
      if (!b.force && !isAncestor(refs.get(name), b.sha)) return err(res, 422, "Update is not a fast forward");
      refs.set(name, b.sha);
      runs.push({ id: 1000 + runs.length + 1, head_sha: b.sha, head_branch: name, created: new Date().toISOString() });
      return send(res, 200, { ref: `refs/heads/${name}`, object: { sha: b.sha, type: "commit" } });
    }

    if ((mm = rest.match(/^\/compare\/([^/]+)\.\.\.([^/]+)$/)) && method === "GET") {
      const [base, head] = [decodeURIComponent(mm[1]), decodeURIComponent(mm[2])];
      const resolve = (x) => (refs.has(x) ? refs.get(x) : x);
      const bs = resolve(base), hs = resolve(head);
      if (!commits.has(bs) || !commits.has(hs)) return err(res, 404, "Not Found");
      const ahead = countUnique(hs, bs), behind = countUnique(bs, hs);
      const status = ahead === 0 && behind === 0 ? "identical" : behind === 0 ? "ahead" : ahead === 0 ? "behind" : "diverged";
      return send(res, 200, { status, ahead_by: ahead, behind_by: behind, total_commits: ahead });
    }

    if (rest === "/actions/runs" && method === "GET") {
      const hs = url.searchParams.get("head_sha");
      const list = runs.filter((x) => !hs || x.head_sha === hs).map(runView);
      return send(res, 200, { total_count: list.length, workflow_runs: list });
    }
    if ((mm = rest.match(/^\/actions\/runs\/(\d+)(\/jobs)?$/)) && method === "GET") {
      const run = runs.find((x) => x.id === Number(mm[1]));
      if (!run) return err(res, 404, "Not Found");
      const v = runView(run);
      if (!mm[2]) return send(res, 200, v);
      const failed = v.conclusion === "failure";
      return send(res, 200, {
        total_count: 1,
        jobs: [{
          id: run.id * 10, run_id: run.id, name: "build", status: v.status, conclusion: v.conclusion, html_url: `${v.html_url}/job/${run.id * 10}`,
          steps: [
            { name: "Checkout", status: "completed", conclusion: "success", number: 1 },
            { name: "Build", status: v.status, conclusion: v.status === "completed" ? (failed ? "failure" : "success") : null, number: 2 },
          ],
        }],
      });
    }

    if ((mm = rest.match(/^\/contents\/(.+)$/)) && method === "GET") {
      const p = decodeURIComponent(mm[1]);
      const refName = url.searchParams.get("ref") || branch;
      const commitSha = refs.get(refName) || (commits.has(refName) ? refName : null);
      if (!commitSha) return err(res, 404, "No commit found for the ref " + refName);
      const e = trees.get(commits.get(commitSha).tree).get(p);
      if (!e) return err(res, 404, "Not Found");
      const buf = blobs.get(e.sha);
      return send(res, 200, { type: "file", name: path.posix.basename(p), path: p, sha: e.sha, size: buf.length, encoding: "base64", content: buf.toString("base64") });
    }

    return err(res, 404, "Not Found");
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://mock.local");
    const entry = { method: req.method, path: url.pathname + url.search, authenticated: false, status: 0 };
    log.push(entry);
    res.on("finish", () => { entry.status = res.statusCode; });
    try {
      if (req.method === "OPTIONS") {
        cors(res);
        res.writeHead(204, {
          "Access-Control-Allow-Methods": ALLOW_METHODS,
          "Access-Control-Allow-Headers": ALLOW_HEADERS,
          "Access-Control-Max-Age": "600",
        });
        return res.end();
      }
      if (url.pathname.startsWith("/__mock/")) return await handleControl(req, res, url);
      if (url.pathname === "/build.json" && req.method === "GET") {
        return send(res, 200, { sha: deployedSha(), builtAt: new Date().toISOString() }, { "Cache-Control": "no-store" });
      }
      const h = req.headers.authorization || "";
      const t = /^(?:Bearer|token) (.+)$/i.exec(h)?.[1];
      let auth = null;
      if (t && t === token) auth = "write";
      else if (t && t === readonlyToken) auth = "read";
      if (!auth) return err(res, 401, "Bad credentials");
      entry.authenticated = true;
      return await handleApi(req, res, url, auth);
    } catch (e) {
      if (!res.headersSent) return err(res, e.status || 500, e.message);
      res.end();
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const actualPort = server.address().port;
  const url = `http://${host}:${actualPort}`;
  originRef.value = url;

  return {
    url,
    port: actualPort,
    token,
    readonlyToken,
    hooks: () => hooks,
    setHooks: (h) => Object.assign(hooks, h),
    head: () => refs.get(branch),
    initialSha: () => initialSha,
    commitCount: () => countUnique(refs.get(branch), initialSha), // commits reachable from head since the seed
    requests: () => log.slice(),
    exportTo,
    reset: seedRepo,
    close: () => new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections?.(); }),
  };
}

// ---- CLI -------------------------------------------------------------------
function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--seed": o.seed = next(); break;
      case "--port": o.port = Number(next()); break;
      case "--origin": o.origin = next(); break;
      case "--token": o.token = next(); break;
      case "--owner": o.owner = next(); break;
      case "--repo": o.repo = next(); break;
      case "--fail-first-patch": o.failFirstPatch = true; break;
      case "--run-conclusion": o.runConclusion = next(); break;
      case "--build-sha": o.buildSha = next(); break;
      default: throw new Error(`Unknown argument: ${a}`);
    }
  }
  return o;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const mock = await startMockGithub(parseArgs(process.argv.slice(2)));
    console.log(JSON.stringify({ url: mock.url, port: mock.port, token: mock.token }));
    const stop = () => mock.close().then(() => process.exit(0));
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
