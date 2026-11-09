export default function (eleventyConfig) {
  // Nunjucks autoescape stays on (it is the default; set explicitly on purpose).
  eleventyConfig.setNunjucksEnvironmentOptions({ autoescape: true });

  eleventyConfig.addPassthroughCopy("src/assets");
  eleventyConfig.addPassthroughCopy({ "build/media": "m" });
  eleventyConfig.addPassthroughCopy("src/admin");

  return {
    dir: { input: "src", output: "dist", includes: "_includes", data: "_data" },
    templateFormats: ["njk", "md", "html"],
    markdownTemplateEngine: "njk",
    htmlTemplateEngine: "njk",
  };
}
