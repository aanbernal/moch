import { loadChapters } from "../../lib/chapters-loader.mjs";

// Default export only: Eleventy would otherwise expose the whole module namespace as `chapters`.
export default function chapters() {
  return loadChapters();
}
