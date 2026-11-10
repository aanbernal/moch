import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findPlaceholders, parseHtml, htmlRefs, resolveRef, verifyDist } from "../lib/verify-dist.mjs";

let dir;
before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-dist-"));
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

test("placeholder check ignores author text but catches template leaks", () => {
  const ok = `<h1>null</h1><p class="note">TODO undefined {{ x }}</p><figcaption>null</figcaption><img alt="[object]" src="/a.jpg"><blockquote><p>TODO</p></blockquote>`;
  assert.deepEqual(findPlaceholders(ok), []);
  assert.equal(findPlaceholders(`<main><p>undefined</p></main>`).length, 1);
  assert.equal(findPlaceholders(`<main><a href="/x/{{ y }}">ok</a></main>`).length, 1);
  assert.equal(findPlaceholders(`<p>todo</p>`).length, 0); // "todo" is not the case-sensitive token TODO
});

test("references are extracted and resolved inside dist", () => {
  const tree = parseHtml(`<img src="/m/a.jpg" srcset="/m/a-480.webp 480w, /m/a-800.webp 800w"><video poster="p.jpg"></video><a href="/x/#t">x</a>`);
  assert.deepEqual(htmlRefs(tree), ["/m/a.jpg", "/m/a-480.webp", "/m/a-800.webp", "p.jpg", "/x/#t"]);
  assert.equal(resolveRef("https://x.test/a", "/d/i.html", "/d"), null);
  assert.equal(resolveRef("/x/#t", "/d/i.html", "/d"), path.join("/d", "x/"));
});

test("a minimal dist with a broken link and a missing noindex fails", async () => {
  fs.writeFileSync(path.join(dir, "index.html"), `<!doctype html><html lang="es"><head><title>Portada · T</title></head><body><a href="/nope/">x</a></body></html>`);
  fs.writeFileSync(path.join(dir, "robots.txt"), "User-agent: *\nDisallow: /\n");
  const content = path.join(dir, "content");
  fs.mkdirSync(content);
  fs.writeFileSync(path.join(content, "site.json"), JSON.stringify({ title: "T" }));
  const r = await verifyDist({ distDir: dir, contentDir: content, albumSrc: null, buildDir: dir, titleRerun: false, log() {} });
  const text = r.errors.join("\n");
  assert.match(text, /\[refs\].*\/nope\//);
  assert.match(text, /\[noindex\]/);
  assert.match(text, /\[headers\] _headers falta/);
});
