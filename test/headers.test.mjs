import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ADMIN_CSP, PUBLIC_CSP, renderHeaders, matchHeaders, cspRuleCount,
} from "../lib/headers.mjs";

const text = renderHeaders();
const paths = [
  "/", "/indice/", "/capitulo/x/", "/404.html", "/assets/a.css", "/admin/",
  "/admin/main.js", "/m/x.webp", "/build.json", "/sw.js", "/manifest.webmanifest", "/robots.txt",
];

test("every representative path gets at most one CSP rule", () => {
  for (const p of paths) assert.ok(cspRuleCount(text, p) <= 1, p);
  const csp = (p) => matchHeaders(text, p).get("content-security-policy")?.value;
  assert.equal(csp("/"), PUBLIC_CSP);
  assert.equal(csp("/capitulo/x/"), PUBLIC_CSP);
  assert.equal(csp("/admin/main.js"), ADMIN_CSP);
  assert.equal(csp("/m/x.webp"), undefined);
});

test("admin CSP allows only GitHub API, blob and data as specified", () => {
  assert.match(ADMIN_CSP, /connect-src 'self' https:\/\/api\.github\.com;/);
  assert.match(ADMIN_CSP, /img-src 'self' blob: data:;/);
  assert.match(ADMIN_CSP, /media-src 'self' blob:;/);
  assert.doesNotMatch(PUBLIC_CSP, /api\.github\.com|blob:/);
});

test("cache and privacy headers", () => {
  const h = (p, n) => matchHeaders(text, p).get(n)?.value;
  assert.equal(h("/m/x.webp", "cache-control"), "public, max-age=31536000, immutable");
  assert.equal(h("/build.json", "cache-control"), "no-store");
  assert.equal(h("/admin/", "cache-control"), "no-store");
  for (const p of paths) {
    assert.equal(h(p, "referrer-policy"), "no-referrer", p);
    assert.equal(h(p, "x-robots-tag"), "noindex, nofollow, noarchive", p);
  }
});

test("matcher joins same-name headers and honours detach", () => {
  const t = "/*\n  X-A: one\n/p/*\n  X-A: two\n";
  assert.equal(matchHeaders(t, "/p/x").get("x-a").value, "one, two");
  const d = "/*\n  X-A: one\n/p/*\n  ! X-A\n  X-A: two\n";
  assert.equal(matchHeaders(d, "/p/x").get("x-a").value, "two");
});

test("negative fixture with two CSP rules is detected", () => {
  const bad = "/*\n  Content-Security-Policy: a\n/admin/*\n  Content-Security-Policy: b\n";
  assert.equal(cspRuleCount(bad, "/admin/"), 2);
  assert.equal(cspRuleCount(bad, "/"), 1);
});
