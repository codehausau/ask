// The only subprocess this tool runs: read-only git queries.
//
// Kept in one module so the "one subprocess, read-only" claim in SECURITY.md is
// verifiable by reading a single file. Never used to read file *contents*.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 5_000;

/** Repository root containing `cwd`, or null when it is not a work tree. */
export async function gitRoot(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
    });
    const root = stdout.trim();
    return root.length > 0 ? root : null;
  } catch {
    return null;
  }
}

/**
 * Tracked and untracked-but-not-ignored paths below `cwd`, NUL separated so odd
 * filenames survive. Null when this is not a git work tree, or git is missing.
 */
export async function gitListFiles(cwd: string): Promise<string[] | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", cwd, "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { maxBuffer: 64 * 1024 * 1024, timeout: GIT_TIMEOUT_MS, windowsHide: true },
    );
    return stdout.split("\0").filter((entry) => entry.length > 0);
  } catch {
    return null;
  }
}
