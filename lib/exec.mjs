import { spawn } from "node:child_process";

export const EXIT_MISSING_TOOL = 4;

const INSTALL_HINTS = {
  ffmpeg: "sudo apt-get install -y ffmpeg",
  ffprobe: "sudo apt-get install -y ffmpeg",
  pdftoppm: "sudo apt-get install -y poppler-utils",
};

/**
 * Run a program with an argument array (never a shell).
 * Resolves { code, stdout, stderr }; rejects only if the process cannot start.
 */
export function run(cmd, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...options, shell: false });
    const out = [];
    const err = [];
    child.stdout?.on("data", (d) => out.push(d));
    child.stderr?.on("data", (d) => err.push(d));
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({
        code,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      }),
    );
  });
}

/** Returns true if `tool` can be started. */
export async function hasTool(tool) {
  const flag = tool === "pdftoppm" ? "-v" : "-version";
  try {
    await run(tool, [flag]);
    return true;
  } catch {
    return false;
  }
}

/** Exit 4 naming the first missing tool. */
export async function checkTools(tools = ["ffmpeg", "ffprobe", "pdftoppm"]) {
  for (const tool of tools) {
    if (!(await hasTool(tool))) {
      console.error(
        `Falta la herramienta "${tool}". Instálala con: ${INSTALL_HINTS[tool] ?? tool}`,
      );
      process.exit(EXIT_MISSING_TOOL);
    }
  }
}
