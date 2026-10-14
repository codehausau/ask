// Session store: implicit multi-turn context, one JSON file per scope.
//
// Deliberately NOT an agent loop — each invocation still sends exactly one
// request. A session only decides what goes *into* that single request.
//
// Design notes:
//   * Turns record the question, the `@refs` as typed, and the answer — never
//     file contents. File blocks are re-read from disk on every turn, so a
//     follow-up after an edit sees current code and a file is sent once per
//     request rather than once per turn.
//   * Scoped to the git repo root, so each project has its own thread.
//   * Stored 0600 under $XDG_STATE_HOME/ask, outside any repo, so a session can
//     never be attached to a later prompt.

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { gitRoot } from "./git.ts";

export const SESSION_VERSION = 1;
/** Idle time after which an implicit session starts fresh. */
export const DEFAULT_SESSION_TTL_MS = 2 * 60 * 60 * 1000;
/** Token budget for history + current context before oldest turns are dropped. */
export const DEFAULT_SESSION_MAX_TOKENS = 32_000;
export const DEFAULT_SESSION_NAME = "default";

export interface SessionTurn {
  /** ISO timestamp of the answer. */
  readonly at: string;
  readonly question: string;
  /** References as typed, re-resolved on later turns. */
  readonly refs: readonly string[];
  /** Skill names in effect, re-read from disk on later turns. */
  readonly skills?: readonly string[];
  readonly answer: string;
  /** Set when this turn is a `/compact` summary standing in for earlier ones. */
  readonly summary?: boolean;
  /** How many turns the summary replaced. */
  readonly covers?: number;
  /** Tokens the endpoint actually billed for this turn, when it reported them. */
  readonly usage?: { readonly input: number | null; readonly output: number | null };
}

export interface Session {
  readonly version: number;
  readonly name: string;
  /** For an archived thread, the name it was filed away from. */
  readonly archivedFrom?: string;
  readonly archivedAt?: string;
  /** Absolute directory the session belongs to (git root, or cwd). */
  readonly scope: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly turns: readonly SessionTurn[];
}

export interface SessionKey {
  readonly scope: string;
  readonly name: string;
  readonly env?: NodeJS.ProcessEnv;
}

export interface ChatMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
}

/** Rough token estimate, the same heuristic --show-context reports. */
export function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 4);
}

/** Where session files live. `ASK_STATE_DIR` wins, then XDG, then ~/.local. */
export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env["ASK_STATE_DIR"];
  if (explicit) return path.resolve(explicit);

  const xdg = env["XDG_STATE_HOME"];
  if (xdg) return path.join(path.resolve(xdg), "ask");

  return path.join(homedir(), ".local", "state", "ask");
}

export function sessionPath({ scope, name, env }: SessionKey): string {
  const digest = createHash("sha256").update(`${scope}\0${name}`).digest("hex").slice(0, 16);
  return path.join(stateDir(env), "sessions", `${digest}.json`);
}

/** A session belongs to its repository, falling back to the directory. */
export async function sessionScope(cwd: string): Promise<string> {
  return (await gitRoot(cwd)) ?? cwd;
}

/** Human-facing label: the explicit name, or the scope's directory name. */
export function sessionLabel(session: Pick<Session, "name" | "scope">): string {
  return session.name === DEFAULT_SESSION_NAME ? path.basename(session.scope) : session.name;
}

function isSession(value: unknown): value is Session {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<Session>;
  return (
    candidate.version === SESSION_VERSION &&
    typeof candidate.name === "string" &&
    typeof candidate.scope === "string" &&
    typeof candidate.updatedAt === "string" &&
    Array.isArray(candidate.turns)
  );
}

/**
 * Load a session, or null when absent, unreadable, corrupt, a different schema
 * version, or idle for longer than `ttlMs`. Never throws: a broken session file
 * should start a new thread, not break the CLI.
 */
export async function loadSession(
  key: SessionKey,
  ttlMs: number = DEFAULT_SESSION_TTL_MS,
  now: number = Date.now(),
): Promise<Session | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(sessionPath(key), "utf8"));
  } catch {
    return null;
  }
  if (!isSession(parsed)) return null;

  const updated = Date.parse(parsed.updatedAt);
  if (!Number.isFinite(updated)) return null;
  if (ttlMs > 0 && now - updated > ttlMs) return null;

  return parsed;
}

export async function saveSession(
  session: Session,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const file = sessionPath({ scope: session.scope, name: session.name, env });
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  // Questions and answers quote your source: owner-only.
  await writeFile(file, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
  return file;
}

/** Where the pre-compaction copy is kept, since compaction is lossy. */
export function sessionBackupPath(key: SessionKey): string {
  return sessionPath(key).replace(/\.json$/, ".pre-compact.json");
}

/** Snapshot a session before a lossy operation. Returns the backup path. */
export async function backupSession(
  session: Session,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const file = sessionBackupPath({ scope: session.scope, name: session.name, env });
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
  return file;
}

/** Delete a session and any pre-compaction copy. True if one existed. */
export async function resetSession(key: SessionKey): Promise<boolean> {
  const file = sessionPath(key);
  let existed = true;
  try {
    await readFile(file);
  } catch {
    existed = false;
  }
  await rm(file, { force: true });
  await rm(sessionBackupPath(key), { force: true });
  return existed;
}

/** Skill names from every turn, in order of first appearance, deduplicated. */
export function sessionSkills(session: Session | null): string[] {
  const seen = new Set<string>();
  for (const turn of session?.turns ?? []) {
    for (const name of turn.skills ?? []) seen.add(name);
  }
  return [...seen];
}

/** References from every turn, in order of first appearance, deduplicated. */
export function sessionRefs(session: Session | null): string[] {
  const seen = new Set<string>();
  for (const turn of session?.turns ?? []) {
    for (const ref of turn.refs) seen.add(ref);
  }
  return [...seen];
}

/**
 * History as chat messages: questions and answers only. Current file contents
 * ride along with the new user message, so nothing here can go stale.
 */
export function sessionMessages(session: Session | null): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (const turn of session?.turns ?? []) {
    if (turn.summary) {
      // A summary replaces a run of turns, so it is stated rather than
      // role-played as a question and an answer that never happened.
      messages.push({
        role: "user",
        content: `<conversation-summary>\n${turn.answer}\n</conversation-summary>`,
      });
      continue;
    }
    messages.push({ role: "user", content: turn.question });
    messages.push({ role: "assistant", content: turn.answer });
  }
  return messages;
}

/** System prompt for `/compact`. Terse, factual, no invention. */
export const COMPACT_SYSTEM =
  "You compact a developer's question-and-answer thread about a codebase into " +
  "notes that let the conversation continue with less context. Preserve: " +
  "decisions and conclusions reached, file paths and identifiers discussed, " +
  "constraints and requirements stated, corrections the user made, and any " +
  "unresolved questions. Drop pleasantries, restatements, and anything the " +
  "files themselves already say. Use short bullet points. Invent nothing; if " +
  "something was inconclusive, say so.";

/** The transcript handed to the model for compaction. */
export function buildCompactionPrompt(session: Session): string {
  const parts: string[] = [];
  for (const turn of session.turns) {
    if (turn.summary) {
      parts.push(`<earlier-summary>\n${turn.answer}\n</earlier-summary>`);
      continue;
    }
    const refs = turn.refs.length > 0 ? ` (files: ${turn.refs.join(", ")})` : "";
    parts.push(`<turn>\n<question${refs ? ` note="${refs.trim()}"` : ""}>${turn.question}</question>\n<answer>${turn.answer}</answer>\n</turn>`);
  }
  return `${parts.join("\n\n")}\n\nCompact the thread above into continuation notes.`;
}

/**
 * Replace the thread with a single summary turn, keeping every attached ref so
 * files stay in context. Lossy by design, hence the explicit verb.
 */
export function applyCompaction(
  session: Session,
  summary: string,
  now: Date = new Date(),
): Session {
  const timestamp = now.toISOString();
  return {
    ...session,
    updatedAt: timestamp,
    turns: [
      {
        at: timestamp,
        question: `(compacted ${session.turns.length} turn(s))`,
        refs: sessionRefs(session),
        ...(sessionSkills(session).length > 0 ? { skills: sessionSkills(session) } : {}),
        answer: summary,
        summary: true,
        covers: session.turns.reduce((total, turn) => total + (turn.covers ?? 1), 0),
      },
    ],
  };
}

/** Estimated tokens the history contributes to each request. */
export function sessionTokens(session: Session | null): number {
  return sessionMessages(session).reduce(
    (total, message) => total + estimateTokens(message.content),
    0,
  );
}

export interface PruneResult {
  readonly session: Session;
  /** Turns dropped from the front, oldest first. */
  readonly dropped: number;
}

/**
 * Drop oldest turns until history plus the current turn fits the budget.
 * Reported to the caller so pruning can be announced rather than silent.
 */
export function pruneSession(
  session: Session,
  maxTokens: number = DEFAULT_SESSION_MAX_TOKENS,
  currentTokens = 0,
): PruneResult {
  const turns = [...session.turns];
  let dropped = 0;

  const historyTokens = (): number =>
    turns.reduce(
      (total, turn) => total + estimateTokens(turn.question) + estimateTokens(turn.answer),
      0,
    );

  while (turns.length > 0 && currentTokens + historyTokens() > maxTokens) {
    turns.shift();
    dropped += 1;
  }

  return { session: { ...session, turns }, dropped };
}

export interface AppendOptions {
  readonly scope: string;
  readonly name: string;
  readonly question: string;
  readonly refs: readonly string[];
  readonly skills?: readonly string[];
  readonly answer: string;
  readonly usage?: { readonly input: number | null; readonly output: number | null };
  readonly now?: Date;
}

/** Append a turn, creating the session when this is the first one. */
export function appendTurn(session: Session | null, options: AppendOptions): Session {
  const timestamp = (options.now ?? new Date()).toISOString();
  const turn: SessionTurn = {
    at: timestamp,
    question: options.question,
    refs: [...options.refs],
    ...(options.skills && options.skills.length > 0 ? { skills: [...options.skills] } : {}),
    answer: options.answer,
    ...(options.usage ? { usage: options.usage } : {}),
  };

  return {
    version: SESSION_VERSION,
    name: options.name,
    scope: options.scope,
    createdAt: session?.createdAt ?? timestamp,
    updatedAt: timestamp,
    turns: [...(session?.turns ?? []), turn],
  };
}

export interface SessionUsage {
  /** Tokens billed across the thread, as reported by the endpoint. */
  readonly input: number;
  readonly output: number;
  /** Turns that reported usage, so partial data is not mistaken for a total. */
  readonly reported: number;
  readonly turns: number;
}

/** Cumulative billed usage for a thread. */
export function sessionUsage(session: Session | null): SessionUsage {
  let input = 0;
  let output = 0;
  let reported = 0;

  for (const turn of session?.turns ?? []) {
    if (!turn.usage) continue;
    reported += 1;
    input += turn.usage.input ?? 0;
    output += turn.usage.output ?? 0;
  }
  return { input, output, reported, turns: session?.turns.length ?? 0 };
}

/** Thread names must be safe as a single filename component and easy to type. */
const VALID_NAME = /^[A-Za-z0-9._-]{1,64}$/;

export function isValidSessionName(name: string): boolean {
  return VALID_NAME.test(name) && name !== "." && name !== "..";
}

/** Pointer file recording which thread a scope is currently on. */
export function currentPointerPath(scope: string, env: NodeJS.ProcessEnv = process.env): string {
  const digest = createHash("sha256").update(scope).digest("hex").slice(0, 16);
  return path.join(stateDir(env), "current", `${digest}.txt`);
}

/** The thread this scope was switched to, or null if never switched. */
export async function readCurrentSession(
  scope: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  try {
    const name = (await readFile(currentPointerPath(scope, env), "utf8")).trim();
    return isValidSessionName(name) ? name : null;
  } catch {
    return null;
  }
}

export async function writeCurrentSession(
  scope: string,
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (!isValidSessionName(name)) {
    throw new Error(`invalid thread name "${name}": use letters, digits, dot, dash, underscore`);
  }
  const file = currentPointerPath(scope, env);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `${name}\n`, { mode: 0o600 });
}

export async function clearCurrentSession(
  scope: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await rm(currentPointerPath(scope, env), { force: true });
}

/**
 * Which thread to use, in order: the --session flag, then ASK_SESSION, then the
 * switched-to thread for this scope, then "default".
 */
export async function resolveSessionName(
  scope: string,
  flagValue: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  if (flagValue !== undefined) return flagValue;

  const fromEnv = env["ASK_SESSION"];
  // "0" is the disable switch, not a thread name.
  if (fromEnv !== undefined && fromEnv !== "0" && isValidSessionName(fromEnv)) return fromEnv;

  return (await readCurrentSession(scope, env)) ?? DEFAULT_SESSION_NAME;
}

export interface SessionSummary {
  readonly name: string;
  /** Set when this is an archived thread rather than a live one. */
  readonly archivedFrom?: string;
  readonly turns: number;
  readonly updatedAt: string;
  readonly historyTokens: number;
  readonly file: string;
}

/**
 * Every thread belonging to `scope`. Files are named by hash, so the directory
 * is scanned and each thread's own record of its scope is what filters — no
 * separate index to fall out of step.
 */
export async function listSessions(
  scope: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SessionSummary[]> {
  const dir = path.join(stateDir(env), "sessions");
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const summaries: SessionSummary[] = [];
  for (const entry of entries) {
    // Skip pre-compaction snapshots: they are backups, not threads.
    if (!entry.endsWith(".json") || entry.endsWith(".pre-compact.json")) continue;

    const file = path.join(dir, entry);
    try {
      const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
      if (!isSession(parsed) || parsed.scope !== scope) continue;
      summaries.push({
        name: parsed.name,
        ...(parsed.archivedFrom !== undefined ? { archivedFrom: parsed.archivedFrom } : {}),
        turns: parsed.turns.length,
        updatedAt: parsed.updatedAt,
        historyTokens: sessionTokens(parsed),
        file,
      });
    } catch {
      // Unreadable or foreign file: not a thread of ours.
    }
  }

  // Most recently used first.
  return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Archived threads kept per name before the oldest are removed. */
export const KEEP_ARCHIVES = 10;

/** Timestamp suffix for an archived thread: 20260928-1032. */
export function archiveSuffix(now: Date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}`
  );
}

/**
 * File the current thread away under a timestamped name and clear the slot, so
 * `/new` keeps history instead of destroying it. Returns the archived name, or
 * null when there was nothing worth keeping.
 */
export async function archiveSession(
  session: Session,
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
): Promise<string | null> {
  if (session.turns.length === 0) return null;

  // A second archive in the same minute gets a counter rather than clobbering.
  const base = `${session.name}-${archiveSuffix(now)}`;
  let name = base;
  for (let attempt = 2; attempt <= 60; attempt += 1) {
    const taken = await readFile(sessionPath({ scope: session.scope, name, env })).then(
      () => true,
      () => false,
    );
    if (!taken) break;
    name = `${base}-${attempt}`;
  }

  const archived: Session = { ...session, name, archivedFrom: session.name, archivedAt: now.toISOString() };
  await saveSession(archived, env);
  await resetSession({ scope: session.scope, name: session.name, env });
  await pruneArchives(session.scope, session.name, KEEP_ARCHIVES, env);
  return name;
}

/** Remove the oldest archives of `name` beyond `keep`. Returns how many went. */
export async function pruneArchives(
  scope: string,
  name: string,
  keep: number = KEEP_ARCHIVES,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const archives = (await listSessions(scope, env)).filter(
    (summary) => summary.archivedFrom === name,
  );
  if (archives.length <= keep) return 0;

  // listSessions is newest first, so the tail is what to drop.
  const doomed = archives.slice(keep);
  for (const summary of doomed) {
    await rm(summary.file, { force: true });
  }
  return doomed.length;
}
