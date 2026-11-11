import fs from "node:fs";
import path from "node:path";
import { shipAdmin } from "./lib/admin-ship.mjs";
import { ROOT, DIST_DIR } from "./lib/paths.mjs";

// DIST_DIR (env) redirects the output, e.g. for the e2e run (design 14.4); default is dist/.
const OUTPUT = path.relative(ROOT, DIST_DIR) || "dist";

export default function (eleventyConfig) {
  // Nunjucks autoescape stays on (it is the default; set explicitly on purpose).
  eleventyConfig.setNunjucksEnvironmentOptions({ autoescape: true });

  eleventyConfig.addPassthroughCopy("src/assets", {
    filter: (src) => !src.endsWith(".njk"),
  });
  eleventyConfig.addPassthroughCopy({ "build/media": "m" });
  eleventyConfig.addPassthroughCopy("src/admin");


  // Ship the shared validator and slug copies, and template admin/config.json (Fix 5).
  eleventyConfig.on("eleventy.after", ({ dir }) => {
    const distDir = path.resolve(dir.output);
    shipAdmin({ distDir });
    // index.njk is template source (rendered to admin/index.html); drop the raw passthrough copy.
    fs.rmSync(path.join(distDir, "admin", "index.njk"), { force: true });
    // Same for the generated stylesheet: themes.css.njk is rendered to assets/themes.css.
    fs.rmSync(path.join(distDir, "assets", "themes.css.njk"), { force: true });
  });

  return {
    dir: { input: "src", output: OUTPUT, includes: "_includes", data: "_data" },
    templateFormats: ["njk", "md", "html"],
    markdownTemplateEngine: "njk",
    htmlTemplateEngine: "njk",
  };
}
