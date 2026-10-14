// Context collection: turn `@ref` references into deterministic text blocks.
//
// Pure and offline: no network, no writes. Directory walks are sorted, so the
// same tree always produces byte-identical prompt text.
//
// Reference resolution (exact path, glob, or search) lives in refs.ts; this
// module turns resolved paths into capped, filtered blocks.

import { constants, type Stats } from "node:fs";
import { open, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { resolveRef, type Resolution } from "./refs.ts";
import { isProbablyBinary, isSecretPath, LOCKFILES, SKIP_DIRS, SKIP_EXTENSIONS } from "./skip.ts";

export { SKIP_DIRS, SKIP_EXTENSIONS } from "./skip.ts";

export interface Limits {
  /** Per-file cap; larger files are included truncated with a marker. */
  readonly maxFileBytes: number;
  /** Whole-context cap; collection stops once exceeded. */
  readonly maxTotalBytes: number;
  /** Safety valve for wide directory trees. */
  readonly maxFiles: number;
}

/** Callers may pass unset flags straight through, hence `undefined` here. */
export type LimitOverrides = Partial<Record<keyof Limits, number | undefined>>;

export type SkipReason =
  | "binary-extension"
  | "binary-content"
  | "lockfile"
  | "looks-like-secret"
  | "max-files"
  | "max-total-bytes"
  | "not-a-regular-file"
  | "symlink-outside-tree"
  | "unresolvable-path"
  | "path-changed"
  | "unreadable";

export interface ContextBlock {
  /** Path relative to `cwd`, as shown to the model. */
  readonly path: string;
  /** Size on disk, before any truncation. */
  readonly bytes: number;
  readonly text: string;
  readonly truncated: boolean;
}

export interface SkippedEntry {
  readonly path: string;
  readonly reason: SkipReason;
}

export interface ContextResult {
  readonly blocks: readonly ContextBlock[];
  readonly skipped: readonly SkippedEntry[];
  /** How each `@ref` was resolved: verbatim path, glob, or search. */
  readonly resolutions: readonly Resolution[];
  /**
   * Directories that were expanded. A directory holding a single file would
   * otherwise be indistinguishable from naming that file, which matters for
   * --write.
   */
  readonly directories: readonly string[];
  readonly totalBytes: number;
  readonly truncated: boolean;
}

export interface CollectOptions {
  readonly cwd?: string;
  readonly includeSecrets?: boolean;
  /** Attach every search match instead of erroring on ties. */
  readonly allMatches?: boolean;
  readonly limits?: LimitOverrides;
}

export interface ExtractedPrompt {
  readonly refs: readonly string[];
  readonly question: string;
}

export const DEFAULT_LIMITS: Limits = {
  maxFileBytes: 256 * 1024,
  maxTotalBytes: 1024 * 1024,
  maxFiles: 200,
};

/**
 * Merge caller limits over the defaults, ignoring `undefined` and non-positive
 * entries. The CLI passes unset flags through as `undefined`, and a plain
 * spread would clobber the defaults with NaN caps.
 */
export function resolveLimits(overrides: LimitOverrides = {}): Limits {
  const limits: Record<keyof Limits, number> = { ...DEFAULT_LIMITS };
  for (const key of Object.keys(DEFAULT_LIMITS) as (keyof Limits)[]) {
    const value = overrides[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      limits[key] = value;
    }
  }
  return limits;
}

/**
 * Split a prompt into `@ref` references and the remaining question text.
 *
 * A bare `@` stays in the question. A reference containing spaces can be quoted
 * — `@"name with spaces.md"` or `@'name with spaces.md'` — since the shell has
 * already consumed the outer quotes by the time the prompt arrives here.
 */
export function extractRefs(prompt: string | undefined): ExtractedPrompt {
  const text = String(prompt ?? "");
  const refs: string[] = [];
  const words: string[] = [];

  // Matches a quoted reference, an unquoted reference, or a plain word.
  const pattern = /@"([^"]*)"|@'([^']*)'|(\S+)/g;
  for (const match of text.matchAll(pattern)) {
    const quoted = match[1] ?? match[2];
    if (quoted !== undefined) {
      refs.push(quoted);
      continue;
    }
    const token = match[3] ?? "";
    if (token.length > 1 && token.startsWith("@")) {
      // Trailing punctuation is common in natural prompts: "@src/a.ts,"
      refs.push(token.slice(1).replace(/[,;:]$/, ""));
    } else if (token.length > 0) {
      words.push(token);
    }
  }
  return { refs, question: words.join(" ") };
}

interface CheckedPath {
  /** Original name retained for prompt labels and write-target matching. */
  readonly absolute: string;
  /** Canonical name used for filesystem access after policy checks. */
  readonly real: string;
  readonly info: Stats;
}

interface WalkState {
  readonly cwd: string;
  readonly realCwd: string;
  readonly limits: Limits;
  readonly includeSecrets: boolean;
  readonly found: CheckedPath[];
  readonly skipped: SkippedEntry[];
}

function skip(absolute: string, state: WalkState, reason: SkipReason): void {
  state.skipped.push({ path: path.relative(state.cwd, absolute) || ".", reason });
}

/** Component-aware: `..notes` is a child name, unlike `..` or `../notes`. */
function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Account for ambient links above cwd without trusting links on the new branch. */
async function unlinkedPath(absolute: string, state: WalkState): Promise<string | null> {
  let ancestor = state.cwd;
  while (!isInside(ancestor, absolute)) {
    const parent = path.dirname(ancestor);
    // Different Windows drives have no shared ancestor to canonicalise.
    if (parent === ancestor) return absolute;
    ancestor = parent;
  }
  const realAncestor = ancestor === state.cwd
    ? state.realCwd : await realpath(ancestor).catch(() => null);
  return realAncestor === null ? null : path.resolve(realAncestor, path.relative(ancestor, absolute));
}

/** Validate before either reading a file or enumerating a directory. */
async function checkPath(absolute: string, state: WalkState): Promise<CheckedPath | null> {
  const real = await realpath(absolute).catch(() => null);
  if (real === null) {
    skip(absolute, state, "unresolvable-path");
    return null;
  }
  const relative = path.relative(state.cwd, absolute);
  // Compare against where the path would land without links on its branch.
  // Directly named outside paths remain usable, including beside a symlinked
  // cwd, but an alias that redirects outside the working tree is refused.
  const unlinked = await unlinkedPath(absolute, state);
  if (unlinked === null) {
    skip(absolute, state, "unresolvable-path");
    return null;
  }
  if (real !== unlinked && !isInside(state.realCwd, real)) {
    skip(absolute, state, "symlink-outside-tree");
    return null;
  }
  if (!state.includeSecrets && (isSecretPath(relative) || isSecretPath(real))) {
    skip(absolute, state, "looks-like-secret");
    return null;
  }
  const info = await stat(real).catch(() => null);
  if (info === null) {
    skip(absolute, state, "unresolvable-path");
    return null;
  }
  return { absolute, real, info };
}

function sameFile(before: Stats, after: Stats): boolean {
  return before.dev === after.dev && before.ino === after.ino;
}

async function samePaths(candidate: CheckedPath): Promise<boolean> {
  return (await realpath(candidate.absolute).catch(() => null)) === candidate.real &&
    (await realpath(candidate.real).catch(() => null)) === candidate.real;
}

async function readCheckedFile(candidate: CheckedPath, state: WalkState): Promise<Buffer | null> {
  // O_NOFOLLOW protects the final component where supported. O_NONBLOCK avoids
  // hanging if a regular file was replaced with a FIFO before open(). The file
  // handle's type/identity and the canonical paths are checked before reading.
  const handle = await open(candidate.real,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  ).catch(() => null);
  if (handle === null) {
    skip(candidate.absolute, state, "unreadable");
    return null;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || !sameFile(candidate.info, info) || !(await samePaths(candidate))) {
      skip(candidate.absolute, state, "path-changed");
      return null;
    }
    return await handle.readFile();
  } catch {
    skip(candidate.absolute, state, "unreadable");
    return null;
  } finally {
    await handle.close();
  }
}

async function walk(dir: CheckedPath, state: WalkState): Promise<void> {
  const info = await stat(dir.real).catch(() => null);
  if (!info?.isDirectory() || !sameFile(dir.info, info) || !(await samePaths(dir))) {
    skip(dir.absolute, state, "path-changed");
    return;
  }
  const entries = await readdir(dir.real, { withFileTypes: true }).catch(() => null);
  if (entries === null) {
    skip(dir.absolute, state, "unreadable");
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    if (state.found.length >= state.limits.maxFiles) {
      skip(dir.absolute, state, "max-files");
      return;
    }
    const absolute = path.join(dir.absolute, entry.name);
    const relative = path.relative(state.cwd, absolute);

    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const checked = await checkPath(absolute, state);
      if (checked?.info.isDirectory()) await walk(checked, state);
      else if (checked) skip(absolute, state, "path-changed");
      continue;
    }
    if (!entry.isFile()) continue;
    if (SKIP_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      state.skipped.push({ path: relative, reason: "binary-extension" });
      continue;
    }
    if (LOCKFILES.has(entry.name)) {
      state.skipped.push({ path: relative, reason: "lockfile" });
      continue;
    }
    const checked = await checkPath(absolute, state);
    if (checked?.info.isFile()) state.found.push(checked);
    else if (checked) skip(absolute, state, "path-changed");
  }
}

/**
 * Resolve every reference, expand directories, and read the result into ordered
 * text blocks. A reference that matches nothing (or several things equally
 * well) rejects with a RefResolutionError; everything else degrades to a
 * `skipped` entry so the caller can report exactly what was and was not sent.
 */
export async function collectContext(
  refs: readonly string[],
  options: CollectOptions = {},
): Promise<ContextResult> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  // No lexical fallback: containment cannot be established without this root.
  const realCwd = await realpath(cwd);
  const limits = resolveLimits(options.limits);
  const includeSecrets = options.includeSecrets ?? false;

  const candidates: CheckedPath[] = [];
  const skipped: SkippedEntry[] = [];
  const resolutions: Resolution[] = [];
  const directories: string[] = [];
  const state: WalkState = { cwd, realCwd, limits, includeSecrets, found: candidates, skipped };

  for (const ref of refs) {
    const resolution = await resolveRef(ref, {
      cwd,
      includeSecrets,
      allMatches: options.allMatches ?? false,
    });
    resolutions.push(resolution);

    for (const absolute of resolution.paths) {
      const checked = await checkPath(absolute, state);
      if (checked === null) continue;
      const { info } = checked;

      if (info.isDirectory()) {
        directories.push(path.relative(cwd, absolute) || ".");
        await walk(checked, state);
        continue;
      }
      if (!info.isFile()) {
        skipped.push({ path: path.relative(cwd, absolute), reason: "not-a-regular-file" });
        continue;
      }
      // Explicit files bypass extension/lockfile filters, but checkPath already
      // applied containment and secret rules to both alias and canonical names.
      candidates.push(checked);
    }
  }

  const blocks: ContextBlock[] = [];
  let totalBytes = 0;
  let truncated = false;

  const seen = new Set<string>();
  for (const candidate of candidates) {
    const { absolute } = candidate;
    if (seen.has(absolute)) continue;
    seen.add(absolute);
    const relative = path.relative(cwd, absolute) || path.basename(absolute);
    if (totalBytes >= limits.maxTotalBytes) {
      skipped.push({ path: relative, reason: "max-total-bytes" });
      truncated = true;
      continue;
    }
    const buffer = await readCheckedFile(candidate, state);
    if (buffer === null) continue;
    if (isProbablyBinary(buffer)) {
      skipped.push({ path: relative, reason: "binary-content" });
      continue;
    }
    const room = Math.min(limits.maxFileBytes, limits.maxTotalBytes - totalBytes);
    const clipped = buffer.byteLength > room;
    if (clipped) truncated = true;
    blocks.push({
      path: relative,
      bytes: buffer.byteLength,
      text: buffer.subarray(0, room).toString("utf8"),
      truncated: clipped,
    });
    totalBytes += Math.min(buffer.byteLength, room);
  }

  return { blocks, skipped, resolutions, directories, totalBytes, truncated };
}

/** Assemble the single user message: context blocks first, question last. */
export function renderPrompt(
  question: string,
  context: ContextResult | undefined,
  stdinText = "",
): string {
  const parts: string[] = [];
  for (const block of context?.blocks ?? []) {
    const marker = block.truncated ? ` truncated="true" bytes="${block.bytes}"` : "";
    parts.push(`<file path="${block.path}"${marker}>\n${block.text}\n</file>`);
  }
  if (stdinText) parts.push(`<stdin>\n${stdinText}\n</stdin>`);
  if (question) parts.push(question);
  return parts.join("\n\n");
}
