// Static check of dist/admin shared files (validate-core.mjs, slug.js, config.json).
// Usage: node scripts/check-admin-ship.mjs  (exit 1 on problems)
import { checkAdminShip } from "../lib/admin-ship.mjs";
import { mimeFor } from "./serve.mjs";

const problems = checkAdminShip({ mimeFor });
if (problems.length) {
  for (const p of problems) console.error(`[admin-ship] ${p}`);
  process.exit(1);
}
console.log("[admin-ship] OK");
