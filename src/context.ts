// Context collection: turn `@ref` references into deterministic text blocks.
//
// Pure and offline: no network, no writes. Directory walks are sorted, so the
// same tree always produces byte-identical prompt text.
//
// Reference resolution (exact path, glob, or search) lives in refs.ts; this
// module turns resolved paths into capped, filtered blocks.

import { readdir, readFile, stat } from "node:fs/promises";
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
  | "not-a-regular-file";

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
 * A bare `@` stays in the question.
 */
export function extractRefs(prompt: string | undefined): ExtractedPrompt {
  const refs: string[] = [];
  const words: string[] = [];
  for (const token of String(prompt ?? "").split(/\s+/)) {
    if (token.length > 1 && token.startsWith("@")) {
      // Trailing punctuation is common in natural prompts: "@src/a.ts,"
      refs.push(token.slice(1).replace(/[,;:]$/, ""));
    } else if (token.length > 0) {
      words.push(token);
    }
  }
  return { refs, question: words.join(" ") };
}

interface WalkState {
  readonly cwd: string;
  readonly limits: Limits;
  readonly includeSecrets: boolean;
  readonly found: string[];
  readonly skipped: SkippedEntry[];
}

async function walk(dir: string, state: WalkState): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    if (state.found.length >= state.limits.maxFiles) {
      state.skipped.push({ path: path.relative(state.cwd, dir), reason: "max-files" });
      return;
    }
    const absolute = path.join(dir, entry.name);
    const relative = path.relative(state.cwd, absolute);

    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await walk(absolute, state);
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
    if (!state.includeSecrets && isSecretPath(relative)) {
      state.skipped.push({ path: relative, reason: "looks-like-secret" });
      continue;
    }
    state.found.push(absolute);
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
  const cwd = options.cwd ?? process.cwd();
  const limits = resolveLimits(options.limits);
  const includeSecrets = options.includeSecrets ?? false;

  const candidates: string[] = [];
  const skipped: SkippedEntry[] = [];
  const resolutions: Resolution[] = [];

  for (const ref of refs) {
    const resolution = await resolveRef(ref, {
      cwd,
      includeSecrets,
      allMatches: options.allMatches ?? false,
    });
    resolutions.push(resolution);

    for (const absolute of resolution.paths) {
      const info = await stat(absolute);

      if (info.isDirectory()) {
        await walk(absolute, { cwd, limits, includeSecrets, found: candidates, skipped });
        continue;
      }
      if (!info.isFile()) {
        skipped.push({ path: path.relative(cwd, absolute), reason: "not-a-regular-file" });
        continue;
      }
      // Explicit file references bypass extension and lockfile filters, but
      // never silently ship credentials.
      const relative = path.relative(cwd, absolute);
      if (!includeSecrets && isSecretPath(relative)) {
        skipped.push({ path: relative, reason: "looks-like-secret" });
      } else {
        candidates.push(absolute);
      }
    }
  }

  const blocks: ContextBlock[] = [];
  let totalBytes = 0;
  let truncated = false;

  for (const absolute of new Set(candidates)) {
    const relative = path.relative(cwd, absolute) || path.basename(absolute);
    if (totalBytes >= limits.maxTotalBytes) {
      skipped.push({ path: relative, reason: "max-total-bytes" });
      truncated = true;
      continue;
    }
    const buffer = await readFile(absolute);
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

  return { blocks, skipped, resolutions, totalBytes, truncated };
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
