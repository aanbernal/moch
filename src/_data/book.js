import { loadChapters } from "../../lib/chapters-loader.mjs";
import { buildPages, toPhoneSequence, toSpreads } from "../../lib/book-model.mjs";
import site from "./site.js";

// Single source of the Page list for templates and build-manifest.json (design 3.3).
// `prevOf` / `nextOf` give the neighbouring non-blank Page ids for the no-JS `.page-nav` links;
// the ends fall back to the TOC so the fixed link texts never name a neighbouring Chapter.
export default function book() {
  const pages = buildPages(loadChapters(), site);
  const phone = toPhoneSequence(pages);
  const prevOf = {};
  const nextOf = {};
  phone.forEach((p, i) => {
    prevOf[p.id] = phone[i - 1]?.id ?? "indice";
    nextOf[p.id] = phone[i + 1]?.id ?? "indice";
  });
  return {
    pages,
    phone,
    spreads: toSpreads(pages),
    ids: pages.map((p) => p.id),
    prevOf,
    nextOf,
  };
}
