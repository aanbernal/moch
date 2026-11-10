// Ships the shared validator to the admin (Fix 5) and templates dist/admin/config.json.
//
// - lib/validate-core.mjs is copied byte for byte (same .mjs name, no import rewrite).
// - lib/slug.mjs is copied byte for byte as slug.js.
// - Nothing is committed under src/admin/ for them.
// - config.json is built from content/site.json `repo`.

import fs from "node:fs";
import path from "node:path";
import { ROOT, CONTENT_DIR, DIST_DIR } from "./paths.mjs";

export const SHIPPED = [
  { from: "lib/validate-core.mjs", to: "validate-core.mjs" },
  { from: "lib/slug.mjs", to: "slug.js" },
];

/** Pure: config.json text from a parsed site.json. */
export function buildAdminConfig(site) {
  const repo = site && typeof site.repo === "object" && site.repo ? site.repo : {};
  return JSON.stringify({ repo }, null, 2) + "\n";
}

/** Copies the shared modules and writes config.json into <distDir>/admin/. */
export function shipAdmin({ distDir = DIST_DIR, root = ROOT, contentDir = CONTENT_DIR } = {}) {
  const outDir = path.join(distDir, "admin");
  fs.mkdirSync(outDir, { recursive: true });
  for (const { from, to } of SHIPPED) {
    fs.copyFileSync(path.join(root, from), path.join(outDir, to));
  }
  const site = JSON.parse(fs.readFileSync(path.join(contentDir, "site.json"), "utf8"));
  fs.writeFileSync(path.join(outDir, "config.json"), buildAdminConfig(site));
  return outDir;
}

const JS_MIME = /^(text|application)\/(javascript|x-javascript|ecmascript)\b/i;

/**
 * Static check of the shipped files. `mimeFor` maps a file name to its served Content-Type.
 * @returns {string[]} problems; empty means OK
 */
export function checkAdminShip({ distDir = DIST_DIR, root = ROOT, mimeFor } = {}) {
  const problems = [];
  const dir = path.join(distDir, "admin");
  for (const { from, to } of SHIPPED) {
    const file = path.join(dir, to);
    if (!fs.existsSync(file)) {
      problems.push(`admin/${to}: falta en dist`);
      continue;
    }
    const shipped = fs.readFileSync(file);
    if (!shipped.equals(fs.readFileSync(path.join(root, from)))) {
      problems.push(`admin/${to}: no es idéntico a ${from}`);
    }
    if (mimeFor && !JS_MIME.test(mimeFor(file))) {
      problems.push(`admin/${to}: tipo MIME no es JavaScript (${mimeFor(file)})`);
    }
    if (to === "validate-core.mjs" && /(^|[\s;])import\s*[\w{*"'(]/m.test(shipped.toString("utf8").replace(/\/\/.*$/gm, ""))) {
      problems.push("admin/validate-core.mjs: contiene import");
    }
  }
  const cfg = path.join(dir, "config.json");
  if (!fs.existsSync(cfg)) problems.push("admin/config.json: falta en dist");
  else {
    try {
      const parsed = JSON.parse(fs.readFileSync(cfg, "utf8"));
      if (!parsed.repo || typeof parsed.repo !== "object") problems.push("admin/config.json: sin 'repo'");
    } catch {
      problems.push("admin/config.json: JSON no válido");
    }
  }
  return problems;
}
