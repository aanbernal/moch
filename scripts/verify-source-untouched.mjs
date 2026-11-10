// Local only. NOT part of `npm run build` (the source tree is absent in CI).
//
// Hashes every file under ALBUM_SRC (SHA-256, read only), runs a build, hashes
// again and compares. Also checks that `git status` of the album-for-kiro
// repository did not change (and warns if it was not clean to begin with).
//
// Usage:
//   node scripts/verify-source-untouched.mjs              # runs `npm run build`
//   node scripts/verify-source-untouched.mjs --no-build   # hash twice, no build
//   node scripts/verify-source-untouched.mjs -- <cmd> [args...]   # custom command
//
// Exit codes: 0 ok or ALBUM_SRC absent, 1 source changed, 2 build failed.

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ALBUM_SRC, ROOT } from "../lib/paths.mjs";
import { run } from "../lib/exec.mjs";

export function hashFile(file) {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(file)
      .on("data", (d) => h.update(d))
      .on("error", reject)
      .on("end", () => resolve(h.digest("hex")));
  });
}

/** Sorted manifest { relativePath: "<size>:<sha256>" } of every file under dir. */
export async function hashTree(dir) {
  const out = {};
  async function walk(current) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(current, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile()) {
        const rel = path.relative(dir, full).split(path.sep).join("/");
        const { size } = await stat(full);
        out[rel] = `${size}:${await hashFile(full)}`;
      }
    }
  }
  await walk(dir);
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** Pure comparison of two manifests. */
export function diffManifests(before, after) {
  const added = Object.keys(after).filter((k) => !(k in before));
  const removed = Object.keys(before).filter((k) => !(k in after));
  const modified = Object.keys(before).filter((k) => k in after && before[k] !== after[k]);
  return { added, removed, modified, same: !added.length && !removed.length && !modified.length };
}

/** git status --porcelain for the repo containing dir; null when not a repo / no git. */
export async function gitStatus(dir) {
  try {
    const top = await run("git", ["-C", dir, "rev-parse", "--show-toplevel"]);
    if (top.code !== 0) return null;
    const st = await run("git", ["-C", top.stdout.trim(), "status", "--porcelain"]);
    if (st.code !== 0) return null;
    return { top: top.stdout.trim(), porcelain: st.stdout };
  } catch {
    return null;
  }
}

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const sep = argv.indexOf("--");
  const custom = sep >= 0 ? argv.slice(sep + 1) : null;
  const noBuild = argv.includes("--no-build");

  if (!(await exists(ALBUM_SRC))) {
    console.log("ALBUM_SRC no disponible, comprobación omitida");
    return 0;
  }

  console.log(`Calculando huellas de ${ALBUM_SRC} …`);
  const beforeGit = await gitStatus(ALBUM_SRC);
  const before = await hashTree(ALBUM_SRC);
  console.log(`  ${Object.keys(before).length} archivos`);

  if (!noBuild) {
    const [cmd, ...args] = custom && custom.length ? custom : ["npm", "run", "build"];
    console.log(`Ejecutando: ${[cmd, ...args].join(" ")}`);
    const r = await run(cmd, args, { cwd: ROOT, env: process.env });
    if (r.code !== 0) {
      process.stderr.write(r.stdout.slice(-2000) + r.stderr.slice(-2000));
      console.error(`La compilación falló (código ${r.code}).`);
      return 2;
    }
  }

  const after = await hashTree(ALBUM_SRC);
  const afterGit = await gitStatus(ALBUM_SRC);
  const d = diffManifests(before, after);
  let failed = false;

  if (!d.same) {
    failed = true;
    for (const f of d.added) console.error(`AGREGADO: ${f}`);
    for (const f of d.removed) console.error(`ELIMINADO: ${f}`);
    for (const f of d.modified) console.error(`MODIFICADO: ${f}`);
  }

  if (!afterGit) {
    console.log("album-for-kiro no es un repositorio git (o git no está disponible), git status omitido");
  } else {
    if (afterGit.porcelain.trim() !== "") {
      console.warn(`Aviso: git status de ${afterGit.top} no está limpio.`);
    }
    if (beforeGit && beforeGit.porcelain !== afterGit.porcelain) {
      failed = true;
      console.error("git status de album-for-kiro cambió durante la compilación.");
    }
  }

  if (failed) {
    console.error("FALLO: el material original fue tocado.");
    return 1;
  }
  console.log("OK: el material original no cambió.");
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exit(await main());
}
