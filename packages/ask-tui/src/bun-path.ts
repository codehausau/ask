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

/**
 * `ASK_BUN` (an absolute path) wins. Otherwise search PATH, skipping empty and
 * relative entries and any directory inside the working directory; Windows would
 * otherwise also search the working directory first.
 */
export function findBun(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd(), platform = process.platform): string | null {
  const explicit = env["ASK_BUN"];
  if (explicit) {
    if (!path.isAbsolute(explicit)) throw new Error("ASK_BUN must be an absolute path to the bun executable.");
    if (!isExecutable(explicit)) throw new Error(`ASK_BUN is not an executable file: ${explicit}`);
    return explicit;
  }
  const workingDirectory = realDirectory(cwd) ?? path.resolve(cwd);
  const name = platform === "win32" ? "bun.exe" : "bun";
  for (const dir of (env["PATH"] ?? "").split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    const real = realDirectory(dir);
    if (real === null || within(workingDirectory, real)) continue;
    const candidate = path.join(dir, name);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}
