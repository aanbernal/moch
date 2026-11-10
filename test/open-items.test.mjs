import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generateOpenItems, PRIVACY_TEXT } from "../scripts/open-items.mjs";

let tmp, contentDir, buildDir, emptyDir;

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "open-items-"));
  contentDir = path.join(tmp, "content");
  buildDir = path.join(tmp, "build");
  emptyDir = path.join(tmp, "empty");
  await fs.mkdir(path.join(contentDir, "chapters", "uno"), { recursive: true });
  await fs.mkdir(path.join(contentDir, "chapters", "dos"), { recursive: true });
  await fs.mkdir(buildDir, { recursive: true });
  await fs.mkdir(emptyDir, { recursive: true });
  await fs.writeFile(
    path.join(contentDir, "chapters", "uno", "chapter.json"),
    JSON.stringify({
      schema: 1, order: 1, kind: "chapter", title: "Uno", draft: true, cover: "a.jpg",
      media: [{ type: "photo", file: "a.jpg", caption: "ok" }, { type: "photo", file: "b.jpg" }],
    }),
  );
  await fs.writeFile(
    path.join(contentDir, "chapters", "dos", "chapter.json"),
    JSON.stringify({ schema: 1, order: 2, kind: "chapter", title: "Dos", note: "n", place: "p", dateText: "d", media: [] }),
  );
  await fs.writeFile(
    path.join(contentDir, "open-items.json"),
    JSON.stringify({
      sections: [
        { title: "Portada", items: ["Revisar portada", { text: "Viejo", check: { chapter: "gone" } }, { text: "Falta", check: { chapter: "uno", file: "zzz.jpg" } }] },
      ],
      "Discrepancias de nombres": ["0925 vs 0925_Ensayo_expo_aws"],
    }),
  );
  await fs.writeFile(
    path.join(buildDir, "media-report.json"),
    JSON.stringify({
      heavy: [{ name: "x.jpg", format: "webp", width: 800, bytes: 300000, budget: 256000 }],
      openItems: ["Para Manuel .pdf: tiene 3 páginas y se esperaban 2"],
      warnings: [],
    }),
  );
});

after(() => fs.rm(tmp, { recursive: true, force: true }));

test("generates all sections and marks stale entries", async () => {
  const out = path.join(tmp, "OUT.md");
  await generateOpenItems({ contentDir, buildDir, outFile: out });
  const md = await fs.readFile(out, "utf8");
  assert.ok(md.includes(PRIVACY_TEXT));
  assert.match(md, /## Fotos pesadas\n\n- x\.jpg webp 800 px/);
  assert.match(md, /3 páginas/);
  assert.match(md, /## Discrepancias de nombres\n\n- 0925 vs/);
  assert.match(md, /uno: 1 sin pie de foto \(b\.jpg\)/);
  assert.match(md, /uno: texto provisional, reescríbelo con tus palabras/);
  assert.match(md, /## Capítulos sin nota\n\n- uno\n/);
  assert.match(md, /Viejo _\(obsoleto: el capítulo "gone" ya no existe\)_/);
  assert.match(md, /Falta _\(obsoleto: "zzz\.jpg"/);
  assert.doesNotMatch(md, /Revisar portada _\(obsoleto/);
  assert.doesNotMatch(md, /sonido|silenci/i);
});

test("output is deterministic", async () => {
  const a = path.join(tmp, "A.md");
  const b = path.join(tmp, "B.md");
  await generateOpenItems({ contentDir, buildDir, outFile: a });
  await generateOpenItems({ contentDir, buildDir, outFile: b });
  assert.equal(await fs.readFile(a, "utf8"), await fs.readFile(b, "utf8"));
});

test("missing inputs do not crash and privacy statement stays", async () => {
  const out = path.join(tmp, "EMPTY.md");
  await generateOpenItems({ contentDir: emptyDir, buildDir: emptyDir, outFile: out });
  const md = await fs.readFile(out, "utf8");
  assert.ok(md.includes(PRIVACY_TEXT));
  assert.match(md, /noindex/);
});

test("malformed json inputs are skipped", async () => {
  const bad = path.join(tmp, "bad");
  await fs.mkdir(bad, { recursive: true });
  await fs.writeFile(path.join(bad, "open-items.json"), "{nope");
  await fs.writeFile(path.join(bad, "media-report.json"), "[1,");
  const out = path.join(tmp, "BAD.md");
  await generateOpenItems({ contentDir: bad, buildDir: bad, outFile: out });
  assert.ok((await fs.readFile(out, "utf8")).includes(PRIVACY_TEXT));
});
