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

import { readFile } from "node:fs/promises";

export interface EnvFileReport {
  readonly file: string;
  /** False when the file does not exist or could not be read. */
  readonly found: boolean;
  /** Keys the file defined, whether or not they were applied. */
  readonly keys: readonly string[];
  /** Keys this file actually set, i.e. not already in the environment. */
  readonly applied: readonly string[];
}

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
 * Returns what was seen, for diagnostics.
 */
export async function applyEnvFiles(
  candidates: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<EnvFileReport[]> {
  const reports: EnvFileReport[] = [];

  for (const file of candidates) {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      reports.push({ file, found: false, keys: [], applied: [] });
      continue;
    }

    const parsed = parseDotenv(text);
    const applied: string[] = [];
    for (const [key, value] of parsed) {
      if (env[key] === undefined) {
        env[key] = value;
        applied.push(key);
      }
    }
    reports.push({ file, found: true, keys: [...parsed.keys()], applied });
  }

  return reports;
}

/** Diagnostic for when a needed variable is missing despite a .env existing. */
export function describeEnvFiles(reports: readonly EnvFileReport[], lookingFor: string): string {
  const lines = reports.map((report) => {
    if (!report.found) return `  ${report.file} — not found`;
    if (report.keys.includes(lookingFor)) {
      return `  ${report.file} — defines ${lookingFor}`;
    }
    const summary = report.keys.length > 0 ? report.keys.join(", ") : "no variables";
    return `  ${report.file} — read, but no ${lookingFor} (has: ${summary})`;
  });
  return `checked for ${lookingFor} in:\n${lines.join("\n")}`;
}
