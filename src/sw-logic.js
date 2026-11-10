// Pure service worker logic (unit-tested). Inlined into /sw.js at build time:
// keep it free of imports and keep every top-level declaration prefixed with `export `.

/**
 * Allow-list: respondWith is used only for same-origin GET requests under /m/ or /assets/,
 * pages listed in `pages`, or /manifest.webmanifest. Never /admin/, /build.json, /build-manifest.json, /sw.js.
 */
export function shouldHandle({ method, origin, pathname }, { selfOrigin, pages }) {
  if (method !== "GET" || origin !== selfOrigin) return false;
  if (pathname.startsWith("/admin/") || pathname === "/build.json" || pathname === "/build-manifest.json" || pathname === "/sw.js") {
    return false;
  }
  return (
    pathname.startsWith("/m/") ||
    pathname.startsWith("/assets/") ||
    pages.includes(pathname) ||
    pathname === "/manifest.webmanifest"
  );
}
