// Builds dist/_headers (Cloudflare Pages) and provides a matcher with Cloudflare semantics.
// Design 5.2: one CSP per path; no path is matched by two CSP rules.

export const PUBLIC_CSP = [
  "default-src 'self'",
  "img-src 'self' data:",
  "media-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "font-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

export const ADMIN_CSP = [
  "default-src 'self'",
  "img-src 'self' blob: data:",
  "media-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "font-src 'self'",
  "connect-src 'self' https://api.github.com",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

const REVALIDATE = "public, max-age=0, must-revalidate";

/** Ordered rules: [pattern, [[header, value], ...]] */
export function buildRules() {
  const csp = (v) => ["Content-Security-Policy", v];
  const cache = (v) => ["Cache-Control", v];
  return [
    ["/*", [
      ["X-Robots-Tag", "noindex, nofollow, noarchive"],
      ["Referrer-Policy", "no-referrer"],
      ["X-Content-Type-Options", "nosniff"],
    ]],
    ["/", [csp(PUBLIC_CSP), cache(REVALIDATE)]],
    ["/indice/*", [csp(PUBLIC_CSP), cache(REVALIDATE)]],
    ["/capitulo/*", [csp(PUBLIC_CSP), cache(REVALIDATE)]],
    ["/404.html", [csp(PUBLIC_CSP)]],
    ["/assets/*", [csp(PUBLIC_CSP), cache(REVALIDATE)]],
    ["/build.json", [cache("no-store")]],
    ["/sw.js", [cache(REVALIDATE)]],
    ["/admin/*", [csp(ADMIN_CSP), cache("no-store")]],
    ["/m/*", [cache("public, max-age=31536000, immutable")]],
  ];
}

export function renderHeaders(rules = buildRules()) {
  return (
    rules
      .map(([pattern, hs]) => `${pattern}\n${hs.map(([k, v]) => `  ${k}: ${v}`).join("\n")}`)
      .join("\n") + "\n"
  );
}

/** Parse _headers text into [{pattern, headers: [{name, value, detach}]}]. */
export function parseHeaders(text) {
  const rules = [];
  let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    if (!/^\s/.test(raw)) {
      cur = { pattern: raw.trim(), headers: [] };
      rules.push(cur);
      continue;
    }
    if (!cur) continue;
    const line = raw.trim();
    if (line.startsWith("!")) {
      cur.headers.push({ name: line.slice(1).trim(), value: null, detach: true });
      continue;
    }
    const i = line.indexOf(":");
    if (i < 0) continue;
    cur.headers.push({ name: line.slice(0, i).trim(), value: line.slice(i + 1).trim(), detach: false });
  }
  return rules;
}

function patternToRegExp(pattern) {
  let re = "";
  for (const part of pattern.split(/(\*|:[A-Za-z]\w*)/)) {
    if (part === "*") re += "(.*)";
    else if (/^:[A-Za-z]\w*$/.test(part)) re += "([^/]+)";
    else re += part.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

export function ruleMatches(pattern, path) {
  return patternToRegExp(pattern).test(path);
}

/**
 * Cloudflare semantics: every matching rule applies in order; same-name headers
 * are joined with ", "; "! Name" removes the headers accumulated so far.
 * Accepts _headers text or parsed rules. Returns a Map keyed by lower-case name
 * -> { name, value }.
 */
export function matchHeaders(source, path) {
  const rules = typeof source === "string" ? parseHeaders(source) : source;
  const out = new Map();
  for (const rule of rules) {
    if (!ruleMatches(rule.pattern, path)) continue;
    for (const h of rule.headers) {
      const key = h.name.toLowerCase();
      if (h.detach) out.delete(key);
      else if (out.has(key)) out.get(key).value += `, ${h.value}`;
      else out.set(key, { name: h.name, value: h.value });
    }
  }
  return out;
}

/** Number of CSP declarations that apply to a path (counting rules, not joined values). */
export function cspRuleCount(source, path) {
  const rules = typeof source === "string" ? parseHeaders(source) : source;
  let n = 0;
  for (const rule of rules) {
    if (!ruleMatches(rule.pattern, path)) continue;
    for (const h of rule.headers) {
      if (h.detach) {
        if (h.name.toLowerCase() === "content-security-policy") n = 0;
      } else if (h.name.toLowerCase() === "content-security-policy") n++;
    }
  }
  return n;
}
