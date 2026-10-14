// .env loading, without depending on `process.loadEnvFile`.
//
// That built-in only exists from Node 20.12, and on older runtimes the previous
// implementation skipped .env files silently — the failure looked like "no API
// key" with a perfectly good .env sitting right there. One code path now, on
// every supported Node, and the result is reportable so the CLI can say what it
// actually read.
//
// Precedence: the real environment always wins, then the first file that
// defines a key. Nothing already exported is overwritten.

import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { terminalField } from "./terminal.ts";

export interface EnvFileReport {
  readonly file: string;
  /** True when only an allowlist of keys could be applied from this file. */
  readonly restricted?: boolean;
  /** False when the file does not exist or could not be read. */
  readonly found: boolean;
  /** Keys the file defined, whether or not they were applied. */
  readonly keys: readonly string[];
  /** Keys this file actually set, i.e. not already in the environment. */
  readonly applied: readonly string[];
  /** Keys the file defined but was not allowed to set. Never includes values. */
  readonly ignored?: readonly string[];
}

/** An explicitly trusted caller may omit `allow`; automatic CLI loads never do. */
export interface EnvCandidate {
  readonly file: string;
  readonly allow?: ReadonlySet<string>;
}

/** Keys permitted in every automatically discovered .env, including the install root. */
export const PROJECT_ENV_KEYS: ReadonlySet<string> = new Set([
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_ORG_ID",
  "OPENAI_PROJECT_ID",
  "ASK_MODEL",
]);

/**
 * Parse dotenv syntax: `KEY=value`, optional `export`, `#` comments, single or
 * double quoted values (with `\n` escapes inside double quotes). Malformed
 * lines are ignored rather than throwing — a stray line should not stop the CLI.
 */
export function parseDotenv(text: string): Map<string, string> {
  const values = new Map<string, string>();

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;

    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;

    const key = match[1]!;
    let value = match[2] ?? "";

    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value
        .slice(1, -1)
        .replace(/\\n/g, "\n")
        .replace(/\\r/g, "\r")
        .replace(/\\t/g, "\t")
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\");
    } else if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
      value = value.slice(1, -1);
    } else {
      // Unquoted: an inline comment ends the value.
      const comment = value.indexOf(" #");
      if (comment !== -1) value = value.slice(0, comment);
      value = value.trim();
    }

    values.set(key, value);
  }

  return values;
}

/**
 * Apply each candidate .env in order, never overwriting existing variables.
 * Canonical aliases are read once, with the intersection of their allowlists.
 * Resolve every policy first, so a later restricted alias cannot arrive after
 * an unrestricted load has already applied its keys.
 * Returns what was seen, for diagnostics.
 */
export async function applyEnvFiles(
  candidates: readonly (string | EnvCandidate)[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<EnvFileReport[]> {
  const reports: EnvFileReport[] = [];
  const sources = new Map<string, {
    file: string;
    readPath: string | null;
    allow: ReadonlySet<string> | undefined;
  }>();

  for (const candidate of candidates) {
    const { file, allow } = typeof candidate === "string" ? { file: candidate } : candidate;
    const readPath = await realpath(file).catch(() => null);
    const identity = readPath ?? path.resolve(file);
    const existing = sources.get(identity);
    if (existing) {
      if (allow) {
        existing.allow = existing.allow
          ? new Set([...existing.allow].filter((key) => allow.has(key)))
          : allow;
      }
    } else {
      sources.set(identity, { file, readPath, allow });
    }
  }

  for (const { file, readPath, allow } of sources.values()) {
    if (readPath === null) {
      reports.push({ file, found: false, keys: [], applied: [] });
      continue;
    }
    let text: string;
    try {
      text = await readFile(readPath, "utf8");
    } catch {
      reports.push({ file, found: false, keys: [], applied: [] });
      continue;
    }

    const parsed = parseDotenv(text);
    const applied: string[] = [];
    const ignored: string[] = [];
    for (const [key, value] of parsed) {
      if (allow && !allow.has(key)) {
        ignored.push(key);
        continue;
      }
      if (env[key] === undefined) {
        env[key] = value;
        applied.push(key);
      }
    }
    reports.push({
      file,
      found: true,
      keys: [...parsed.keys()],
      applied,
      ...(allow ? { restricted: true, ignored } : {}),
    });
  }

  return reports;
}

/**
 * Which automatic file supplied the effective environment endpoint, if any.
 * Use applied keys, not merely defined ones: exported shell settings win.
 * A key supplied by the same file does not establish trust in its endpoint,
 * and a CLI API-key override must not turn that into a provenance bypass.
 */
export function endpointFromEnvFile(reports: readonly EnvFileReport[]): string | null {
  return reports.find((report) => report.applied.includes("OPENAI_BASE_URL"))?.file ?? null;
}

/** Diagnostic for when a needed variable is missing despite a .env existing. */
export function describeEnvFiles(reports: readonly EnvFileReport[], lookingFor: string): string {
  const lines = reports.map((report) => {
    const file = terminalField(report.file);
    if (!report.found) return `  ${file} — not found`;
    if (report.keys.includes(lookingFor)) {
      return `  ${file} — defines ${lookingFor}`;
    }
    const summary = report.keys.length > 0 ? report.keys.join(", ") : "no variables";
    return `  ${file} — read, but no ${lookingFor} (has: ${summary})`;
  });
  return `checked for ${lookingFor} in:\n${lines.join("\n")}`;
}
