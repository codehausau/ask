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

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { gitRoot } from "./git.ts";

export const SESSION_VERSION = 2;
/** Idle time after which an implicit session starts fresh. */
export const DEFAULT_SESSION_TTL_MS = 2 * 60 * 60 * 1000;
/** Token budget for history + current context before oldest turns are dropped. */
export const DEFAULT_SESSION_MAX_TOKENS = 32_000;
export const DEFAULT_SESSION_NAME = "default";

export interface SessionTurn {
  /** ISO timestamp of the answer. */
  readonly at: string;
  readonly question: string;
  /** Original editable prompt, when distinct from question text sent as history. */
  readonly prompt?: string;
  readonly decisions?: readonly string[];
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

export interface ThreadSelection {
  readonly refs: readonly string[];
  readonly excluded: readonly string[];
  /** A legacy CLI session only recorded the skill name. */
  readonly skills: readonly { readonly name: string; readonly file: string | null }[];
}

/** Keep repository paths portable across invocations from sibling directories. */
export function scopedPath(scope: string, file: string): string {
  const relative = path.relative(scope, file);
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) ? file : relative || ".";
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
  /** Composer recall only. A failed submission has no answer and is never a model turn. */
  readonly failedPrompts?: readonly { readonly afterTurns: number; readonly text: string }[];
  /** Context retained independently of conversation turns by /clear. */
  readonly context?: { readonly refs: readonly string[]; readonly skills: readonly string[] };
  readonly selection?: ThreadSelection;
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
  return path.join(stateDir(env), "sessions-v2", `${digest}.json`);
}

function legacyPath(key: SessionKey): string {
  return path.join(stateDir(key.env), "sessions", path.basename(sessionPath(key)));
}

export function emptySession(scope: string, name: string): Session {
  const at = new Date().toISOString();
  return { scope, name, version: SESSION_VERSION, createdAt: at, updatedAt: at, turns: [] };
}

/** A session belongs to its repository, falling back to the directory. */
export async function sessionScope(cwd: string): Promise<string> {
  return (await gitRoot(cwd)) ?? cwd;
}

/** Human-facing label: the explicit name, or the scope's directory name. */
export function sessionLabel(session: Pick<Session, "name" | "scope">): string {
  return session.name === DEFAULT_SESSION_NAME ? path.basename(session.scope) : session.name;
}

function isTurn(turn: SessionTurn): boolean {
  return !!turn && typeof turn.at === "string" && typeof turn.question === "string" && typeof turn.answer === "string"
    && strings(turn.refs) && (turn.skills === undefined || strings(turn.skills))
    && (turn.prompt === undefined || typeof turn.prompt === "string")
    && (turn.decisions === undefined || strings(turn.decisions))
    && (turn.summary === undefined || typeof turn.summary === "boolean")
    && (turn.covers === undefined || count(turn.covers))
    && (turn.usage === undefined || (!!turn.usage && [turn.usage.input, turn.usage.output].every(n => n === null || count(n))));
}

function isSelection(selection: ThreadSelection): boolean {
  return !!selection && strings(selection.refs) && strings(selection.excluded) && Array.isArray(selection.skills)
    && selection.skills.every(skill => skill && typeof skill.name === "string" && (skill.file === null || typeof skill.file === "string"));
}

function isSession(value: unknown): value is Session {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<Session>;
  return (
    (candidate.version === 1 || candidate.version === SESSION_VERSION) &&
    typeof candidate.name === "string" &&
    typeof candidate.scope === "string" &&
    typeof candidate.createdAt === "string" && typeof candidate.updatedAt === "string" && Number.isFinite(Date.parse(candidate.updatedAt)) &&
    Array.isArray(candidate.turns) && candidate.turns.every(isTurn) &&
    (candidate.failedPrompts === undefined || (Array.isArray(candidate.failedPrompts) &&
      candidate.failedPrompts.every((p, i, all) => p && typeof p.text === "string" && count(p.afterTurns) &&
        p.afterTurns <= candidate.turns!.length && (i === 0 || all[i - 1]!.afterTurns <= p.afterTurns)))) &&
    (candidate.selection === undefined || isSelection(candidate.selection)) &&
    (candidate.context === undefined || (!!candidate.context && strings(candidate.context.refs) && strings(candidate.context.skills)))
  );
}

function count(value: unknown): boolean { return Number.isSafeInteger(value) && Number(value) >= 0; }
function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(s => typeof s === "string");
}

export interface ThreadRecord { session: Session | null; revision: string | null }
function digest(text: string): string { return createHash("sha256").update(text).digest("hex"); }
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === "ENOENT"; }

async function optionalText(file: string): Promise<string | null> {
  try { return await readFile(file, "utf8"); } catch (error) { if (!missing(error)) throw error; return null; }
}

function decodeRecord(raw: string, key: SessionKey, version?: number): Session {
  let record: unknown;
  try { record = JSON.parse(raw); } catch { /* handled below */ }
  if (!isSession(record) || (version !== undefined && record.version !== version) || record.scope !== key.scope || record.name !== key.name) {
    throw new Error(`Cannot open thread ${JSON.stringify(key.name)}: invalid or unsupported session record.`);
  }
  return record;
}

/** Only absence means "new". Never fall through from a broken v2 file to stale v1 data. */
export async function readThread(key: SessionKey): Promise<ThreadRecord> {
  for (const [file, version] of [[sessionPath(key), 2], [legacyPath(key), 1]] as const) {
    const raw = await optionalText(file);
    if (raw !== null) return { session: decodeRecord(raw, key, version), revision: digest(raw) };
  }
  return { session: null, revision: null };
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
  let parsed: Session | null;
  try {
    parsed = (await readThread(key)).session;
  } catch {
    return null;
  }
  if (!parsed) return null;

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
  const key = { scope: session.scope, name: session.name, env };
  await commitThread(key, session, (await readThread(key)).revision);
  return file;
}

async function atomicWrite(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, { mode: 0o600, flag: "wx" });
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}

async function lockFile<T>(file: string, label: string, action: () => Promise<T>): Promise<T> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const lock = `${file}.lock`;
  try { await mkdir(lock, { mode: 0o700 }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    throw new Error(`${label} is locked. Retry after the other writer finishes. Lock: ${lock}`);
  }
  try { return await action(); } finally { await rm(lock, { recursive: true }); }
}

function locked<T>(key: SessionKey, action: () => Promise<T>): Promise<T> {
  return lockFile(sessionPath(key), `Thread ${JSON.stringify(key.name)}`, action);
}

function checkRevision(current: ThreadRecord, expected: string | null): void {
  if (current.revision !== expected) throw new Error("Thread changed in another process; reopen it before saving.");
}

/** Compare under the lock, never across a model request. */
export async function commitThread(key: SessionKey, session: Session, expected: string | null,
  operation?: "compact" | "clear" | "select"): Promise<string> {
  return locked(key, async () => {
    const current = await readThread(key);
    checkRevision(current, expected);
    const record = { ...session, version: SESSION_VERSION };
    if (!isSession(record) || record.scope !== key.scope || record.name !== key.name) throw new Error("Invalid thread record.");
    if (operation === "compact" && current.session) await backupSession(current.session, key.env);
    const raw = JSON.stringify(record, null, 2) + "\n";
    await atomicWrite(sessionPath(key), raw);
    if (operation === "clear") {
      await rm(legacyPath(key), { force: true });
      await removeBackups(key);
    }
    if (operation === "select") {
      // Keep the thread lock through selection: a concurrent rename must not
      // retire this name between the record write and the pointer write.
      try { await writeCurrentSession(key.scope, key.name, key.env); }
      catch (error) { throw new Error(`Thread ${key.name} was saved, but could not be selected: ${String(error)}`); }
    }
    return digest(raw);
  });
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
  await atomicWrite(file, `${JSON.stringify(session, null, 2)}\n`);
  return file;
}

/** Delete a session and any pre-compaction copy. True if one existed. */
async function removeBackups(key: SessionKey): Promise<void> {
  await rm(legacyPath(key).replace(/\.json$/, ".pre-compact.json"), { force: true });
  await rm(sessionBackupPath(key), { force: true });
}

async function removeThreadFiles(key: SessionKey, version = SESSION_VERSION): Promise<void> {
  // Retire the authoritative primary last. Never expose a shadowed v1 history.
  if (version !== 1) await rm(legacyPath(key), { force: true });
  await removeBackups(key);
  await rm(version === 1 ? legacyPath(key) : sessionPath(key), { force: true });
}

async function effectiveBackup(key: SessionKey) {
  for (const file of [sessionBackupPath(key), legacyPath(key).replace(/\.json$/, ".pre-compact.json")]) {
    const raw = await optionalText(file);
    if (raw !== null) return { file, raw, session: decodeRecord(raw, key) };
  }
  return null;
}

/** Change the storage key, preserving the conversation and its current pre-compaction snapshot. */
export async function renameThread(key: SessionKey, name: string, expected: string): Promise<{ session: Session; revision: string }> {
  if (!isValidSessionName(name)) throw new Error("Usage: /rename <new-name> (1–64 letters, digits, dots, dashes or underscores).");
  return locked(key, async () => {
    const current = await readThread(key);
    checkRevision(current, expected);
    const source = current.session;
    if (!source) throw new Error("No saved thread to rename.");
    if (name === key.name) return { session: source, revision: expected };

    const target = { ...key, name };
    return locked(target, async () => {
      if ((await readThread(target)).session || await effectiveBackup(target)) throw new Error(`Thread ${name} already exists. Choose an unused name.`);
      const backup = await effectiveBackup(key);
      const session = { ...source, name, version: SESSION_VERSION };
      const raw = JSON.stringify(session, null, 2) + "\n";
      const pointer = currentPointerPath(key.scope, key.env);
      return lockFile(pointer, "Current-thread pointer", async () => {
        const selected = (await optionalText(pointer))?.trim() === key.name;
        let copiedBackup = false, movedPointer = false, retiring = false;
        // Publish the complete destination before touching the source. Even a
        // process kill leaves at least one complete copy and a usable pointer.
        await atomicWrite(sessionPath(target), raw);
        try {
          if (backup) {
            await backupSession({ ...backup.session, version: SESSION_VERSION, name }, key.env);
            copiedBackup = true;
          }
          if (selected) { await atomicWrite(pointer, `${name}\n`); movedPointer = true; }
          retiring = true;
          await removeThreadFiles(key, source.version);
        } catch (error) {
          // Source primary is removed last. Restore its effective snapshot and
          // pointer before relinquishing the recovery copy at the destination.
          try {
            if (retiring && backup) await atomicWrite(backup.file, backup.raw);
            if (movedPointer) await atomicWrite(pointer, `${key.name}\n`);
            if (copiedBackup) await rm(sessionBackupPath(target));
            await rm(sessionPath(target));
          } catch (rollback) {
            throw new Error(`Rename interrupted; inspect both ${key.name} and ${name} before retrying: ${String(error)}; recovery: ${String(rollback)}`);
          }
          throw error;
        }
        return { session, revision: digest(raw) };
      });
    });
  });
}

export async function resetSession(key: SessionKey, expected?: string | null): Promise<boolean> {
  return locked(key, async () => {
    const current = await readThread(key);
    if (expected !== undefined) checkRevision(current, expected);
    await removeThreadFiles(key);
    return current.session !== null;
  });
}

/** Remove conversation history and its backup, keeping user-selected context. */
export async function clearSession(key: SessionKey, now: Date = new Date()): Promise<Session | null> {
  const { session: current, revision } = await readThread(key);
  if (!current) return null;
  const timestamp = now.toISOString();
  const cleared: Session = {
    ...current, version: SESSION_VERSION, createdAt: timestamp, updatedAt: timestamp, turns: [], failedPrompts: [],
    context: { refs: sessionRefs(current), skills: sessionSkills(current) },
  };
  await commitThread(key, cleared, revision, "clear");
  return cleared;
}

/** Skill names from every turn, in order of first appearance, deduplicated. */
export function sessionSkills(session: Session | null): string[] {
  if (session?.selection) return session.selection.skills.map(skill => skill.name);
  const seen = new Set<string>(session?.context?.skills);
  for (const turn of session?.turns ?? []) {
    for (const name of turn.skills ?? []) seen.add(name);
  }
  return [...seen];
}

/** References from every turn, in order of first appearance, deduplicated. */
export function sessionRefs(session: Session | null): string[] {
  if (session?.selection) return [...session.selection.refs];
  const seen = new Set<string>(session?.context?.refs);
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
    for (const decision of turn.decisions ?? []) messages.push({ role: "user", content: decision });
  }
  return messages;
}

/** Interleave provider failures with completed prompts for the composer, never for the API. */
export function sessionPrompts(session: Session): string[] {
  const prompts: string[] = [];
  const failed = session.failedPrompts ?? [];
  let failure = 0;
  for (let i = 0; i <= session.turns.length; i++) {
    while (failed[failure]?.afterTurns === i) prompts.push(failed[failure++]!.text);
    const turn = session.turns[i];
    if (turn && !turn.summary && turn.question && turn.question !== "(piped input)") prompts.push(turn.prompt ?? turn.question);
  }
  return prompts;
}

export function rememberFailedPrompt(session: Session, text: string): Session {
  // No turn/token budget advances during repeated authentication failures.
  // Bound the separate recall window; always keep the newest prompt editable.
  const failed = [...(session.failedPrompts ?? []), { afterTurns: session.turns.length, text }].slice(-100);
  let bytes = 0;
  let start = failed.length;
  while (start > 0) {
    bytes += Buffer.byteLength(failed[start - 1]!.text, "utf8");
    if (bytes > 256 * 1024 && start < failed.length) break;
    start--;
  }
  return { ...session, failedPrompts: failed.slice(start) };
}

/** Keep recall positions aligned when either interface trims the oldest turns. */
export function dropOldestTurns(session: Session, dropped: number): Session {
  if (!dropped) return session;
  return { ...session, turns: session.turns.slice(dropped), ...(session.failedPrompts && {
    failedPrompts: session.failedPrompts.filter(p => p.afterTurns >= dropped)
      .map(p => ({ ...p, afterTurns: p.afterTurns - dropped })),
  }) };
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
    failedPrompts: [],
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

  return { session: dropOldestTurns(session, dropped), dropped };
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
    ...(session?.context ? { context: session.context } : {}),
    ...(session?.selection ? { selection: session.selection } : {}),
    ...(session?.failedPrompts ? { failedPrompts: session.failedPrompts } : {}),
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
  await lockFile(file, "Current-thread pointer", () => atomicWrite(file, `${name}\n`));
}

export async function clearCurrentSession(
  scope: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const file = currentPointerPath(scope, env);
  await lockFile(file, "Current-thread pointer", () => rm(file, { force: true }));
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
  const summaries: SessionSummary[] = [];
  const seen = new Set<string>();
  for (const directory of ["sessions-v2", "sessions"]) {
    const dir = path.join(stateDir(env), directory);
    const entries = await readdir(dir).catch((error: unknown) => { if (!missing(error)) throw error; return []; });
    for (const entry of entries) {
      // Only primary files, never backups, locks, or abandoned staging files.
      if (!/^[a-f0-9]{16}\.json$/.test(entry) || seen.has(entry)) continue;
      seen.add(entry);
      const file = path.join(dir, entry);
      try {
        const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
        if (!isSession(parsed) || parsed.scope !== scope || parsed.version !== (directory === "sessions" ? 1 : 2)) continue;
        if (entry !== path.basename(sessionPath({ scope, name: parsed.name, env }))) continue;
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
  expected?: string | null,
): Promise<string | null> {
  const key = { scope: session.scope, name: session.name, env };
  const name = await locked(key, async () => {
    if (expected !== undefined) checkRevision(await readThread(key), expected);
    if (!session.turns.length && !session.failedPrompts?.length) { await removeThreadFiles(key); return null; }
    const base = `${session.name}-${archiveSuffix(now)}`;
    for (let attempt = 1; attempt <= 60; attempt++) {
      const name = attempt === 1 ? base : `${base}-${attempt}`;
      const destination = { ...key, name };
      if ((await readThread(destination)).session) continue;
      await commitThread(destination, { ...session, name, archivedFrom: session.name, archivedAt: now.toISOString() }, null);
      await removeThreadFiles(key);
      return name;
    }
    throw new Error("No free archive name for this minute.");
  });
  if (name) await pruneArchives(session.scope, session.name, KEEP_ARCHIVES, env);
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
    await resetSession({ scope, name: summary.name, env });
  }
  return doomed.length;
}
