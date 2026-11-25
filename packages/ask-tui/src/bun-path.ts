// Locate the Bun executable without letting the working directory supply it.
// The launcher's job is to keep repository code from running before ask-tui's
// own checks, so a `bun` inside the repository must never be chosen.
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import path from "node:path";

function realDirectory(dir: string): string | null {
  try { return realpathSync(dir); } catch { return null; }
}

function isExecutable(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    accessSync(file, constants.X_OK);
    return true;
  } catch { return false; }
}

function within(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

// Inspect markers rather than launching Git from the still-untrusted PATH.
// A .git file marks a linked worktree or submodule just as a directory does.
function projectRoot(cwd: string): string {
  for (let dir = cwd; ; dir = path.dirname(dir)) {
    try {
      const marker = statSync(path.join(dir, ".git"));
      if (marker.isDirectory() || marker.isFile()) return dir;
    } catch { /* Not a repository marker. */ }
    if (path.dirname(dir) === dir) return cwd;
  }
}

function inNodeModules(file: string): boolean {
  return file.split(path.sep).some((part) => part.toLowerCase() === "node_modules");
}

/**
 * `ASK_BUN` (an absolute path) wins. Otherwise search PATH, skipping empty and
 * relative entries, node_modules, and paths inside the working directory or its
 * repository. Check resolved executable paths too, not just PATH directories.
 */
export function findBun(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd(), platform = process.platform): string | null {
  const explicit = env["ASK_BUN"];
  if (explicit) {
    if (!path.isAbsolute(explicit)) throw new Error("ASK_BUN must be an absolute path to the bun executable.");
    if (!isExecutable(explicit)) throw new Error(`ASK_BUN is not an executable file: ${explicit}`);
    return explicit;
  }
  const workingDirectory = realDirectory(cwd) ?? path.resolve(cwd);
  const root = projectRoot(workingDirectory);
  const excluded = (file: string) => within(workingDirectory, file) || within(root, file) || inNodeModules(file);
  const name = platform === "win32" ? "bun.exe" : "bun";
  for (const dir of (env["PATH"] ?? "").split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir) || excluded(dir)) continue;
    const real = realDirectory(dir);
    if (real === null || excluded(real)) continue;
    const candidate = path.join(dir, name);
    const resolved = realDirectory(candidate);
    if (resolved !== null && !excluded(resolved) && isExecutable(resolved)) return resolved;
  }
  return null;
}
