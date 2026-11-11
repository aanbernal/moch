// Chapter Themes (design 4.5). Pure, NO imports (it is shipped unchanged to dist/admin/themes.mjs).
// Minimal version used by the page model; task 15.10 extends it (validator, admin, shipping).

export const BASE_THEME = "crema";

/** Index order is the automatic cycle. */
export const PALETTE = [
  { name: "crema", label: "Crema", paper: "#f4ead7", ink: "#3b2f2a", accent: "#7a4a2b", tape: "#d9c7a0" },
  { name: "rosa", label: "Rosa", paper: "#f8e6e6", ink: "#3d2a2e", accent: "#9a3b55", tape: "#e8b4c0" },
  { name: "salvia", label: "Salvia", paper: "#e6eddc", ink: "#2b3a2e", accent: "#46633f", tape: "#b7c9a4" },
  { name: "cielo", label: "Cielo", paper: "#e3eef6", ink: "#22313f", accent: "#2d5f8a", tape: "#a9c8e0" },
  { name: "lavanda", label: "Lavanda", paper: "#ece6f5", ink: "#2f2a40", accent: "#5e4a94", tape: "#c5b8e3" },
  { name: "terracota", label: "Terracota", paper: "#f6e3d6", ink: "#3a2a22", accent: "#a4472a", tape: "#e0a98c" },
  { name: "miel", label: "Miel", paper: "#f7ecc9", ink: "#3a2f1a", accent: "#8a5a00", tape: "#e3c46b" },
  { name: "noche", label: "Noche", paper: "#2b2f45", ink: "#f1ead9", accent: "#e8c27a", tape: "#5b6290" },
];

export const THEME_NAMES = PALETTE.map((t) => t.name);

export function isTheme(name) {
  return THEME_NAMES.includes(name);
}

/**
 * Theme of a Chapter: its explicit `theme`, else crema for prologue and teaser,
 * else PALETTE[rank % 8] where rank is the "Capítulo N" number.
 */
export function themeFor(chapter, rank) {
  if (chapter && typeof chapter.theme === "string" && chapter.theme) return chapter.theme;
  if (!chapter || chapter.kind === "prologue" || chapter.kind === "teaser") return BASE_THEME;
  const n = Number.isInteger(rank) && rank >= 0 ? rank : 0;
  return PALETTE[n % PALETTE.length].name;
}

function luminance(hex) {
  const v = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = v.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.x contrast ratio between two #rrggbb colors. */
export function contrastRatio(hexA, hexB) {
  const a = luminance(hexA);
  const b = luminance(hexB);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
