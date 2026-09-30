// The only subprocess this tool runs: read-only git queries.
//
// Kept in one module so the "one subprocess, read-only" claim in SECURITY.md is
// verifiable by reading a single file. Never used to read file *contents*.

import { execFile } from "node:child_process";
import path from "node:path";
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

export type FileState = "clean" | "dirty" | "untracked" | "no-repo";

/**
 * Whether git can undo a write to `file`.
 *
 * "clean" means tracked with no uncommitted changes, so `git diff` shows
 * exactly what was written and `git checkout --` reverts it. Anything else
 * means an overwrite could lose work that is not recorded anywhere.
 */
export async function gitFileState(file: string): Promise<FileState> {
  const dir = path.dirname(file);
  if ((await gitRoot(dir)) === null) return "no-repo";

  try {
    await execFileAsync("git", ["-C", dir, "ls-files", "--error-unmatch", "--", file], {
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
    });
  } catch {
    // Not tracked, which includes ignored files: nothing to revert to.
    return "untracked";
  }

  try {
    const { stdout } = await execFileAsync("git", ["-C", dir, "status", "--porcelain", "--", file], {
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
    });
    return stdout.trim().length === 0 ? "clean" : "dirty";
  } catch {
    return "no-repo";
  }
}

/**
 * `git diff --no-index` between two paths, used to preview a proposed write.
 * git exits 1 when the files differ, which is the expected case, so that is not
 * treated as failure. Null when git is unavailable.
 */
export async function gitDiffNoIndex(
  before: string,
  after: string,
  colour: boolean,
): Promise<string | null> {
  const args = [
    "--no-pager",
    "diff",
    "--no-index",
    colour ? "--color=always" : "--no-color",
    "--",
    before,
    after,
  ];
  try {
    const { stdout } = await execFileAsync("git", args, {
      maxBuffer: 16 * 1024 * 1024,
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
    });
    return stdout;
  } catch (error) {
    // Exit 1 just means "they differ"; the diff is on stdout.
    if (error !== null && typeof error === "object" && "stdout" in error) {
      const stdout = (error as { stdout?: unknown }).stdout;
      if (typeof stdout === "string" && stdout.length > 0) return stdout;
    }
    return null;
  }
}
