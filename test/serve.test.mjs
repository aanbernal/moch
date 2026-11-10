import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startServer, addConnectSrc, parseRange } from "../scripts/serve.mjs";
import { ADMIN_CSP } from "../lib/headers.mjs";

async function makeDist() {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), "serve-dist-"));
  const w = async (p, c) => { await fs.mkdir(path.dirname(path.join(d, p)), { recursive: true }); await fs.writeFile(path.join(d, p), c); };
  await w("index.html", "<h1>home</h1>");
  await w("indice/index.html", "<h1>indice</h1>");
  await w("admin/index.html", "<h1>admin</h1>");
  await w("404.html", "<h1>custom 404</h1>");
  await w("assets/a.mjs", "export {}");
  await w("assets/b.js", "1");
  await w("manifest.webmanifest", "{}");
  await w("m/p.webp", "RIFF");
  await w("m/v.mp4", Buffer.from("0123456789"));
  await w("_headers", [
    "/*", "  X-Robots-Tag: noindex", "/admin/*", `  Content-Security-Policy: ${ADMIN_CSP}`, "  Cache-Control: no-store",
    "/indice/*", "  Cache-Control: public, max-age=0, must-revalidate", "",
  ].join("\n"));
  return d;
}

test("index resolution, 404 page, MIME types, traversal", async (t) => {
  const dir = await makeDist();
  const s = await startServer({ dir });
  t.after(async () => { await s.close(); await fs.rm(dir, { recursive: true, force: true }); });
  const get = (p, init) => fetch(s.url + p, init);

  assert.equal(await (await get("/")).text(), "<h1>home</h1>");
  assert.equal(await (await get("/indice/")).text(), "<h1>indice</h1>");
  assert.equal(await (await get("/indice")).text(), "<h1>indice</h1>");
  const nf = await get("/no-existe/");
  assert.equal(nf.status, 404);
  assert.equal(await nf.text(), "<h1>custom 404</h1>");
  assert.match((await get("/assets/a.mjs")).headers.get("content-type"), /^text\/javascript/);
  assert.match((await get("/assets/b.js")).headers.get("content-type"), /^text\/javascript/);
  assert.match((await get("/manifest.webmanifest")).headers.get("content-type"), /manifest\+json/);
  assert.equal((await get("/m/p.webp")).headers.get("content-type"), "image/webp");
  assert.equal((await get("/m/v.mp4")).headers.get("content-type"), "video/mp4");
  assert.equal((await get("/%2e%2e/%2e%2e/etc/passwd")).status, 404);
  assert.equal((await get("/", { method: "POST" })).status, 405);
  // no _headers applied unless strict
  assert.equal((await get("/")).headers.get("x-robots-tag"), null);
});

test("Range requests on mp4", async (t) => {
  const dir = await makeDist();
  const s = await startServer({ dir });
  t.after(async () => { await s.close(); await fs.rm(dir, { recursive: true, force: true }); });
  const r = await fetch(s.url + "/m/v.mp4", { headers: { Range: "bytes=2-5" } });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get("content-range"), "bytes 2-5/10");
  assert.equal(await r.text(), "2345");
  const tail = await fetch(s.url + "/m/v.mp4", { headers: { Range: "bytes=-3" } });
  assert.equal(await tail.text(), "789");
  const bad = await fetch(s.url + "/m/v.mp4", { headers: { Range: "bytes=50-60" } });
  assert.equal(bad.status, 416);
  assert.equal((await fetch(s.url + "/m/v.mp4")).headers.get("accept-ranges"), "bytes");
  assert.deepEqual(parseRange("bytes=0-", 10), { start: 0, end: 9 });
});

test("strict headers and extra connect-src (in memory only)", async (t) => {
  const dir = await makeDist();
  const before = await fs.readFile(path.join(dir, "_headers"), "utf8");
  const s = await startServer({ dir, strictHeaders: true, extraConnectSrc: "http://127.0.0.1:4444" });
  t.after(async () => { await s.close(); await fs.rm(dir, { recursive: true, force: true }); });

  const admin = await fetch(s.url + "/admin/");
  assert.equal(admin.headers.get("x-robots-tag"), "noindex");
  assert.equal(admin.headers.get("cache-control"), "no-store");
  const csp = admin.headers.get("content-security-policy");
  assert.match(csp, /connect-src 'self' https:\/\/api\.github\.com http:\/\/127\.0\.0\.1:4444;/);
  assert.equal(csp.split("connect-src").length, 2);

  const pub = await fetch(s.url + "/indice/");
  assert.equal(pub.headers.get("content-security-policy"), null);
  assert.equal(pub.headers.get("cache-control"), "public, max-age=0, must-revalidate");
  // 404 responses also get matching-rule headers
  assert.equal((await fetch(s.url + "/zzz")).headers.get("x-robots-tag"), "noindex");
  assert.equal(await fs.readFile(path.join(dir, "_headers"), "utf8"), before);
  assert.equal(addConnectSrc("a 'self'; connect-src 'self'", "http://x"), "a 'self'; connect-src 'self' http://x");
});
