import fs from "node:fs";
import path from "node:path";
import { CONTENT_DIR, DIST_DIR, ROOT } from "../lib/paths.mjs";
import { scanPaths, scanJsonStrings, scanTextFiles, scanHashes, walk } from "../lib/setlog-guard.mjs";

const stage = process.argv[2];

function fail(hits) {
  for (const h of hits) {
    console.error(`[guard ${stage}] ofensor (${h.kind}${h.label ? " " + h.label : ""}): ${h.where}`);
  }
  console.error(`[guard ${stage}] ${hits.length} coincidencia(s); build detenido.`);
  process.exit(3);
}

function exists(d) {
  try {
    return fs.statSync(d).isDirectory();
  } catch {
    return false;
  }
}

if (stage === "pre") {
  if (!exists(CONTENT_DIR)) {
    console.error(`[guard pre] CONTENT_DIR no existe: ${CONTENT_DIR}`);
    process.exit(1);
  }
  const files = walk(CONTENT_DIR).filter((p) => !p.endsWith("/"));
  const abs = files.map((f) => path.join(CONTENT_DIR, f));
  const jsonFiles = files
    .filter((f) => /(^|\/)(chapter|site)\.json$/.test(f))
    .map((f) => path.join(CONTENT_DIR, f));
  const mediaFiles = abs.filter((f) => !f.endsWith(".json"));
  let denied = [];
  const deniedPath = process.env.GUARD_DENIED_HASHES || path.join(ROOT, "guard", "denied-hashes.json");
  try {
    denied = JSON.parse(fs.readFileSync(deniedPath, "utf8"));
  } catch (e) {
    console.error(`[guard pre] no se pudo leer ${deniedPath}: ${e.message}`);
    process.exit(1);
  }
  const hits = [
    ...scanPaths(CONTENT_DIR),
    ...scanJsonStrings(jsonFiles),
    ...scanHashes(mediaFiles, denied),
  ];
  if (hits.length) fail(hits);
  console.log(`[guard pre] OK (${files.length} archivos revisados)`);
} else if (stage === "post") {
  if (!exists(DIST_DIR)) {
    console.error(`[guard post] DIST_DIR no existe: ${DIST_DIR}. Ejecuta el build de Eleventy primero.`);
    process.exit(1);
  }
  const hits = [...scanPaths(DIST_DIR), ...scanTextFiles(DIST_DIR)];
  if (hits.length) fail(hits);
  console.log("[guard post] OK");
} else {
  console.error("Uso: node scripts/guard.mjs pre|post");
  process.exit(2);
}
