// Flag table, kept in its own module so the shell completion script can be
// checked against it in tests. Adding a flag here without adding it to
// completions/ask.bash fails test/completion.test.ts.

export const OPTIONS = {
  model: { type: "string", short: "m" },
  system: { type: "string", short: "s" },
  "system-file": { type: "string" },
  "base-url": { type: "string" },
  "api-key": { type: "string" },
  file: { type: "string", short: "f", multiple: true },
  "max-tokens": { type: "string" },
  temperature: { type: "string" },
  "token-field": { type: "string" },
  "max-file-bytes": { type: "string" },
  "max-total-bytes": { type: "string" },
  "max-files": { type: "string" },
  "include-secrets": { type: "boolean" },
  "show-context": { type: "boolean" },
  "dry-run": { type: "boolean" },
  json: { type: "boolean" },
  quiet: { type: "boolean", short: "q" },
  version: { type: "boolean", short: "V" },
  help: { type: "boolean", short: "h" },
} as const;

/** Every accepted flag spelling, e.g. `--model` and `-m`. */
export function flagSpellings(): string[] {
  const spellings: string[] = [];
  for (const [name, config] of Object.entries(OPTIONS)) {
    spellings.push(`--${name}`);
    if ("short" in config) spellings.push(`-${config.short}`);
  }
  return spellings.sort();
}
