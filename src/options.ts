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
  "all-matches": { type: "boolean" },
  "include-secrets": { type: "boolean" },
  new: { type: "boolean" },
  compact: { type: "boolean" },
  "install-completion": { type: "boolean" },
  apply: { type: "boolean" },
  "no-color": { type: "boolean" },
  raw: { type: "boolean" },
  switch: { type: "string" },
  "list-sessions": { type: "boolean" },
  write: { type: "string" },
  create: { type: "string" },
  skill: { type: "string", multiple: true },
  "list-skills": { type: "boolean" },
  diff: { type: "string" },
  force: { type: "boolean" },
  reset: { type: "boolean" },
  session: { type: "string" },
  "show-session": { type: "boolean" },
  "no-session": { type: "boolean" },
  "session-max-tokens": { type: "string" },
  "show-context": { type: "boolean" },
  "dry-run": { type: "boolean" },
  json: { type: "boolean" },
  quiet: { type: "boolean", short: "q" },
  version: { type: "boolean", short: "V" },
  help: { type: "boolean", short: "h" },
} as const;

/**
 * Chat-style verbs accepted as the first positional. Each maps to the flag of
 * the same name; the verb form is what the docs lead with, the flag form exists
 * for scripts and completion.
 */
export const VERBS: Readonly<Record<string, string>> = {
  "/new": "new",
  "/reset": "reset",
  "/session": "show-session",
  "/sessions": "list-sessions",
  "/compact": "compact",
  "/switch": "switch",
  "/write": "write",
  "/diff": "diff",
  "/create": "create",
  "/skills": "list-skills",
};

/** Verbs that consume the next positional as their value, e.g. `/switch docs`. */
export interface VerbValue {
  /** What the value is, for error messages. */
  readonly noun: string;
  readonly example: string;
  /** True when the value is a path, so a leading `@` is accepted and stripped. */
  readonly isPath: boolean;
}

/** Verbs that consume the next positional as their value. */
export const VERBS_WITH_VALUE: ReadonlyMap<string, VerbValue> = new Map([
  ["/switch", { noun: "a thread name", example: "/switch review", isPath: false }],
  [
    "/create",
    { noun: "a path", example: "/create test/env.test.ts 'write tests'", isPath: true },
  ],
  ["/write", { noun: "a path", example: "/write src/chat.ts 'add a docstring'", isPath: true }],
  ["/diff", { noun: "a path", example: "/diff src/chat.ts 'add a docstring'", isPath: true }],
]);

/** Every accepted flag spelling, e.g. `--model` and `-m`. */
export function flagSpellings(): string[] {
  const spellings: string[] = [];
  for (const [name, config] of Object.entries(OPTIONS)) {
    spellings.push(`--${name}`);
    if ("short" in config) spellings.push(`-${config.short}`);
  }
  return spellings.sort();
}
