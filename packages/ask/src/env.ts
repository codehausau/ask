// Reading old .env files only to explain that they are no longer used.
//
// ask's settings live in layered JSON config (see config.ts). Earlier versions
// read .env from the working directory and the install location; a project's
// .env belongs to that project, so it is never applied. When a key is missing,
// legacyEnvNotice names ask settings left behind in such a file.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { globalConfigDir, NAMED_VARIABLES } from "./config.ts";
import { terminalField } from "./terminal.ts";

/** Variables earlier versions read from .env files. */
const LEGACY_KEYS: ReadonlySet<string> = new Set([
  "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_ORG_ID", "OPENAI_PROJECT_ID",
  ...NAMED_VARIABLES.map((variable) => variable.name),
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
 * Explain ask settings left in a .env that is no longer read automatically,
 * when they are not set any other way. Values are never applied or shown.
 */
export async function legacyEnvNotice(files: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const found: string[] = [];
  for (const file of new Set(files)) {
    const text = await readFile(file, "utf8").catch(() => null);
    if (text === null) continue;
    const keys = [...parseDotenv(text).keys()].filter((key) => LEGACY_KEYS.has(key) && env[key] === undefined);
    if (keys.length) found.push(`${terminalField(file)} (${keys.join(", ")})`);
  }
  if (!found.length) return null;
  return `ask no longer reads .env files; not used: ${found.join("; ")}. ` +
    `Put settings in ${terminalField(path.join(globalConfigDir(env), "ask.json"))}, ` +
    'for example { "endpoint": { "apiKey": "{env:OPENAI_API_KEY}" } }, or export the variables.';
}
