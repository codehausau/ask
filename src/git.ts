// The CLI's only subprocess is Git: hardened metadata queries and plain diffs.
// Worktree bytes are hashed in-process, avoiding Git status/clean filters.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { devNull } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 5_000;

const GIT_GLOBAL_ARGS = [
  "--no-pager", "--no-optional-locks", "--no-lazy-fetch", "--literal-pathspecs",
  "-c", "core.fsmonitor=false",
];

// Git configuration/location overrides can select programs or a different index
// or worktree. Loader and shell startup variables can execute before Git itself.
// This is case-insensitive because environment names are case-insensitive on Windows.
const UNSAFE_GIT_ENV = /^(GIT_|LD_|DYLD_|OPENAI_|ASK_|NODE_OPTIONS$|BASH_ENV$|ENV$|SHELLOPTS$|BASHOPTS$|CDPATH$|IFS$)/i;

export function gitEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (!UNSAFE_GIT_ENV.test(key)) env[key] = value;
  }
  return { ...env, GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1", GIT_ATTR_NOSYSTEM: "1" };
}

function runGit(args: readonly string[], options: { maxBuffer?: number } = {}) {
  return execFileAsync("git", [...GIT_GLOBAL_ARGS, ...args], {
    ...options, env: gitEnv(), timeout: GIT_TIMEOUT_MS, windowsHide: true,
  });
}

/** Repository root containing `cwd`, or null when it is not a work tree. */
export async function gitRoot(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await runGit(["-C", cwd, "rev-parse", "--show-toplevel"]);
    // Remove the record delimiter, not whitespace that belongs to the path.
    const line = stdout.replace(/\n$/, "");
    const root = process.platform === "win32" ? line.replace(/\r$/, "") : line;
    return path.isAbsolute(root) ? root : null;
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
    const { stdout } = await runGit(
      ["-C", cwd, "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { maxBuffer: 64 * 1024 * 1024 },
    );
    return stdout.split("\0").filter((entry) => {
      if (entry.length === 0 || path.isAbsolute(entry)) return false;
      // Treat even index filenames as data: a malformed index must not turn a
      // search/glob into an implicitly authorised path outside its search root.
      const relative = path.relative(path.resolve(cwd), path.resolve(cwd, entry));
      return relative !== "" && relative !== ".." &&
        !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    });
  } catch {
    return null;
  }
}

export type FileState = "clean" | "dirty" | "untracked" | "no-repo";

/**
 * Whether git can undo a write to `file`.
 *
 * "clean" requires matching HEAD/index entries and matching raw worktree bytes.
 * Git status can execute clean/process filters while checking a file. Avoid it
 * entirely: query object IDs/modes and hash the file ourselves without filters.
 * This is deliberately conservative for CRLF/filter-normalised worktree files.
 */
export async function gitFileState(file: string): Promise<FileState> {
  const dir = path.dirname(file);
  const root = await gitRoot(dir);
  if (root === null) return "no-repo";
  const relative = path.relative(root, path.resolve(file)).split(path.sep).join("/");
  if (relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) return "no-repo";

  let indexText: string;
  try {
    const { stdout } = await runGit([
      "-C", root, "ls-files", "--cached", "--stage", "--full-name", "--error-unmatch", "-z", "--", relative,
    ]);
    indexText = stdout;
  } catch {
    // Not tracked, which includes ignored files: nothing to revert to.
    return "untracked";
  }

  const entries = indexText.split("\0").filter(Boolean);
  if (entries.length !== 1) return "dirty"; // Includes unmerged index stages.
  const index = /^(100644|100755) ([a-f0-9]{40}|[a-f0-9]{64}) 0\t([\s\S]*)$/.exec(entries[0]!);
  if (!index || index[3] !== relative) return "dirty"; // Not an ordinary stage-0 file.
  const mode = index[1]!;
  const oid = index[2]!;

  try {
    const { stdout } = await runGit(["-C", root, "ls-tree", "--full-tree", "-z", "HEAD", "--", relative]);
    const head = /^(100644|100755) blob ([a-f0-9]{40}|[a-f0-9]{64})\t([\s\S]*)\0$/.exec(stdout);
    if (!head || head[1] !== mode || head[2] !== oid || head[3] !== relative) return "dirty";
    // A promised-but-missing blob is not an available undo copy. Never fetch it.
    await runGit(["-C", root, "cat-file", "-e", `${oid}^{blob}`]);
    const worktree = await hashWorktreeFile(file, oid.length === 64 ? "sha256" : "sha1");
    return worktree !== null && worktree.oid === oid &&
      (process.platform === "win32" || worktree.mode === mode) ? "clean" : "dirty";
  } catch {
    return "dirty"; // Includes unborn HEAD, missing objects and unreadable files.
  }
}

function sameVersion(before: Stats, after: Stats): boolean {
  return before.dev === after.dev && before.ino === after.ino && before.size === after.size &&
    before.mode === after.mode && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
}

async function hashWorktreeFile(file: string, algorithm: "sha1" | "sha256") {
  const named = await lstat(file);
  if (!named.isFile() || named.isSymbolicLink()) return null;
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || !sameVersion(named, before)) return null;
    const hash = createHash(algorithm).update(`blob ${before.size}\0`);
    let bytes = 0;
    if (before.size > 0) {
      // Bound the stream to the snapshot size, even if another process appends.
      for await (const chunk of handle.createReadStream({ autoClose: false, start: 0, end: before.size - 1 })) {
        hash.update(chunk);
        bytes += chunk.length;
      }
    }
    const after = await handle.stat();
    const current = await lstat(file);
    if (bytes !== before.size || !sameVersion(before, after) || !sameVersion(before, current)) return null;
    return { oid: hash.digest("hex"), mode: before.mode & 0o111 ? "100755" : "100644" };
  } finally {
    await handle.close();
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
  const absoluteBefore = path.resolve(before);
  const absoluteAfter = path.resolve(after);
  const args = [
    // --no-index still consults attributes and can run clean/process filters.
    // An explicit non-directory Git dir prevents repository discovery/config;
    // the null attributes file and GIT_ATTR_NOSYSTEM suppress the other sources.
    "--git-dir", devNull,
    "-c", `core.attributesFile=${devNull}`,
    "-C", path.dirname(absoluteBefore),
    "diff",
    "--no-index",
    "--no-ext-diff",
    "--no-textconv",
    colour ? "--color=always" : "--no-color",
    "--",
    absoluteBefore,
    absoluteAfter,
  ];
  try {
    const { stdout } = await runGit(args, { maxBuffer: 16 * 1024 * 1024 });
    return stdout;
  } catch (error) {
    // Exit 1 just means "they differ"; the diff is on stdout.
    if (error !== null && typeof error === "object" && "code" in error && error.code === 1 && "stdout" in error) {
      const stdout = (error as { stdout?: unknown }).stdout;
      if (typeof stdout === "string" && stdout.length > 0) return stdout;
    }
    return null;
  }
}
