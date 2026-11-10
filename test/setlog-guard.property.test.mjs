import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import path from "node:path";
import { spawnSync } from "node:child_process";
import fc from "fast-check";
import { isSetlog } from "../lib/setlog-guard.mjs";

const GUARD = path.resolve(import.meta.dirname, "../scripts/guard.mjs");
const NUM_RUNS = 100;

let root;
let counter = 0;

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "guard-prop-"));
});
after(() => fs.rmSync(root, { recursive: true, force: true }));

// ---- generators ----
const safeChars = "abcdefghijklmnopqrstuvwxyz0123456789_-".split("");
const safeSegment = fc
  .array(fc.constantFrom(...safeChars), { minLength: 1, maxLength: 10 })
  .map((a) => a.join(""))
  .filter((s) => !/setlog/i.test(s));
const anyString = fc.string({ maxLength: 40 }).filter((s) => !/setlog/i.test(s));
const casing = fc
  .array(fc.boolean(), { minLength: 6, maxLength: 6 })
  .map((flags) => [..."setlog"].map((c, i) => (flags[i] ? c.toUpperCase() : c)).join(""));
const safeInjected = (pre, mid, post) => pre + mid + post;

const fsInjection = fc.record({ pre: safeSegment, mid: casing, post: safeSegment });
const textInjection = fc.record({
  pre: anyString.filter((s) => !s.includes("\0")),
  mid: casing,
  post: anyString.filter((s) => !s.includes("\0")),
});

const sandbox = () => {
  const d = path.join(root, `case-${counter++}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
};
const write = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
};
const run = (stage, env) =>
  spawnSync("node", [GUARD, stage], { env: { ...process.env, ...env }, encoding: "utf8" });
const chapter = (title) => JSON.stringify({ title, items: [{ alt: "ok" }] });

// Feature: digital-album, Property 18: Setlog detection
// **Validates: Requirements 9.1, 9.3**
test("Property 18: isSetlog is true iff lower-cased input contains 'setlog'", () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 60 }), (s) => {
      assert.equal(isSetlog(s), s.toLowerCase().includes("setlog"));
    }),
    { numRuns: NUM_RUNS },
  );
  // any position, case and folder depth
  fc.assert(
    fc.property(
      fc.array(safeSegment, { maxLength: 4 }),
      casing,
      fc.array(safeSegment, { maxLength: 4 }),
      fc.string({ maxLength: 8 }),
      fc.string({ maxLength: 8 }),
      (before_, mid, after_, pre, post) => {
        const p = [...before_, pre + mid + post, ...after_].join("/");
        assert.equal(isSetlog(p), true);
      },
    ),
    { numRuns: NUM_RUNS },
  );
  fc.assert(
    fc.property(fc.array(safeSegment, { minLength: 1, maxLength: 5 }), (segs) => {
      assert.equal(isSetlog(segs.join("/")), false);
    }),
    { numRuns: NUM_RUNS },
  );
});

// Feature: digital-album, Property 19: Setlog scans fail on any occurrence
// **Validates: Requirements 9.1, 9.2, 9.3, 9.7**
test("Property 19: clean content and dist trees pass", () => {
  fc.assert(
    fc.property(fc.array(safeSegment, { minLength: 1, maxLength: 3 }), safeSegment, anyString, (folders, file, title) => {
      const d = sandbox();
      write(path.join(d, "content", ...folders, "chapter.json"), chapter(title));
      write(path.join(d, "content", ...folders, `${file}.jpg`), "bytes");
      write(path.join(d, "dist", ...folders, `${file}.html`), `<p>${title.replace(/[<&]/g, "")}</p>`);
      const pre = run("pre", { CONTENT_DIR: path.join(d, "content") });
      const post = run("post", { DIST_DIR: path.join(d, "dist") });
      assert.equal(pre.status, 0, pre.stderr);
      assert.equal(post.status, 0, post.stderr);
    }),
    { numRuns: NUM_RUNS },
  );
});

test("Property 19: setlog in a content file or folder name fails pre with exit 3", () => {
  fc.assert(
    fc.property(fsInjection, safeSegment, fc.boolean(), (inj, other, inFolder) => {
      const d = sandbox();
      const name = safeInjected(inj.pre, inj.mid, inj.post);
      const content = path.join(d, "content");
      write(path.join(content, other, "chapter.json"), chapter("ok"));
      const rel = inFolder ? `${name}/chapter.json` : `${other}/${name}.jpg`;
      write(path.join(content, rel), inFolder ? chapter("ok") : "bytes");
      const r = run("pre", { CONTENT_DIR: content });
      assert.equal(r.status, 3, r.stderr);
      assert.ok(r.stderr.includes(name), `stderr should name ${name}: ${r.stderr}`);
    }),
    { numRuns: NUM_RUNS },
  );
});

test("Property 19: setlog in a chapter.json string fails pre with exit 3 naming the file", () => {
  fc.assert(
    fc.property(textInjection, safeSegment, (inj, folder) => {
      const d = sandbox();
      const content = path.join(d, "content");
      write(path.join(content, folder, "chapter.json"), chapter(inj.pre + inj.mid + inj.post));
      const r = run("pre", { CONTENT_DIR: content });
      assert.equal(r.status, 3, r.stderr);
      assert.ok(r.stderr.includes(`${folder}/chapter.json`), r.stderr);
    }),
    { numRuns: NUM_RUNS },
  );
});

test("Property 19: setlog in a dist file name, folder name or text fails post with exit 3", () => {
  fc.assert(
    fc.property(fsInjection, safeSegment, fc.constantFrom("file", "folder", "text"), (inj, other, where) => {
      const d = sandbox();
      const dist = path.join(d, "dist");
      const name = safeInjected(inj.pre, inj.mid, inj.post);
      write(path.join(dist, "index.html"), "<p>ok</p>");
      let offender;
      if (where === "file") {
        offender = `${name}.html`;
        write(path.join(dist, offender), "<p>ok</p>");
      } else if (where === "folder") {
        offender = name;
        write(path.join(dist, name, `${other}.html`), "<p>ok</p>");
      } else {
        offender = `${other}.html`;
        write(path.join(dist, offender), `<p>${name}</p>`);
      }
      const r = run("post", { DIST_DIR: dist });
      assert.equal(r.status, 3, r.stderr);
      assert.ok(r.stderr.includes(offender), `stderr should name ${offender}: ${r.stderr}`);
    }),
    { numRuns: NUM_RUNS },
  );
});

test("Property 19: a file with a denied SHA-256 fails pre even with a clean name", () => {
  fc.assert(
    fc.property(fc.uint8Array({ minLength: 1, maxLength: 64 }), safeSegment, safeSegment, (bytes, label, file) => {
      const d = sandbox();
      const content = path.join(d, "content");
      const buf = Buffer.from(bytes);
      write(path.join(content, "c1", "chapter.json"), chapter("ok"));
      write(path.join(content, "c1", `${file}.jpg`), buf);
      const denied = path.join(d, "denied.json");
      write(denied, JSON.stringify([{ label, sha256: crypto.createHash("sha256").update(buf).digest("hex") }]));
      const r = run("pre", { CONTENT_DIR: content, GUARD_DENIED_HASHES: denied });
      assert.equal(r.status, 3, r.stderr);
      assert.ok(r.stderr.includes(`${file}.jpg`), r.stderr);
      assert.ok(r.stderr.includes(label), r.stderr);
    }),
    { numRuns: NUM_RUNS },
  );
});
