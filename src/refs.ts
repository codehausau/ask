// Reference resolution: what `@something` means.
//
// Three cases, tried in order, so the cheap and unambiguous ones win:
//
//   1. path   — it exists on disk. Used verbatim, no searching.
//   2. glob   — it contains *, ? or [...]. Matched against the tree.
//   3. search — plain text. Ranked substring search over the tree, best match
//               wins; a tie at the best rank is an error rather than a guess.
//
// Search is deliberately substring-based, not fuzzy: `@chat` finding
// `src/chat.ts` is predictable, whereas subsequence matching turns `@cot` into
// a lottery. For interactive fuzzy picking use `askf` (fzf) instead.

import { execFile } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { isSecretPath, LOCKFILES, SKIP_DIRS, SKIP_EXTENSIONS } from "./skip.ts";

const execFileAsync = promisify(execFile);

/** Hard stop on tree traversal, so a stray `@x` in `/` cannot hang the CLI. */
export const MAX_SEARCH_ENTRIES = 50_000;

export type RefKind = "path" | "glob" | "search";

export interface Resolution {
  /** The `@ref` as typed, without the `@`. */
  readonly ref: string;
  readonly kind: RefKind;
  /** Absolute paths, deterministically ordered. */
  readonly paths: readonly string[];
}

export interface ResolveOptions {
  readonly cwd: string;
  readonly includeSecrets?: boolean;
  /** Attach every match instead of erroring on an ambiguous search. */
  readonly allMatches?: boolean;
  /** Traversal cap; exposed for tests. */
  readonly maxEntries?: number;
  /** Skip `git ls-files` and always walk the filesystem. */
  readonly noGit?: boolean;
}

/** Raised when a reference matches nothing, or matches several things. */
export class RefResolutionError extends Error {
  readonly ref: string;
  readonly candidates: readonly string[];

  constructor(message: string, ref: string, candidates: readonly string[] = []) {
    super(message);
    this.name = "RefResolutionError";
    this.ref = ref;
    this.candidates = candidates;
  }
}

export function hasGlobMagic(ref: string): boolean {
  return /[*?[]/.test(ref);
}

/**
 * Translate a glob to an anchored RegExp.
 * `**` crosses directory separators, `*` and `?` do not.
 */
export function globToRegExp(pattern: string): RegExp {
  let source = "";

  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];

    if (char === "*") {
      if (pattern[index + 1] === "*") {
        index += 1;
        if (pattern[index + 1] === "/") {
          index += 1;
          source += "(?:.*/)?"; // `**/x` also matches a top-level `x`
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      continue;
    }
    if (char === "[") {
      const end = pattern.indexOf("]", index + 1);
      if (end === -1) {
        source += "\\[";
        continue;
      }
      const body = pattern.slice(index + 1, end);
      source += `[${body.startsWith("!") ? `^${body.slice(1)}` : body}]`;
      index = end;
      continue;
    }
    source += char!.replace(/[.+^${}()|\\\]]/g, "\\$&");
  }

  return new RegExp(`^${source}$`);
}

interface TreeEntry {
  /** Path relative to the walk root, always with forward slashes. */
  readonly relative: string;
  readonly absolute: string;
  readonly isDirectory: boolean;
}

interface TreeListing {
  readonly entries: readonly TreeEntry[];
  /** True when the cap cut the listing short, so "no match" may be wrong. */
  readonly truncated: boolean;
  readonly source: "git" | "walk";
}

/** Would this relative path be attachable? Mirrors the collection filters. */
function isSearchable(relative: string, includeSecrets: boolean): boolean {
  const segments = relative.split("/");
  if (segments.some((segment) => SKIP_DIRS.has(segment))) return false;

  const base = segments[segments.length - 1] ?? "";
  if (SKIP_EXTENSIONS.has(path.extname(base).toLowerCase())) return false;
  if (LOCKFILES.has(base)) return false;
  if (!includeSecrets && isSecretPath(relative)) return false;
  return true;
}

/**
 * Enumerate files with `git ls-files`, which respects .gitignore and so skips
 * build output and caches that a raw walk would burn its budget on. Read-only,
 * local, and never consulted for file *contents*. Returns null when the
 * directory is not a git work tree, or git is unavailable.
 */
async function gitListing(root: string, includeSecrets: boolean, maxEntries: number): Promise<TreeListing | null> {
  let stdout: string;
  try {
    const result = await execFileAsync(
      "git",
      ["-C", root, "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { maxBuffer: 64 * 1024 * 1024, timeout: 5_000, windowsHide: true },
    );
    stdout = result.stdout;
  } catch {
    return null;
  }

  const relatives = stdout
    .split("\0")
    .filter((entry) => entry.length > 0 && isSearchable(entry, includeSecrets))
    .sort((a, b) => a.localeCompare(b));

  const truncated = relatives.length > maxEntries;
  const kept = truncated ? relatives.slice(0, maxEntries) : relatives;

  // Ancestor directories, so `@somedir` can match a directory name too.
  const directories = new Set<string>();
  for (const relative of kept) {
    const segments = relative.split("/");
    for (let depth = 1; depth < segments.length; depth += 1) {
      directories.add(segments.slice(0, depth).join("/"));
    }
  }

  const entries: TreeEntry[] = [
    ...[...directories]
      .sort((a, b) => a.localeCompare(b))
      .map((relative) => ({
        relative,
        absolute: path.resolve(root, relative),
        isDirectory: true,
      })),
    ...kept.map((relative) => ({
      relative,
      absolute: path.resolve(root, relative),
      isDirectory: false,
    })),
  ];

  return { entries, truncated, source: "git" };
}

/**
 * Filesystem fallback: walk the tree below `root`, applying the same skip rules
 * as attachment so search can only ever offer files that would be sent.
 */
async function walkListing(
  root: string,
  includeSecrets: boolean,
  maxEntries: number,
): Promise<TreeListing> {
  const entries: TreeEntry[] = [];
  let truncated = false;

  async function walk(dir: string): Promise<void> {
    if (entries.length >= maxEntries) {
      truncated = true;
      return;
    }

    const dirEntries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    dirEntries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of dirEntries) {
      if (entries.length >= maxEntries) {
        truncated = true;
        return;
      }

      const absolute = path.join(dir, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");

      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        entries.push({ relative, absolute, isDirectory: true });
        await walk(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!isSearchable(relative, includeSecrets)) continue;

      entries.push({ relative, absolute, isDirectory: false });
    }
  }

  await walk(root);
  return { entries, truncated, source: "walk" };
}

/** Candidate set for glob and search: git-aware, with a filesystem fallback. */
async function listTree(
  root: string,
  includeSecrets: boolean,
  maxEntries: number,
  noGit: boolean,
): Promise<TreeListing> {
  if (!noGit) {
    const listing = await gitListing(root, includeSecrets, maxEntries);
    if (listing) return listing;
  }
  return walkListing(root, includeSecrets, maxEntries);
}

/**
 * Rank a candidate path against a needle. Lower is better; `null` means no
 * match. Exported for tests — the ordering is a documented contract.
 */
export function rankMatch(relativePath: string, needle: string): number | null {
  const haystack = relativePath.toLowerCase();
  const target = needle.toLowerCase();
  const base = path.posix.basename(haystack);
  const baseNoExt = base.includes(".") ? base.slice(0, base.lastIndexOf(".")) : base;

  if (base === target) return 0;
  if (baseNoExt === target) return 1;
  if (base.startsWith(target)) return 2;
  if (base.includes(target)) return 3;
  if (haystack.includes(target)) return 4;
  return null;
}

function sortCandidates(candidates: { entry: TreeEntry; rank: number }[]): TreeEntry[] {
  return candidates
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        a.entry.relative.length - b.entry.relative.length ||
        a.entry.relative.localeCompare(b.entry.relative),
    )
    .map((candidate) => candidate.entry);
}

/** Appended to "not found" messages when the listing was cut short. */
function truncationHint(listing: TreeListing, maxEntries: number): string {
  return listing.truncated
    ? ` (search stopped after ${maxEntries} entries — name a path, or narrow the directory you run from)`
    : "";
}

/** Resolve one `@ref` to concrete absolute paths. */
export async function resolveRef(ref: string, options: ResolveOptions): Promise<Resolution> {
  const {
    cwd,
    includeSecrets = false,
    allMatches = false,
    maxEntries = MAX_SEARCH_ENTRIES,
    noGit = false,
  } = options;

  // 1. An existing path always wins: no surprises, no tree walk.
  const literal = path.resolve(cwd, ref);
  const info = await stat(literal).catch(() => null);
  if (info) return { ref, kind: "path", paths: [literal] };

  if (hasGlobMagic(ref)) {
    const pattern = globToRegExp(ref.split(path.sep).join("/"));
    const listing = await listTree(cwd, includeSecrets, maxEntries, noGit);
    const matches = listing.entries.filter(
      (entry) => !entry.isDirectory && pattern.test(entry.relative),
    );

    if (matches.length === 0) {
      throw new RefResolutionError(
        `no file matches @${ref}${truncationHint(listing, maxEntries)}`,
        ref,
      );
    }
    return { ref, kind: "glob", paths: matches.map((entry) => entry.absolute) };
  }

  // 3. Plain text: ranked search.
  const listing = await listTree(cwd, includeSecrets, maxEntries, noGit);
  const scored: { entry: TreeEntry; rank: number }[] = [];
  for (const entry of listing.entries) {
    const rank = rankMatch(entry.relative, ref);
    if (rank !== null) scored.push({ entry, rank });
  }

  if (scored.length === 0) {
    throw new RefResolutionError(
      `no such path, and nothing in the tree matched @${ref}` +
        truncationHint(listing, maxEntries),
      ref,
    );
  }

  const ordered = sortCandidates(scored);
  if (allMatches) {
    return { ref, kind: "search", paths: ordered.map((entry) => entry.absolute) };
  }

  // Only a tie at the *best* rank is ambiguous: `@chat` preferring src/chat.ts
  // over test/chat.test.ts is the intuitive answer, not a coin toss.
  const bestRank = Math.min(...scored.map((candidate) => candidate.rank));
  const best = sortCandidates(scored.filter((candidate) => candidate.rank === bestRank));

  if (best.length > 1) {
    throw new RefResolutionError(
      `@${ref} matches ${best.length} paths equally well`,
      ref,
      best.map((entry) => entry.relative),
    );
  }

  return { ref, kind: "search", paths: [best[0]!.absolute] };
}
