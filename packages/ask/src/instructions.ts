// Read instruction files (AGENTS.md and `instructions` entries) for the system
// prompt. Only paths and globs: never the ranked search @refs use, so a missing
// file is reported rather than replaced by a similar name.

import { open, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { InstructionEntry } from "./config.ts";
import { hasGlobMagic, resolveRef } from "./refs.ts";
import { isProbablyBinary, isSecretPath } from "./skip.ts";
import { terminalField } from "./terminal.ts";

/** Instructions are prompt text: keep them small enough to leave room for context. */
export const INSTRUCTION_LIMITS = { maxFileBytes: 64 * 1024, maxTotalBytes: 256 * 1024, maxFiles: 50 };

export interface InstructionFile {
  /** Shown to the model and the user: project-relative, or ~-relative. */
  readonly display: string;
  readonly source: string;
  readonly text: string;
  readonly truncated: boolean;
}

export interface LoadedInstructions {
  readonly files: readonly InstructionFile[];
  /** Missing, skipped and truncated files. */
  readonly notes: readonly string[];
}

function inside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function display(file: string, projectRoot: string): string {
  if (inside(projectRoot, file)) return path.relative(projectRoot, file);
  const home = homedir();
  return inside(home, file) ? `~/${path.relative(home, file)}` : file;
}

/** Split an absolute glob into the directory to list and the pattern within it. */
function splitGlob(pattern: string): { base: string; relative: string } {
  const parts = pattern.split(path.sep);
  const first = parts.findIndex((part) => hasGlobMagic(part));
  return { base: parts.slice(0, first).join(path.sep) || path.sep, relative: parts.slice(first).join("/") };
}

async function expand(entry: InstructionEntry, notes: string[]): Promise<string[]> {
  if (!hasGlobMagic(entry.pattern)) return [entry.pattern];
  const { base, relative } = splitGlob(entry.pattern);
  try {
    const resolution = await resolveRef(relative, { cwd: base });
    return resolution.kind === "glob" ? [...resolution.paths].sort() : [];
  } catch {
    notes.push(`${entry.source}: no instruction files match ${terminalField(entry.pattern)}`);
    return [];
  }
}

/** Read at most `limit` bytes, plus one to detect that there was more. */
async function readBounded(file: string, limit: number): Promise<Buffer> {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    return buffer.subarray(0, length);
  } finally {
    await handle.close();
  }
}

/** Read every entry in order. Problems become notes; nothing here throws for a bad file. */
export async function loadInstructions(entries: readonly InstructionEntry[], projectRoot: string): Promise<LoadedInstructions> {
  const files: InstructionFile[] = [];
  const notes: string[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const entry of entries) {
    for (const file of await expand(entry, notes)) {
      const shown = terminalField(display(file, projectRoot));
      const real = await realpath(file).catch(() => null);
      if (real === null) {
        if (!entry.implicit) notes.push(`${entry.source}: instruction file ${shown} not found`);
        continue;
      }
      if (seen.has(real)) continue;
      seen.add(real);
      if (entry.within && !inside(await realpath(entry.within).catch(() => entry.within!), real)) {
        notes.push(`${entry.source}: not reading ${shown}: it leads outside the project`);
        continue;
      }
      if (!(await stat(real)).isFile()) { notes.push(`${entry.source}: not reading ${shown}: not a regular file`); continue; }
      if (isSecretPath(display(file, projectRoot)) || isSecretPath(real)) {
        notes.push(`${entry.source}: not reading ${shown}: looks like a credentials file`);
        continue;
      }
      if (files.length >= INSTRUCTION_LIMITS.maxFiles || total >= INSTRUCTION_LIMITS.maxTotalBytes) {
        notes.push(`${entry.source}: not reading ${shown}: instruction limit reached (${INSTRUCTION_LIMITS.maxFiles} files, ${INSTRUCTION_LIMITS.maxTotalBytes / 1024} KB)`);
        continue;
      }
      const room = Math.min(INSTRUCTION_LIMITS.maxFileBytes, INSTRUCTION_LIMITS.maxTotalBytes - total);
      const bytes = await readBounded(real, room);
      if (isProbablyBinary(bytes)) { notes.push(`${entry.source}: not reading ${shown}: not text`); continue; }
      const truncated = bytes.length > room;
      const text = bytes.subarray(0, Math.min(bytes.length, room)).toString("utf8");
      if (truncated) notes.push(`${entry.source}: ${shown} truncated to ${Math.round(room / 1024)} KB`);
      total += Buffer.byteLength(text, "utf8");
      files.push({ display: display(file, projectRoot), source: entry.source, text, truncated });
    }
  }
  return { files, notes };
}

/** Instruction blocks for the system prompt, after the base prompt and before skills. */
export function renderInstructions(files: readonly InstructionFile[]): string {
  return files.map((file) =>
    `<instructions source=${JSON.stringify(file.display)}${file.truncated ? ' truncated="true"' : ""}>\n${file.text}\n</instructions>`,
  ).join("\n\n");
}
