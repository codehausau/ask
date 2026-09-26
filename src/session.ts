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
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
  readonly answer: string;
  /** Set when this turn is a `/compact` summary standing in for earlier ones. */
  readonly summary?: boolean;
  /** How many turns the summary replaced. */
  readonly covers?: number;
}

export interface Session {
  readonly version: number;
  readonly name: string;
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
  readonly answer: string;
  readonly now?: Date;
}

/** Append a turn, creating the session when this is the first one. */
export function appendTurn(session: Session | null, options: AppendOptions): Session {
  const timestamp = (options.now ?? new Date()).toISOString();
  const turn: SessionTurn = {
    at: timestamp,
    question: options.question,
    refs: [...options.refs],
    answer: options.answer,
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
