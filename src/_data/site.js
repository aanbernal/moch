import fs from "node:fs";
import path from "node:path";
import { CONTENT_DIR } from "../../lib/paths.mjs";

// Album-wide config. The album title is written only in content/site.json.
const file = path.join(CONTENT_DIR, "site.json");
const site = JSON.parse(fs.readFileSync(file, "utf8"));

// Test-only override, so tests can check title propagation without editing content.
if (process.env.NODE_ENV === "test" && process.env.ALBUM_TITLE_OVERRIDE) {
  site.title = process.env.ALBUM_TITLE_OVERRIDE;
}

if (JSON.stringify(site.repo ?? {}).includes("REPLACE_")) {
  console.warn(
    "[aviso] content/site.json: 'repo' aún contiene valores REPLACE_…; " +
      "el admin no se desbloqueará hasta que se corrijan."
  );
}

export default site;
