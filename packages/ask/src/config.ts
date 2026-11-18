// Layered JSON configuration, shared by the CLI and the TUI.
//
// Layers, lowest to highest precedence:
//   built-in defaults   OPENAI_* exports, via {env:} substitution
//   global              $XDG_CONFIG_HOME/ask/ (default ~/.config/ask/)
//   custom              --config <dir> or $ASK_CONFIG
//   project             <project root>/ask.json(c)
//   .ask                <project root>/.ask/
//   inline              $ASK_CONFIG_CONTENT
//   environment         ASK_MODEL, ASK_TIMEOUT, ... (one setting each)
//   flags               --model, --timeout, ...
//
// Instruction files: each config directory's AGENTS.md, the project root's
// AGENTS.md (never a parent directory's), and any `instructions` entries,
// which resolve against the directory of the file that lists them.
//
// Each directory may hold ask.json(c) (common settings), cli.json(c) and
// tui.json(c). Objects merge key by key, scalars are replaced, arrays are
// concatenated without duplicates, and null removes a lower layer's value.
//
// A project's files are written by whoever wrote the repository. Until the user
// runs `ask /trust`, project layers cannot choose the endpoint or key (where
// files and credentials are sent) and cannot use {env:} (which would copy any
// secret in the environment into a request). Trust is recorded with a hash of
// the files, so a changed file needs trusting again.

import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { gitRoot } from "./git.ts";
import { stateDir } from "./session.ts";
import { terminalField } from "./terminal.ts";
import { timeoutSecondsToMs } from "./timeout.ts";

export class ConfigFileError extends Error {}

export interface EndpointSettings {
  readonly url?: string;
  readonly apiKey?: string;
  readonly organization?: string;
  readonly project?: string;
}

export type UpdateView = "search-replace" | "diff";

export interface Settings {
  readonly model?: string;
  readonly system?: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
  /** Seconds. */
  readonly timeout?: number;
  /** Instruction files or globs, resolved to absolute paths. */
  readonly instructions?: readonly string[];
  readonly endpoint: EndpointSettings;
  readonly cli: {
    readonly sessionMaxTokens?: number;
    /** Idle minutes before a thread starts fresh; 0 never expires. */
    readonly sessionTtlMinutes?: number;
    readonly next?: boolean;
    readonly spinner?: "auto" | "off" | "ascii";
  };
  readonly tui: { readonly theme?: string; readonly contextWindow?: number; readonly mouse?: boolean; readonly updateView?: UpdateView };
}

export type Kind = "string" | "stringArray" | "boolean" | "positiveInteger" | "nonNegativeNumber" | "timeout" | "temperature" | "spinner" | "updateView";
export interface Shape { readonly [key: string]: Kind | Shape }

const ENDPOINT: Shape = { url: "string", apiKey: "string", organization: "string", project: "string" };
const COMMON: Shape = {
  model: "string", system: "string", temperature: "temperature", maxTokens: "positiveInteger",
  timeout: "timeout", instructions: "stringArray", endpoint: ENDPOINT,
};
const CLI: Shape = { sessionMaxTokens: "positiveInteger", sessionTtlMinutes: "nonNegativeNumber", next: "boolean", spinner: "spinner" };
const TUI: Shape = { theme: "string", contextWindow: "positiveInteger", mouse: "boolean", updateView: "updateView" };
/** The whole configuration, as ASK_CONFIG_CONTENT and flags express it. */
const ALL: Shape = { ...COMMON, cli: CLI, tui: TUI };

/** Each file's accepted settings; schema/*.schema.json must describe exactly these. */
export const CONFIG_SHAPES: Readonly<Record<"ask" | "cli" | "tui", Shape>> = { ask: COMMON, cli: CLI, tui: TUI };

/** Which file fills which part of the configuration. */
const FILES = [
  { name: "ask", shape: COMMON, section: null },
  { name: "cli", shape: CLI, section: "cli" },
  { name: "tui", shape: TUI, section: "tui" },
] as const;

/** Named variables: one setting each, above ASK_CONFIG_CONTENT and below flags. */
export const NAMED_VARIABLES: readonly { readonly name: string; readonly path: readonly string[] }[] = [
  { name: "ASK_MODEL", path: ["model"] },
  { name: "ASK_SYSTEM", path: ["system"] },
  { name: "ASK_TIMEOUT", path: ["timeout"] },
  { name: "ASK_NEXT", path: ["cli", "next"] },
  { name: "ASK_SESSION_TTL", path: ["cli", "sessionTtlMinutes"] },
  { name: "ASK_SPINNER", path: ["cli", "spinner"] },
  { name: "ASK_THEME", path: ["tui", "theme"] },
  { name: "ASK_CONTEXT_WINDOW", path: ["tui", "contextWindow"] },
];

/** Settings an untrusted project layer may not set: where requests go, and with what key. */
const RESTRICTED = new Set(["endpoint"]);

type Plain = Record<string, unknown>;
const isPlain = (value: unknown): value is Plain =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// ---------------------------------------------------------------------------
// JSONC

/**
 * JSON with // and /* comments and trailing commas. Comments and dropped commas
 * become spaces, so JSON.parse positions still point into the original text.
 */
export function parseJsonc(text: string, file: string): unknown {
  let out = "";
  let i = 0;
  const blank = (s: string) => s.replace(/[^\n]/g, " ");
  while (i < text.length) {
    const char = text[i]!;
    if (char === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (char === "/" && text[i + 1] === "/") {
      const end = text.indexOf("\n", i);
      const stop = end < 0 ? text.length : end;
      out += blank(text.slice(i, stop));
      i = stop;
    } else if (char === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end < 0) throw new ConfigFileError(`${terminalField(file)}: unterminated /* comment`);
      out += blank(text.slice(i, end + 2));
      i = end + 2;
    } else {
      out += char;
      i++;
    }
  }
  try {
    return JSON.parse(withoutTrailingCommas(out));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const position = /position (\d+)/.exec(message);
    let where = "";
    if (position) {
      const before = text.slice(0, Number(position[1]));
      where = `:${before.split("\n").length}:${before.length - before.lastIndexOf("\n")}`;
    }
    throw new ConfigFileError(`${terminalField(file)}${where}: invalid JSON (${message.replace(/ in JSON at.*$/, "")})`);
  }
}

/** Blank a comma followed only by whitespace and } or ], outside strings. */
function withoutTrailingCommas(text: string): string {
  const chars = [...text];
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] === '"') {
      for (i++; i < chars.length && chars[i] !== '"'; i++) if (chars[i] === "\\") i++;
    } else if (chars[i] === ",") {
      let j = i + 1;
      while (j < chars.length && /\s/.test(chars[j]!)) j++;
      if (chars[j] === "}" || chars[j] === "]") chars[i] = " ";
    }
  }
  return chars.join("");
}

// ---------------------------------------------------------------------------
// Validation and substitution

function checkValue(kind: Kind, value: unknown, where: string): unknown {
  const fail = (expected: string) => { throw new ConfigFileError(`${where} must be ${expected}`); };
  switch (kind) {
    case "string": if (typeof value !== "string") fail("a string"); return value;
    case "stringArray":
      if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) fail("an array of strings");
      return value;
    case "boolean": if (typeof value !== "boolean") fail("true or false"); return value;
    case "positiveInteger":
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) fail("a positive integer");
      return value;
    case "nonNegativeNumber":
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) fail("a number of at least 0");
      return value;
    case "spinner":
      if (value !== "auto" && value !== "off" && value !== "ascii") fail('"auto", "off" or "ascii"');
      return value;
    case "updateView":
      if (value !== "search-replace" && value !== "diff") fail('"search-replace" or "diff"');
      return value;
    case "temperature":
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 2) fail("a number from 0 to 2");
      return value;
    case "timeout":
      if (typeof value !== "number") fail("positive seconds");
      try { timeoutSecondsToMs(value as number); } catch { fail("positive seconds (at least 0.001, at most 2147483.647)"); }
      return value;
  }
}

/** Validate against a shape. Unknown keys are reported and dropped; wrong types throw. */
function validate(value: unknown, shape: Shape, where: string, notes: string[], prefix = ""): Plain {
  if (!isPlain(value)) throw new ConfigFileError(`${where}${prefix ? ` ${prefix}` : ""} must be a JSON object`);
  const out: Plain = {};
  for (const [key, raw] of Object.entries(value)) {
    const name = prefix ? `${prefix}.${key}` : key;
    if (key === "$schema" && !prefix) continue;
    const kind = shape[key];
    if (kind === undefined) { notes.push(`${where}: unknown setting ${terminalField(name)} (ignored)`); continue; }
    if (raw === null) { out[key] = null; continue; }
    out[key] = typeof kind === "string"
      ? checkValue(kind, raw, `${where}: ${name}`)
      : validate(raw, kind, where, notes, name);
  }
  return out;
}

const ENV_REFERENCE = /\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g;
const HAS_ENV_REFERENCE = /\{env:[A-Za-z_][A-Za-z0-9_]*\}/;

/** Resolve {env:NAME} in every string; unset variables become "". */
function substitute(value: unknown, env: NodeJS.ProcessEnv): unknown {
  if (typeof value === "string") return value.replace(ENV_REFERENCE, (_, name: string) => env[name] ?? "");
  if (Array.isArray(value)) return value.map((item) => substitute(item, env));
  if (isPlain(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substitute(item, env)]));
  return value;
}

/** An empty string means "not set", so `"{env:UNSET}"` falls through to lower layers. */
function dropEmpty(value: Plain): Plain {
  const out: Plain = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === "") continue;
    out[key] = isPlain(item) ? dropEmpty(item) : item;
  }
  return out;
}

/** Remove what an untrusted project layer may not set, naming each removal. */
function restrict(value: Plain, label: string, notes: string[], prefix = ""): Plain {
  const out: Plain = {};
  for (const [key, item] of Object.entries(value)) {
    const name = prefix ? `${prefix}.${key}` : key;
    if (!prefix && RESTRICTED.has(key)) {
      notes.push(`${label}: ignored ${name} (an untrusted project cannot choose the endpoint or key; see ask /trust)`);
    } else if (typeof item === "string" && HAS_ENV_REFERENCE.test(item)) {
      notes.push(`${label}: ignored ${name} ({env:} is not resolved in an untrusted project; see ask /trust)`);
    } else {
      out[key] = isPlain(item) ? restrict(item, label, notes, name) : item;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Files

/** `$XDG_CONFIG_HOME/ask`, else `~/.config/ask`. A relative XDG value is
 * ignored, as the XDG spec requires, so the location never depends on the cwd.
 */
export function globalConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env["XDG_CONFIG_HOME"];
  return path.join(xdg && path.isAbsolute(xdg) ? xdg : path.join(homedir(), ".config"), "ask");
}

/** Like ssh, refuse a file that someone else could have written. */
async function unsafeReason(file: string): Promise<string | null> {
  const info = await stat(file);
  if (!info.isFile()) return "not a regular file";
  if (process.platform === "win32") return null;
  if (info.mode & 0o002) return "writable by every user (run chmod o-w on it)";
  const uid = process.getuid?.();
  if (uid !== undefined && info.uid !== uid && info.uid !== 0) return "owned by another user";
  return null;
}

async function exists(file: string): Promise<boolean> {
  return stat(file).then(() => true, () => false);
}

/** `name.json` or `name.jsonc` in `dir`; both at once is ambiguous. */
async function findFile(dir: string, name: string): Promise<string | null> {
  const json = path.join(dir, `${name}.json`);
  const jsonc = path.join(dir, `${name}.jsonc`);
  const [hasJson, hasJsonc] = await Promise.all([exists(json), exists(jsonc)]);
  if (hasJson && hasJsonc) throw new ConfigFileError(`both ${terminalField(json)} and ${terminalField(jsonc)} exist; keep one`);
  return hasJson ? json : hasJsonc ? jsonc : null;
}

interface FileLayer { readonly file: string; readonly data: Plain }

/** Read the config files in a directory as one layer's worth of data. */
async function readDirectory(dir: string, names: readonly ("ask" | "cli" | "tui")[], notes: string[]): Promise<FileLayer[]> {
  const layers: FileLayer[] = [];
  for (const entry of FILES.filter((candidate) => names.includes(candidate.name))) {
    const file = await findFile(dir, entry.name);
    if (!file) continue;
    const refused = await unsafeReason(file);
    if (refused) { notes.push(`not reading ${terminalField(file)}: ${refused}`); continue; }
    const parsed = parseJsonc(await readFile(file, "utf8"), file);
    if (entry.section === null && isPlain(parsed) && ("cli" in parsed || "tui" in parsed)) {
      throw new ConfigFileError(`${terminalField(file)}: put CLI and TUI settings in cli.json and tui.json`);
    }
    const data = validate(parsed, entry.shape, terminalField(file), notes);
    layers.push({ file, data: entry.section ? { [entry.section]: data } : data });
  }
  return layers;
}

/** The project root: the Git work tree containing `cwd`, or `cwd` itself. */
export async function projectRoot(cwd: string): Promise<string> {
  return (await gitRoot(cwd)) ?? cwd;
}

/** Project config files in a stable order: ./ask.json(c), then .ask/{ask,cli,tui}.json(c). */
async function projectFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const top = await findFile(root, "ask");
  if (top) files.push(top);
  for (const name of ["ask", "cli", "tui"]) {
    const file = await findFile(path.join(root, ".ask"), name);
    if (file) files.push(file);
  }
  return files;
}

// ---------------------------------------------------------------------------
// Saving a setting

interface Token { readonly kind: string; readonly start: number; readonly end: number }

/** Significant JSONC tokens with their positions; comments and whitespace are skipped. */
function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  for (let i = 0; i < text.length;) {
    const char = text[i]!;
    if (/\s/.test(char)) { i++; continue; }
    if (char === "/" && text[i + 1] === "/") { const end = text.indexOf("\n", i); i = end < 0 ? text.length : end; continue; }
    if (char === "/" && text[i + 1] === "*") { const end = text.indexOf("*/", i + 2); i = end < 0 ? text.length : end + 2; continue; }
    if (char === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      tokens.push({ kind: "string", start: i, end: j + 1 });
      i = j + 1;
      continue;
    }
    if ("{}[]:,".includes(char)) { tokens.push({ kind: char, start: i, end: i + 1 }); i++; continue; }
    let j = i;
    while (j < text.length && !/[\s,:[\]{}"/]/.test(text[j]!)) j++;
    tokens.push({ kind: "literal", start: i, end: Math.max(j, i + 1) });
    i = Math.max(j, i + 1);
  }
  return tokens;
}

/**
 * Set one top-level key in a JSON(C) object, changing only that value (or adding
 * it before the closing brace). Comments, formatting and other keys are kept.
 */
export function setTopLevelKey(text: string, key: string, value: unknown): string {
  const tokens = tokenize(text);
  if (tokens[0]?.kind !== "{") throw new ConfigFileError("the file must contain a JSON object");
  const encoded = JSON.stringify(value);
  let depth = 0;
  let replace: { start: number; end: number } | null = null;
  let close = -1;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.kind === "{" || token.kind === "[") depth++;
    else if (token.kind === "}" || token.kind === "]") {
      depth--;
      if (depth === 0) { close = i; break; }
    } else if (depth === 1 && token.kind === "string" && tokens[i + 1]?.kind === ":" &&
      JSON.parse(text.slice(token.start, token.end)) === key) {
      // The value runs to its matching bracket; the last duplicate wins, as in JSON.parse.
      const first = tokens[i + 2];
      if (!first) break;
      let end = first;
      if (first.kind === "{" || first.kind === "[") {
        let nested = 0;
        for (let j = i + 2; j < tokens.length; j++) {
          const kind = tokens[j]!.kind;
          if (kind === "{" || kind === "[") nested++;
          if (kind === "}" || kind === "]") nested--;
          if (nested === 0) { end = tokens[j]!; break; }
        }
      }
      replace = { start: first.start, end: end.end };
    }
  }
  if (close < 0) throw new ConfigFileError("the file's JSON object is not closed");
  let next: string;
  if (replace) {
    next = text.slice(0, replace.start) + encoded + text.slice(replace.end);
  } else {
    const last = tokens[close - 1]!;
    const firstKey = tokens.find((token, index) => index > 0 && token.kind === "string");
    const lineStart = firstKey ? text.lastIndexOf("\n", firstKey.start) + 1 : -1;
    const indent = firstKey && /^\s*$/.test(text.slice(lineStart, firstKey.start)) ? text.slice(lineStart, firstKey.start) : "  ";
    const entry = `${indent}${JSON.stringify(key)}: ${encoded}`;
    // A comma after the previous value if needed, then the new entry on its own
    // line before the closing brace, so trailing comments stay with their lines.
    const comma = last.kind === "{" || last.kind === "," ? "" : ",";
    const brace = tokens[close]!.start;
    const braceLine = text.lastIndexOf("\n", brace - 1) + 1;
    const ownLine = /^\s*$/.test(text.slice(braceLine, brace)) && braceLine > last.end;
    const at = ownLine ? braceLine : brace;
    next = text.slice(0, last.end) + comma + text.slice(last.end, at) +
      (ownLine ? `${entry}\n` : `\n${entry}\n`) + text.slice(at);
  }
  const parsed = parseJsonc(next, "edited file") as Plain;
  if (JSON.stringify(parsed[key]) !== encoded) throw new ConfigFileError("could not update the file safely");
  return next;
}

/** The URL editors use to check each file; ask itself ignores `$schema`. */
export function schemaUrl(name: "ask" | "cli" | "tui"): string {
  return `https://raw.githubusercontent.com/codehausau/ask/main/packages/ask/schema/${name}.schema.json`;
}

/**
 * Save one setting in the user's global config file (never a project or --config
 * file), creating it if needed. Returns the file written.
 */
export async function saveGlobalSetting(
  name: "ask" | "cli" | "tui", key: string, value: unknown, env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const kind = CONFIG_SHAPES[name][key];
  if (typeof kind !== "string") throw new ConfigFileError(`${key} is not a ${name}.json setting`);
  checkValue(kind, value, `${name}.json: ${key}`);
  const dir = globalConfigDir(env);
  const existing = await findFile(dir, name);
  const file = existing ?? path.join(dir, `${name}.json`);
  let text: string;
  let mode = 0o600;
  if (existing) {
    const refused = await unsafeReason(existing);
    if (refused) throw new ConfigFileError(`not writing ${terminalField(existing)}: ${refused}`);
    mode = (await stat(existing)).mode & 0o777;
    const current = await readFile(existing, "utf8");
    parseJsonc(current, existing);
    text = setTopLevelKey(current, key, value);
  } else {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    text = `{\n  "$schema": ${JSON.stringify(schemaUrl(name))},\n  ${JSON.stringify(key)}: ${JSON.stringify(value)}\n}\n`;
  }
  // Atomic: a crash mid-write never leaves a half-written config file.
  const temporary = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`);
  await writeFile(temporary, text, { mode });
  await rename(temporary, file);
  return file;
}

// ---------------------------------------------------------------------------
// Trust

interface TrustStore { version: 1; projects: Record<string, { hash: string; files: string[] }> }

export function trustFile(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(stateDir(env), "trust.json");
}

async function readTrust(env: NodeJS.ProcessEnv): Promise<TrustStore> {
  try {
    const parsed = JSON.parse(await readFile(trustFile(env), "utf8")) as TrustStore;
    if (parsed.version === 1 && isPlain(parsed.projects)) return parsed;
  } catch { /* missing or unreadable: nothing is trusted */ }
  return { version: 1, projects: {} };
}

/** Hash of every project config file's path and contents. */
async function hashFiles(root: string, files: readonly string[]): Promise<string> {
  const hash = createHash("sha256");
  for (const file of files) hash.update(`${path.relative(root, file)}\0${await readFile(file, "utf8")}\0`);
  return hash.digest("hex");
}

export interface TrustResult {
  readonly root: string;
  readonly files: readonly string[];
  /** Restricted settings those files set, which trust now allows. */
  readonly unlocks: readonly string[];
}

/** Record the project's current config files as trusted. */
export async function trustProject(cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<TrustResult> {
  const root = await realpath(await projectRoot(cwd));
  const files = await projectFiles(root);
  if (!files.length) throw new ConfigFileError(`no project config in ${terminalField(root)} (ask.json, ask.jsonc or .ask/)`);
  const unlocks: string[] = [];
  for (const file of files) {
    const notes: string[] = [];
    const name = path.basename(file).replace(/\.jsonc?$/, "") as "ask" | "cli" | "tui";
    const [layer] = await readDirectory(path.dirname(file), [name], notes);
    if (layer) restrict(layer.data, path.relative(root, file), unlocks);
  }
  const store = await readTrust(env);
  store.projects[root] = { hash: await hashFiles(root, files), files: files.map((file) => path.relative(root, file)) };
  await writeTrust(store, env);
  return { root, files, unlocks: unlocks.map((note) => note.replace(/ \(.*\)$/, "")) };
}

export async function untrustProject(cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const root = await realpath(await projectRoot(cwd));
  const store = await readTrust(env);
  if (!(root in store.projects)) return null;
  delete store.projects[root];
  await writeTrust(store, env);
  return root;
}

async function writeTrust(store: TrustStore, env: NodeJS.ProcessEnv): Promise<void> {
  const file = trustFile(env);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

// ---------------------------------------------------------------------------
// Loading

export interface LayerInfo {
  readonly label: string;
  readonly files: readonly string[];
  /** Project layers only: whether `ask /trust` covers the current files. */
  readonly trusted?: boolean;
}

/** One instruction file or glob, with where it came from. */
export interface InstructionEntry {
  /** Absolute path, or an absolute glob. */
  readonly pattern: string;
  /** The layer that listed it (or found AGENTS.md), for notes and --show-config. */
  readonly source: string;
  /** Untrusted project entries must stay inside this directory, after symlinks. */
  readonly within: string | null;
  /** An AGENTS.md found by convention, rather than listed in `instructions`. */
  readonly implicit: boolean;
}

export interface LoadedSettings {
  readonly settings: Settings;
  /** Setting path (e.g. "tui.theme") → the layer that supplied it. */
  readonly sources: ReadonlyMap<string, string>;
  readonly layers: readonly LayerInfo[];
  /** Ignored settings, refused files, unknown keys and the like. */
  readonly notes: readonly string[];
  readonly projectRoot: string;
  /** Instruction files in precedence order (lowest first), not yet read. */
  readonly instructions: readonly InstructionEntry[];
  /** Config directories, lowest precedence first (global, custom, project .ask/),
   * whether or not they exist; for files such as themes/. */
  readonly directories: readonly string[];
}

export interface LoadOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** --config <dir>; overrides $ASK_CONFIG. */
  readonly configDir?: string | undefined;
  /** Already-parsed flag values, in the shape of the whole configuration. */
  readonly flags?: Plain;
}

/** Parse a named variable's or flag's text into its setting's type. */
function settingValue(name: string, raw: string, kind: Kind): unknown {
  const invalid = (expected: string) => new ConfigFileError(`Invalid ${name}: must be ${expected}`);
  switch (kind) {
    case "string": return raw;
    case "stringArray": return [raw];
    case "updateView": return checkValue(kind, raw, name);
    case "boolean": return raw !== "0" && raw.toLowerCase() !== "false";
    case "positiveInteger": {
      const number = Number(raw);
      if (!raw.trim() || !Number.isSafeInteger(number) || number <= 0) throw invalid("a positive integer");
      return number;
    }
    case "nonNegativeNumber": {
      const number = Number(raw);
      if (!raw.trim() || !Number.isFinite(number) || number < 0) throw invalid("a number of at least 0");
      return number;
    }
    // As before: 0 (or off/false) disables, ascii forces ASCII frames, anything else is automatic.
    case "spinner": {
      const value = raw.trim().toLowerCase();
      return ["0", "off", "false"].includes(value) ? "off" : value === "ascii" ? "ascii" : "auto";
    }
    case "temperature": {
      const number = Number(raw);
      if (!raw.trim() || !Number.isFinite(number) || number < 0 || number > 2) throw invalid("a number from 0 to 2");
      return number;
    }
    case "timeout": {
      const number = Number(raw);
      try { timeoutSecondsToMs(number); } catch { throw invalid("positive seconds (at least 0.001, at most 2147483.647)"); }
      if (!raw.trim()) throw invalid("positive seconds");
      return number;
    }
  }
}

/** The flags layer from `[--flag, raw value, setting path]` entries; unset flags are skipped. */
export function flagLayer(entries: readonly (readonly [string, string | undefined, readonly string[]])[]): Plain {
  const layer: Plain = {};
  for (const [flag, raw, segments] of entries) {
    if (raw !== undefined) setPath(layer, segments, settingValue(flag, raw, kindAt(segments)));
  }
  return layer;
}

function kindAt(segments: readonly string[]): Kind {
  let shape: Kind | Shape = ALL;
  for (const segment of segments) shape = (shape as Shape)[segment]!;
  return shape as Kind;
}

function setPath(target: Plain, segments: readonly string[], value: unknown): void {
  let node = target;
  for (const segment of segments.slice(0, -1)) node = (node[segment] ??= {}) as Plain;
  node[segments.at(-1)!] = value;
}

/** Hybrid merge: objects by key, scalars replaced, arrays joined without duplicates, null removes. */
function merge(target: Plain, layer: Plain, label: string, sources: Map<string, string>, prefix = ""): void {
  for (const [key, value] of Object.entries(layer)) {
    const name = prefix ? `${prefix}.${key}` : key;
    if (value === null) {
      delete target[key];
      for (const source of [...sources.keys()]) if (source === name || source.startsWith(`${name}.`)) sources.delete(source);
    } else if (isPlain(value)) {
      if (!isPlain(target[key])) target[key] = {};
      merge(target[key] as Plain, value, label, sources, name);
    } else if (Array.isArray(value)) {
      const previous = Array.isArray(target[key]) ? target[key] as unknown[] : [];
      const seen = new Set(previous.map((item) => JSON.stringify(item)));
      target[key] = [...previous, ...value.filter((item) => !seen.has(JSON.stringify(item)) && seen.add(JSON.stringify(item)))];
      sources.set(name, previous.length ? `${sources.get(name)} + ${label}` : label);
    } else {
      target[key] = value;
      sources.set(name, label);
    }
  }
}

/**
 * A layer that points the endpoint somewhere new without giving a key must not
 * inherit a lower layer's key: that key belongs to the other endpoint.
 */
function pairEndpoint(target: Plain, layer: Plain, label: string, sources: Map<string, string>, notes: string[]): void {
  const next = isPlain(layer["endpoint"]) ? layer["endpoint"] : null;
  const current = isPlain(target["endpoint"]) ? target["endpoint"] : null;
  if (!next || !Object.hasOwn(next, "url") || !current) return;
  // null removes the URL, returning to the SDK's default destination. That is
  // still an endpoint change and must not carry another provider's credentials.
  const destination = (url: unknown) => url ?? "https://api.openai.com/v1";
  if (destination(next["url"]) === destination(current["url"])) return;
  for (const key of ["apiKey", "organization", "project"]) {
    if (next[key] !== undefined || current[key] === undefined) continue;
    notes.push(`${label} changes endpoint.url, so endpoint.${key} from ${sources.get(`endpoint.${key}`)} is not used; set endpoint.${key} in the same place`);
    delete current[key];
    sources.delete(`endpoint.${key}`);
  }
}

/** Load and merge every layer. Throws ConfigFileError for invalid files or values. */
export async function loadSettings(options: LoadOptions = {}): Promise<LoadedSettings> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const notes: string[] = [];
  const instructions: InstructionEntry[] = [];
  /** A directory's AGENTS.md, by convention. Missing is fine. */
  const agents = async (dir: string, source: string, within: string | null) => {
    const file = path.join(dir, "AGENTS.md");
    if (await exists(file)) instructions.push({ pattern: file, source, within, implicit: true });
  };
  /**
   * Resolve a layer's `instructions` against its own directory, record them, and
   * rewrite them as absolute paths so --show-config shows what will be read.
   * An untrusted project may only name relative paths inside the project.
   */
  const listInstructions = (data: Plain, base: string, source: string, within: string | null): Plain => {
    const listed = data["instructions"];
    if (listed === null) {
      // null clears earlier `instructions`; conventional AGENTS.md files stay.
      for (let i = instructions.length - 1; i >= 0; i--) if (!instructions[i]!.implicit) instructions.splice(i, 1);
      return data;
    }
    if (!Array.isArray(listed)) return data;
    const resolved: string[] = [];
    for (const entry of listed as string[]) {
      if (!entry) continue;
      const home = entry === "~" || entry.startsWith("~/");
      if (within && (home || path.isAbsolute(entry))) {
        notes.push(`${source}: ignored instruction ${terminalField(entry)} (an untrusted project may only name files inside it)`);
        continue;
      }
      const absolute = home ? path.join(homedir(), entry.slice(2)) : path.resolve(base, entry);
      const relative = within ? path.relative(within, absolute) : "";
      if (within && (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))) {
        notes.push(`${source}: ignored instruction ${terminalField(entry)} (outside the project)`);
        continue;
      }
      if (!instructions.some((item) => item.pattern === absolute)) instructions.push({ pattern: absolute, source, within, implicit: false });
      resolved.push(absolute);
    }
    return { ...data, instructions: resolved };
  };
  const layers: LayerInfo[] = [];
  const merged: Plain = {};
  const sources = new Map<string, string>();
  const apply = (label: string, data: Plain, files: readonly string[], info: Partial<LayerInfo> = {}) => {
    const clean = dropEmpty(data);
    pairEndpoint(merged, clean, label, sources, notes);
    merge(merged, clean, label, sources);
    layers.push({ label, files, ...info });
  };

  // OPENAI_* are other tools' conventions too, so they are only defaults.
  apply("environment default", dropEmpty(substitute({
    endpoint: { url: "{env:OPENAI_BASE_URL}", apiKey: "{env:OPENAI_API_KEY}", organization: "{env:OPENAI_ORG_ID}", project: "{env:OPENAI_PROJECT_ID}" },
  }, env) as Plain), []);

  const global = globalConfigDir(env);
  await agents(global, "global AGENTS.md", null);
  for (const layer of await readDirectory(global, ["ask", "cli", "tui"], notes)) {
    const label = `global ${path.basename(layer.file)}`;
    apply(label, listInstructions(substitute(layer.data, env) as Plain, global, label, null), [layer.file]);
  }

  const directories = [global];
  const custom = options.configDir ?? env["ASK_CONFIG"];
  if (custom) {
    const dir = path.resolve(cwd, custom);
    directories.push(dir);
    if (!await stat(dir).then((info) => info.isDirectory(), () => false)) {
      throw new ConfigFileError(`${options.configDir ? "--config" : "ASK_CONFIG"} ${terminalField(dir)} is not a directory`);
    }
    await agents(dir, "custom AGENTS.md", null);
    for (const layer of await readDirectory(dir, ["ask", "cli", "tui"], notes)) {
      const label = `custom ${path.basename(layer.file)}`;
      apply(label, listInstructions(substitute(layer.data, env) as Plain, dir, label, null), [layer.file]);
    }
  }

  const root = await realpath(await projectRoot(cwd)).catch(() => path.resolve(cwd));
  const files = await projectFiles(root);
  let trusted = false;
  if (files.length) {
    const recorded = (await readTrust(env)).projects[root];
    trusted = recorded !== undefined && recorded.hash === await hashFiles(root, files);
    if (recorded && !trusted) notes.push(`project config in ${terminalField(root)} changed since it was trusted; run ask /trust again to allow its endpoint and {env:} settings`);
  }
  // Project instructions are the repository's content: read them, but keep an
  // untrusted project's files inside it.
  const within = trusted ? null : root;
  directories.push(path.join(root, ".ask"));
  await agents(root, "project AGENTS.md", within);
  let dotAskAgents = false;
  for (const file of files) {
    const name = path.basename(file).replace(/\.jsonc?$/, "") as "ask" | "cli" | "tui";
    const inDotAsk = path.dirname(file) !== root;
    if (inDotAsk && !dotAskAgents) { dotAskAgents = true; await agents(path.dirname(file), "project .ask/AGENTS.md", within); }
    const [layer] = await readDirectory(path.dirname(file), [name], notes);
    if (!layer) continue;
    const label = `project ${path.relative(root, file)}`;
    const data = trusted ? substitute(layer.data, env) as Plain : restrict(layer.data, label, notes);
    apply(label, listInstructions(data, path.dirname(file), label, within), [file], { trusted });
  }
  if (!dotAskAgents) await agents(path.join(root, ".ask"), "project .ask/AGENTS.md", within);

  const inline = env["ASK_CONFIG_CONTENT"];
  if (inline?.trim()) {
    const data = substitute(validate(parseJsonc(inline, "ASK_CONFIG_CONTENT"), ALL, "ASK_CONFIG_CONTENT", notes), env) as Plain;
    apply("ASK_CONFIG_CONTENT", listInstructions(data, cwd, "ASK_CONFIG_CONTENT", null), []);
  }

  // One layer per named variable, so --show-config can name each one.
  for (const { name, path: segments } of NAMED_VARIABLES) {
    const raw = env[name];
    if (raw === undefined) continue;
    const single: Plain = {};
    setPath(single, segments, settingValue(name, raw, kindAt(segments)));
    apply(`env ${name}`, single, []);
  }

  if (options.flags) {
    const flags = dropEmpty(validate(options.flags, ALL, "flags", notes));
    // Explicit on the command line: a flag URL keeps the effective key.
    merge(merged, flags, "flag", sources);
    layers.push({ label: "flags", files: [] });
  }

  return {
    settings: {
      ...merged,
      endpoint: (merged["endpoint"] ?? {}) as EndpointSettings,
      cli: (merged["cli"] ?? {}) as Settings["cli"],
      tui: (merged["tui"] ?? {}) as Settings["tui"],
    } as Settings,
    sources, layers, notes, projectRoot: root, instructions, directories,
  };
}

/** Human-readable layers, settings and their sources. API keys are never shown. */
export function describeSettings(loaded: LoadedSettings): string {
  const lines = ["Config layers (lowest precedence first):"];
  for (const layer of loaded.layers) {
    const trust = layer.trusted === undefined ? "" : layer.trusted ? " (trusted)" : " (untrusted: endpoint and {env:} ignored)";
    lines.push(`  ${terminalField(layer.label)}${trust}${layer.files.length ? `: ${layer.files.map(terminalField).join(", ")}` : ""}`);
  }
  lines.push("", "Settings:");
  const walk = (value: Plain, prefix: string) => {
    for (const [key, item] of Object.entries(value)) {
      const name = prefix ? `${prefix}.${key}` : key;
      if (isPlain(item)) { walk(item, name); continue; }
      const shown = name === "endpoint.apiKey" ? "(set)" : JSON.stringify(item);
      lines.push(`  ${name} = ${terminalField(shown)}  (${terminalField(loaded.sources.get(name) ?? "default")})`);
    }
  };
  walk(loaded.settings as unknown as Plain, "");
  if (loaded.instructions.length) {
    lines.push("", "Instruction files (in order):");
    for (const entry of loaded.instructions) {
      lines.push(`  ${terminalField(entry.pattern)}  (${terminalField(entry.source)}${entry.within ? ", kept inside the project" : ""})`);
    }
  }
  if (loaded.notes.length) lines.push("", "Notes:", ...loaded.notes.map((note) => `  ${note}`));
  return lines.join("\n");
}
