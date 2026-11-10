import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldHandle } from "../src/sw-logic.js";
import { collectMediaUrls, computeBuildId, buildInfo } from "../lib/build-info.mjs";

const self_ = "https://album.example";
const env = { selfOrigin: self_, pages: ["/", "/indice/", "/capitulo/expo-aws/"] };
const req = (pathname, o = {}) => ({ method: "GET", origin: self_, pathname, ...o });

test("shouldHandle allows /m/, /assets/, listed pages and the manifest", () => {
  for (const p of ["/m/abc-800.webp", "/assets/book.css", "/", "/indice/", "/capitulo/expo-aws/", "/manifest.webmanifest"]) {
    assert.equal(shouldHandle(req(p), env), true, p);
  }
});

test("shouldHandle rejects admin, build.json, sw.js, unlisted pages, non-GET and cross-origin", () => {
  for (const p of ["/admin/", "/admin/main.js", "/build.json", "/build-manifest.json", "/sw.js", "/capitulo/otro/", "/robots.txt"]) {
    assert.equal(shouldHandle(req(p), env), false, p);
  }
  assert.equal(shouldHandle(req("/m/a.webp", { method: "POST" }), env), false);
  assert.equal(shouldHandle(req("/m/a.webp", { origin: "https://evil.example" }), env), false);
});

test("buildId is 12 hex, deterministic and order independent", () => {
  const a = computeBuildId(["/m/b.webp", "/m/a.webp"], ["/", "/indice/"]);
  assert.match(a, /^[0-9a-f]{12}$/);
  assert.equal(a, computeBuildId(["/m/a.webp", "/m/b.webp"], ["/indice/", "/"]));
  assert.notEqual(a, computeBuildId(["/m/a.webp"], ["/", "/indice/"]));
});

test("buildInfo collects every media url shape and ignores non-/m/ urls", () => {
  const manifest = {
    "a/1.jpg": { variants: [{ url: "/m/1-480.webp" }, { url: "/m/1-800.jpg" }] },
    "a/v.mp4": { url: "/m/v.mp4", poster: { variants: [{ url: "/m/p-480.webp" }] } },
    "a/d.pdf": { pages: [{ variants: [{ url: "/m/d1-800.webp" }] }] },
    "a/x": { url: "https://external/x" },
  };
  const urls = collectMediaUrls(manifest);
  assert.deepEqual(urls, ["/m/1-480.webp", "/m/1-800.jpg", "/m/d1-800.webp", "/m/p-480.webp", "/m/v.mp4"]);
  const chapters = [{ url: "/capitulo/a/" }];
  const one = buildInfo(manifest, chapters);
  const two = buildInfo(structuredClone(manifest), chapters);
  assert.deepEqual(one, two);
  assert.deepEqual(one.pages, ["/", "/capitulo/a/", "/indice/"]);
});
