#!/usr/bin/env node
// Static server for dist/ that mimics Cloudflare Pages (design 2.6, 14.3, 14.4).
// - "/" and "/dir/" -> index.html; "/dir" -> dir/index.html (served directly, no redirect)
// - missing paths -> custom 404.html with status 404 (plain text if absent)
// - GET/HEAD only; Range requests (single range) for media; ETag/304
// - --strict-headers applies dist/_headers (lib/headers.mjs matchHeaders)
// - --extra-connect-src <origin> is appended to the connect-src of /admin CSP, in memory only
//
// CLI: node scripts/serve.mjs [--dir dist] [--port 8788] [--strict-headers] [--extra-connect-src <origin>]

import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { matchHeaders } from "../lib/headers.mjs";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".pdf": "application/pdf",
  ".map": "application/json; charset=utf-8",
};

export function mimeFor(file) {
  return MIME[path.extname(file).toLowerCase()] || "application/octet-stream";
}

/** Append origin to the connect-src directive of a CSP value (pure). */
export function addConnectSrc(csp, origin) {
  return csp
    .split(";")
    .map((d) => (d.trim().startsWith("connect-src") ? `${d.trim()} ${origin}` : d.trim()))
    .filter(Boolean)
    .join("; ");
}

/** Parse "bytes=a-b" against size. Returns {start,end} | null (ignore) | "invalid". */
export function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec((header || "").trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  let start, end;
  if (m[1] === "") {
    const n = Number(m[2]);
    if (n === 0) return "invalid";
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || start > end) return "invalid";
  return { start, end };
}

async function statFile(p) {
  try {
    const s = await fsp.stat(p);
    return s.isFile() ? s : null;
  } catch {
    return null;
  }
}

export async function startServer({
  dir = "dist",
  port = 0,
  host = "127.0.0.1",
  strictHeaders = false,
  extraConnectSrc = null,
} = {}) {
  const root = path.resolve(dir);
  if (!(await fsp.stat(root).then((s) => s.isDirectory(), () => false))) {
    throw new Error(`Directory not found: ${root}`);
  }

  async function resolveFile(pathname) {
    let rel;
    try { rel = decodeURIComponent(pathname); } catch { return { bad: true }; }
    if (rel.includes("\0")) return { bad: true };
    const candidates = rel.endsWith("/")
      ? [rel + "index.html"]
      : [rel, rel + "/index.html"];
    for (const c of candidates) {
      const full = path.resolve(root, "." + path.posix.normalize("/" + c));
      if (full !== root && !full.startsWith(root + path.sep)) return { bad: true };
      const st = await statFile(full);
      if (st) return { file: full, stat: st };
    }
    return {};
  }

  async function headerMap(pathname) {
    if (!strictHeaders) return new Map();
    let text = "";
    try { text = await fsp.readFile(path.join(root, "_headers"), "utf8"); } catch { /* none */ }
    let decoded = pathname;
    try { decoded = decodeURIComponent(pathname); } catch { /* keep raw */ }
    const map = matchHeaders(text, decoded);
    if (extraConnectSrc && decoded.startsWith("/admin")) {
      const csp = map.get("content-security-policy");
      if (csp) csp.value = addConnectSrc(csp.value, extraConnectSrc);
    }
    return map;
  }

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, { Allow: "GET, HEAD", "Content-Type": "text/plain; charset=utf-8" });
        return res.end("Method Not Allowed");
      }
      const pathname = new URL(req.url, "http://serve.local").pathname;
      const hdrs = await headerMap(pathname);
      const extra = {};
      for (const { name, value } of hdrs.values()) extra[name] = value;
      const hasCache = hdrs.has("cache-control");

      const found = await resolveFile(pathname);
      let status = 200;
      let file = found.file;
      let stat = found.stat;
      if (found.bad) {
        res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        return res.end("Bad Request");
      }
      if (!file) {
        status = 404;
        const nf = path.join(root, "404.html");
        stat = await statFile(nf);
        file = stat ? nf : null;
        if (!file) {
          res.writeHead(404, { ...extra, "Content-Type": "text/plain; charset=utf-8" });
          return res.end(req.method === "HEAD" ? undefined : "Not Found");
        }
      }

      const headers = {
        ...(hasCache ? {} : { "Cache-Control": "public, max-age=0, must-revalidate" }),
        ...extra,
        "Content-Type": mimeFor(file),
        "Accept-Ranges": "bytes",
        "Last-Modified": stat.mtime.toUTCString(),
      };
      const size = stat.size;

      if (status === 200) {
        headers.ETag = `"${size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
        if (req.headers["if-none-match"] === headers.ETag) {
          res.writeHead(304, headers);
          return res.end();
        }
        if (req.headers.range) {
          const r = parseRange(req.headers.range, size);
          if (r === "invalid") {
            res.writeHead(416, { ...headers, "Content-Range": `bytes */${size}` });
            return res.end();
          }
          if (r) {
            res.writeHead(206, {
              ...headers,
              "Content-Range": `bytes ${r.start}-${r.end}/${size}`,
              "Content-Length": r.end - r.start + 1,
            });
            if (req.method === "HEAD") return res.end();
            return fs.createReadStream(file, { start: r.start, end: r.end }).on("error", () => res.destroy()).pipe(res);
          }
        }
      }

      res.writeHead(status, { ...headers, "Content-Length": size });
      if (req.method === "HEAD") return res.end();
      fs.createReadStream(file).on("error", () => res.destroy()).pipe(res);
    } catch (e) {
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Internal Server Error");
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const actual = server.address().port;
  return {
    url: `http://${host}:${actual}`,
    port: actual,
    dir: root,
    close: () => new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections?.(); }),
  };
}

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--dir": o.dir = next(); break;
      case "--port": o.port = Number(next()); break;
      case "--strict-headers": o.strictHeaders = true; break;
      case "--extra-connect-src": o.extraConnectSrc = next(); break;
      default: throw new Error(`Unknown argument: ${a}`);
    }
  }
  return o;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.port === undefined) opts.port = 8788;
    const s = await startServer(opts);
    console.log(JSON.stringify({ url: s.url, port: s.port, dir: s.dir }));
    const stop = () => s.close().then(() => process.exit(0));
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
