// Class A static checks on dist/ (design 14.2). Exit 1 on failures, 5 on STRICT_BUDGET overruns only.
// Class B seed assertions are not run here (STRICT_SEED=1 belongs to verify:browser and e2e).
import { verifyDist, EXIT_BUDGET } from "../lib/verify-dist.mjs";
import { mimeFor } from "./serve.mjs";

const { errors, budgetErrors, warnings } = await verifyDist({ mimeFor });

for (const w of warnings) console.warn(`[verify-dist] aviso ${w}`);
for (const e of [...errors, ...budgetErrors]) console.error(`[verify-dist] ${e}`);

if (errors.length) {
  console.error(`[verify-dist] ${errors.length} error(es)${budgetErrors.length ? ` y ${budgetErrors.length} de presupuesto` : ""}.`);
  process.exit(1);
}
if (budgetErrors.length) {
  console.error(`[verify-dist] ${budgetErrors.length} archivo(s) sobre el presupuesto (STRICT_BUDGET=1).`);
  process.exit(EXIT_BUDGET);
}
console.log(`[verify-dist] OK (${warnings.length} aviso(s))`);
