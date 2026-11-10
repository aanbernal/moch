// GitHub Git Data API client for the admin (design 2.3, 2.4, 12).
// fetch and delay are injectable. The token is only ever placed in the
// Authorization header; it is never logged or included in error messages.

export const DEFAULT_API_BASE = "https://api.github.com";
export const RETRY_DELAYS_MS = [1000, 3000];

export const MSG = {
  token: "El token no es válido o venció. Genera uno nuevo en GitHub y pégalo otra vez.",
  forbidden: "El token no tiene permiso para escribir en el repositorio (sin permiso).",
  notFound: "No encuentro el repositorio. Revisa la configuración del álbum.",
  noPush: "El token no tiene permiso de escritura (Contents: Read and write).",
  truncated: "El repositorio es demasiado grande para leerlo completo. No se publicó nada.",
  conflict: "Alguien más cambió el álbum. Recarga e inténtalo otra vez.",
  publish: "No se pudo publicar. No se perdió nada: tus cambios siguen en el formulario. Inténtalo otra vez.",
  unexpected: "GitHub respondió de forma inesperada. No se publicó nada.",
};

export class GitHubError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = "GitHubError";
    this.code = code;
    this.status = status;
  }
}

/** apiBase override is honoured only on localhost / 127.0.0.1. */
export function resolveApiBase(override, hostname) {
  if (override && (hostname === "localhost" || hostname === "127.0.0.1")) {
    return String(override).replace(/\/+$/, "");
  }
  return DEFAULT_API_BASE;
}

const defaultDelay = (ms) => new Promise((r) => setTimeout(r, ms));

export function createGitHubClient({
  token,
  owner,
  repo,
  branch = "main",
  apiBase = DEFAULT_API_BASE,
  hostname = globalThis.location?.hostname,
  fetch: fetchImpl = globalThis.fetch?.bind(globalThis),
  delay = defaultDelay,
} = {}) {
  const base = resolveApiBase(apiBase === DEFAULT_API_BASE ? null : apiBase, hostname);
  const repoPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

  function statusError(status) {
    if (status === 401) return new GitHubError("token", MSG.token, status);
    if (status === 403) return new GitHubError("forbidden", MSG.forbidden, status);
    if (status === 404) return new GitHubError("not-found", MSG.notFound, status);
    if (status === 422) return new GitHubError("conflict", MSG.conflict, status);
    if (status >= 500) return new GitHubError("server", MSG.publish, status);
    return new GitHubError("unexpected", MSG.unexpected, status);
  }

  // One HTTP call; retries 5xx and network failures twice (1 s, 3 s).
  async function request(method, path, body) {
    const url = `${base}${path}`;
    const init = {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    };
    let lastError;
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      if (attempt > 0) await delay(RETRY_DELAYS_MS[attempt - 1]);
      let res;
      try {
        res = await fetchImpl(url, init);
      } catch {
        lastError = new GitHubError("network", MSG.publish);
        continue;
      }
      if (res.status >= 500) {
        lastError = statusError(res.status);
        continue;
      }
      if (!res.ok) throw statusError(res.status);
      return res.status === 204 ? null : res.json();
    }
    throw lastError;
  }

  async function checkRepo() {
    const data = await request("GET", repoPath);
    if (data && data.permissions && data.permissions.push === false) {
      throw new GitHubError("no-push", MSG.noPush, 200);
    }
    return data;
  }

  async function readHead() {
    const ref = await request("GET", `${repoPath}/git/ref/heads/${branch}`);
    const commitSha = ref.object.sha;
    const commit = await request("GET", `${repoPath}/git/commits/${commitSha}`);
    return { commitSha, treeSha: commit.tree.sha };
  }

  async function readTree(treeSha) {
    const tree = await request("GET", `${repoPath}/git/trees/${treeSha}?recursive=1`);
    if (tree.truncated) throw new GitHubError("truncated", MSG.truncated);
    return tree.tree || [];
  }

  /** Steps 1-2: head commit, base tree and the full file list. */
  async function readState() {
    const head = await readHead();
    const entries = await readTree(head.treeSha);
    return { ...head, entries };
  }

  /** Reads a blob by sha and returns its text (UTF-8). */
  async function readBlobText(sha) {
    const blob = await request("GET", `${repoPath}/git/blobs/${encodeURIComponent(sha)}`);
    if (!blob || blob.encoding !== "base64") throw new GitHubError("unexpected", MSG.unexpected);
    const bin = atob(String(blob.content).replace(/\s+/g, ""));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  /** GET actions/runs for a commit; resolves to null when the token lacks Actions access. */
  async function listRuns(headSha) {
    try {
      const data = await request("GET", `${repoPath}/actions/runs?head_sha=${encodeURIComponent(headSha)}`);
      return data.workflow_runs || [];
    } catch (err) {
      if (err instanceof GitHubError && (err.status === 403 || err.status === 404)) return null;
      throw err;
    }
  }

  /** Status of `head` relative to `base` ("ahead", "identical", "behind", "diverged"); null on failure. */
  async function compareStatus(base, head) {
    try {
      const data = await request("GET", `${repoPath}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`);
      return data.status || null;
    } catch {
      return null;
    }
  }

  function expandDeletions(entries, deletePaths, deletePrefixes) {
    const out = new Set();
    const paths = new Set(deletePaths);
    for (const e of entries) {
      if (e.type !== "blob") continue;
      if (paths.has(e.path) || deletePrefixes.some((p) => e.path.startsWith(p))) out.add(e.path);
    }
    return [...out].sort();
  }

  /**
   * Publish one commit.
   * files: [{ path, base64 }]; deletePaths: exact paths; deletePrefixes: e.g. "content/chapters/slug/".
   * Returns { commitSha }.
   */
  async function publish({ message, files = [], deletePaths = [], deletePrefixes = [] }) {
    let state = await readState(); // steps 1-2

    // Step 3: blobs (content-addressed, safe to reuse across a retry).
    const blobs = [];
    for (const f of files) {
      const blob = await request("POST", `${repoPath}/git/blobs`, { content: f.base64, encoding: "base64" });
      blobs.push({ path: f.path, mode: "100644", type: "blob", sha: blob.sha });
    }

    // Steps 4-6, with one retry from a fresh ref on 422.
    for (let attempt = 0; attempt < 2; attempt++) {
      const deletions = expandDeletions(state.entries, deletePaths, deletePrefixes).map((path) => ({
        path, mode: "100644", type: "blob", sha: null,
      }));
      try {
        const tree = await request("POST", `${repoPath}/git/trees`, {
          base_tree: state.treeSha,
          tree: [...blobs, ...deletions],
        });
        const commit = await request("POST", `${repoPath}/git/commits`, {
          message,
          tree: tree.sha,
          parents: [state.commitSha],
        });
        await request("PATCH", `${repoPath}/git/refs/heads/${branch}`, { sha: commit.sha, force: false });
        return { commitSha: commit.sha };
      } catch (err) {
        if (err instanceof GitHubError && err.code === "conflict" && attempt === 0) {
          state = await readState();
          continue;
        }
        throw err;
      }
    }
    throw new GitHubError("conflict", MSG.conflict, 422);
  }

  return { checkRepo, readState, readBlobText, listRuns, compareStatus, publish };
}
