// Copies the few latin woff2 files used by the album from @fontsource into src/assets/fonts.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "src/assets/fonts");
const files = [
  ["cormorant-garamond", "cormorant-garamond-latin-600-normal.woff2"],
  ["cormorant-garamond", "cormorant-garamond-latin-400-italic.woff2"],
  ["lora", "lora-latin-400-normal.woff2"],
];
fs.mkdirSync(out, { recursive: true });
for (const [pkg, f] of files) {
  fs.copyFileSync(path.join(root, "node_modules/@fontsource", pkg, "files", f), path.join(out, f));
}
console.log(`Copied ${files.length} fonts to src/assets/fonts`);
