// No imports: this file is copied to the admin as slug.js.
export function slugify(input) {
  let s = String(input).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
    .slice(0, 55).replace(/-+$/g, "");            // trim again after cutting: output stays idempotent
  return s === "" ? "capitulo" : s;
}

// Upload names: slugify(base) + lowercased extension ("Para Manuel .pdf" -> "para-manuel.pdf").
export function slugifyFileName(name) {
  const str = String(name);
  const i = str.lastIndexOf(".");
  const hasExt = i > 0 && i < str.length - 1;
  const base = hasExt ? str.slice(0, i) : str;
  const ext = hasExt ? "." + str.slice(i + 1).toLowerCase().replace(/[^a-z0-9]/g, "") : "";
  return slugify(base) + (ext === "." ? "" : ext);
}
