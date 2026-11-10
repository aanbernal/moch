// Full build chain (design 10, Fix 6):
// guard pre -> media -> open-items -> eleventy -> guard post -> verify-dist.
// Each stage runs in its own process; the first non-zero exit code stops the build
// and is returned as-is (guard 3, tools 4, budget 5, ...).

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ROOT } from "../lib/paths.mjs";

const NODE = process.execPath;
const ELEVENTY = path.join(ROOT, "node_modules", "@11ty", "eleventy", "cmd.cjs");
const script = (name) => path.join(ROOT, "scripts", name);

export const STAGES = [
  { name: "guard pre", args: [script("guard.mjs"), "pre"] },
  { name: "media", args: [script("media.mjs")] },
  { name: "open-items", args: [script("open-items.mjs")] },
  { name: "eleventy", args: [ELEVENTY] },
  { name: "guard post", args: [script("guard.mjs"), "post"] },
  { name: "verify-dist", args: [script("verify-dist.mjs")] },
];

function runStage(stage) {
  return new Promise((resolve) => {
    const child = spawn(NODE, stage.args, { cwd: ROOT, stdio: "inherit", shell: false, env: process.env });
    child.on("error", (e) => {
      console.error(`[build] no se pudo iniciar "${stage.name}": ${e.message}`);
      resolve(1);
    });
    child.on("close", (code) => resolve(code ?? 1));
  });
}

async function main() {
  for (const [i, stage] of STAGES.entries()) {
    console.log(`\n[build] (${i + 1}/${STAGES.length}) ${stage.name}`);
    const code = await runStage(stage);
    if (code !== 0) {
      console.error(`[build] falló la etapa "${stage.name}" (código ${code}); build detenido.`);
      process.exit(code);
    }
  }
  console.log("\n[build] listo.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
