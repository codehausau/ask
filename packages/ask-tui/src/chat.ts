// UI-independent chat controller. Only submit() can ask the model, exactly once.
import { stat } from "node:fs/promises";
import path from "node:path";
import { askOnce, buildRequest, DEFAULT_MODEL, type ChatClient, type HistoryMessage, type TokenField } from "@codehaus-au/ask/internal/chat";
import { collectContext, type ContextResult, type LimitOverrides } from "@codehaus-au/ask/internal/context";
import { applyUpdates, captureEditableFiles, parseUpdates, prepareUpdates, sensitivePathReason, UPDATE_SYSTEM, updateDiff, updateSummary, type ProposedUpdate, type UpdateSummary } from "./updates.ts";
import { discoverSkills, filterSkills, loadSkill, renderSkills, resolveSkill, skillSearchPaths, type LoadedSkill, type SkillSummary } from "@codehaus-au/ask/internal/skills";
import { terminalField } from "@codehaus-au/ask/internal/terminal";
import { hasGlobMagic, resolveRef, type Resolution } from "@codehaus-au/ask/internal/refs";
import {
  commitThread, DEFAULT_SESSION_MAX_TOKENS, emptySession, estimateTokens, isValidSessionName,
  dropOldestTurns, listSessions, readThread, rememberFailedPrompt, scopedPath, sessionMessages, sessionPrompts,
  sessionRefs, sessionSkills, writeCurrentSession,
  type Session, type SessionTurn, type ThreadSelection,
} from "@codehaus-au/ask/internal/session";
import { chatRefs } from "./mentions.ts";
export { chatRefs } from "./mentions.ts";

function containsPath(parent: string, file: string): boolean {
  const relative = path.relative(parent, file);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export interface TuiChatOptions {
  readonly cwd: string;
  readonly scope?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly model?: string;
  readonly system?: string;
  readonly baseURL?: string | undefined;
  readonly maxTokens?: number | undefined;
  readonly temperature?: number | undefined;
  readonly tokenField?: TokenField | undefined;
  readonly limits?: LimitOverrides;
  readonly skillRoots?: readonly string[];
  /** Rendered instruction files (AGENTS.md and configured `instructions`),
   * re-read for every submission so edits apply without restarting. */
  readonly instructions?: (() => Promise<string>) | undefined;
  /** Explicit model capacity; never inferred from a model name or endpoint.
   * When set, resent history is trimmed so the estimated request fits it. */
  readonly contextWindow?: number | undefined;
}

/** Share of the context window left unused: token counts here are only estimates. */
const WINDOW_MARGIN = 0.1;
/** Room kept for the answer when --max-tokens is not set (at most a quarter of the window). */
const DEFAULT_ANSWER_RESERVE = 4096;

/** `\@` keeps a literal @ out of mention parsing; the model sees a plain @. */
function unescapeMentions(text: string): string {
  return text.replace(/\\@/g, "@");
}

function attachmentMessage(text: string, context: ContextResult): string {
  return [unescapeMentions(text), ...context.blocks.map((block) =>
    `<file path=${JSON.stringify(block.path)}${block.truncated ? ' truncated="true"' : ""}>\n${block.text}\n</file>`),
  ].join("\n\n");
}

export interface ChatReply {
  readonly text: string;
  readonly context: ContextResult;
  readonly status: string;
  readonly proposalError: string | null;
  /** Attachments removed because they no longer exist. */
  readonly missing: readonly string[];
  /** Oldest history messages dropped to fit the context window (or the default history cap). */
  readonly historyDropped: number;
  readonly saveError?: string;
}

export interface TuiSessionStats {
  readonly cwd: string;
  readonly turns: number;
  readonly contextWindow: number | null;
  readonly lastInput: number | null;
  readonly lastOutput: number | null;
  readonly totalInput: number;
  readonly totalOutput: number;
  readonly inputTurns: number;
  readonly outputTurns: number;
  readonly files: readonly string[];
}

export class TuiChat {
  private readonly client: ChatClient;
  private readonly options: TuiChatOptions;
  private record: Session;
  private named = false;
  private revision: string | null = null;
  private unsaved = false;
  private attachments: string[] = [];
  private pending: ProposedUpdate[] = [];
  private reviewed = new Set<string>();
  private busy = false;
  private skills: { name: string; file: string | null; known?: LoadedSkill }[] = [];
  private turns = 0;
  private lastInput: number | null = null;
  private lastOutput: number | null = null;
  private totalInput = 0;
  private totalOutput = 0;
  private inputTurns = 0;
  private outputTurns = 0;
  private files: string[] = [];
  private excludedFiles = new Set<string>();

  constructor(client: ChatClient, options: TuiChatOptions) {
    this.client = client;
    this.options = options;
    this.record = emptySession(options.scope ?? options.cwd, "temporary");
    if (options.contextWindow !== undefined && (!Number.isSafeInteger(options.contextWindow) || options.contextWindow <= 0)) {
      throw new Error("Context window must be a positive safe integer.");
    }
  }

  get attachmentPaths(): readonly string[] { return this.attachments.map((file) => path.relative(this.options.cwd, file) || "."); }
  get pendingCount(): number { return this.pending.length; }
  get pendingReviews(): readonly { path: string; reviewed: boolean }[] {
    return this.pending.map((update) => ({ path: update.path, reviewed: this.reviewed.has(update.path) }));
  }
  get pendingSummary(): readonly UpdateSummary[] { return this.pending.map(updateSummary); }
  get activeSkillNames(): readonly string[] { return this.skills.map((skill) => skill.name); }
  get excludedFilePaths(): readonly string[] { return [...this.excludedFiles].map((file) => path.relative(this.options.cwd, file)); }
  get lastAnswer(): string | null { return this.record.turns.findLast(t => !t.summary)?.answer ?? null; }
  get threadName(): string | null { return this.named ? this.record.name : null; }
  get savedTurns(): readonly SessionTurn[] { return this.record.turns; }
  get prompts(): string[] {
    return sessionPrompts(this.record);
  }
  private get scope(): string { return this.options.scope ?? this.options.cwd; }
  private key(name: string) { return { scope: this.scope, name, env: this.options.env ?? process.env }; }
  private selection(): ThreadSelection {
    return {
      refs: this.attachments.map(file => scopedPath(this.scope, file)),
      excluded: [...this.excludedFiles].map(file => scopedPath(this.scope, file)),
      skills: this.skills.map(({ name, file }) => ({ name, file: file && scopedPath(this.scope, file) })),
    };
  }
  private async persist(operation?: "clear") {
    if (!this.named) return;
    this.unsaved = true;
    this.record = { ...this.record, updatedAt: new Date().toISOString(), selection: this.selection() };
    this.revision = await commitThread(this.key(this.record.name), this.record, this.revision, operation);
    this.unsaved = false;
  }
  async threads(): Promise<string> {
    const names = await listSessions(this.scope, this.options.env);
    return [`Active: ${terminalField(this.threadName ?? "(temporary)")}`,
      ...names.map(t => `${t.name === this.threadName ? "*" : " "} ${terminalField(t.name)} (${t.turns} ${t.turns === 1 ? "turn" : "turns"})`)].join("\n");
  }
  async switchThread(name: string): Promise<void> {
    if (!isValidSessionName(name)) throw new Error("Usage: /switch <thread-name> (letters, digits, dot, dash, underscore; 1–64 characters).");
    if (this.busy || this.pending.length) throw new Error("Finish the current request or resolve pending edits before switching.");
    this.busy = true;
    try {
      const key = this.key(name);
      const destination = await readThread(key);
      const carry = !this.named || this.unsaved;
      if (destination.session && carry && (this.unsaved || this.record.turns.length || this.record.failedPrompts?.length ||
        this.attachments.length || this.skills.length || this.excludedFiles.size)) {
        throw new Error("Unsaved conversation: /switch to an unused name to save it, or /new to discard it.");
      }
      const next = { ...(destination.session ?? (carry ? { ...this.record, selection: this.selection() } : emptySession(this.scope, name))),
        name, updatedAt: new Date().toISOString() };
      const revision = await commitThread(key, next, destination.revision);
      await writeCurrentSession(this.scope, name, key.env);
      this.resetMemory();
      this.record = next; this.named = true; this.revision = revision; this.unsaved = false;
      this.attachments = sessionRefs(next).map(p => path.resolve(this.scope, p));
      this.excludedFiles = new Set(next.selection?.excluded.map(p => path.resolve(this.scope, p)));
      this.skills = sessionSkills(next).map(name => {
        const file = next.selection?.skills.find(s => s.name === name)?.file;
        return { name, file: file ? path.resolve(this.scope, file) : null };
      });
      for (const turn of next.turns) {
        this.turns++;
        this.lastInput = turn.usage?.input ?? null; this.lastOutput = turn.usage?.output ?? null;
        if (this.lastInput !== null) { this.totalInput += this.lastInput; this.inputTurns++; }
        if (this.lastOutput !== null) { this.totalOutput += this.lastOutput; this.outputTurns++; }
      }
    } finally { this.busy = false; }
  }
  get sessionStats(): TuiSessionStats {
    return {
      cwd: this.options.cwd, turns: this.turns, contextWindow: this.options.contextWindow ?? null,
      lastInput: this.lastInput, lastOutput: this.lastOutput,
      totalInput: this.totalInput, totalOutput: this.totalOutput,
      inputTurns: this.inputTurns, outputTurns: this.outputTurns, files: [...this.files],
    };
  }

  private get skillRoots(): readonly string[] { return this.options.skillRoots ?? skillSearchPaths(this.options.cwd); }

  /** Typed mentions name an existing path or a glob. Fuzzy search belongs to the
   * @ picker, so an @word in a question can never silently attach another file.
   */
  private async resolveMention(ref: string): Promise<Resolution> {
    const error = () => new Error(`@${ref} is not a file or folder here. Pick one from the @ menu, or type \\@ for a literal @.`);
    if (!hasGlobMagic(ref) && !await stat(path.resolve(this.options.cwd, ref)).catch(() => null)) throw error();
    const resolution = await resolveRef(ref, { cwd: this.options.cwd });
    if (resolution.kind === "search") throw error();
    return resolution;
  }

  /** Drop attachments deleted since they were added, instead of failing every request. */
  private async pruneMissing(): Promise<string[]> {
    const present = await Promise.all(this.attachments.map((file) => stat(file).then(() => true, () => false)));
    const missing = this.attachments.filter((_, index) => !present[index]);
    this.attachments = this.attachments.filter((_, index) => present[index]);
    return missing.map((file) => path.relative(this.options.cwd, file) || ".");
  }

  /**
   * Room for resent history. With a known context window, everything else in the
   * request (system prompt, message, attachments, answer reserve) comes first, and
   * a request that cannot fit even without history is refused before sending.
   * Without one, history alone is capped at the CLI's session default.
   */
  private historyBudget(requestTokens: number): number {
    const window = this.options.contextWindow;
    if (window === undefined) return DEFAULT_SESSION_MAX_TOKENS;
    const answer = this.options.maxTokens ?? Math.min(DEFAULT_ANSWER_RESERVE, Math.floor(window / 4));
    const usable = Math.floor(window * (1 - WINDOW_MARGIN)) - answer;
    if (requestTokens > usable) {
      throw new Error(`This message needs about ${requestTokens.toLocaleString("en-US")} tokens before any history ` +
        `(system prompt, message and attachments, estimated), but only ${Math.max(0, usable).toLocaleString("en-US")} of the ` +
        `${window.toLocaleString("en-US")}-token context window are available after reserving ${answer.toLocaleString("en-US")} ` +
        "for the answer and a 10% estimate margin. Detach files, or raise --context-window if the model allows more.");
    }
    return usable - requestTokens;
  }

  /** Oldest messages go first; history always restarts at a user message. */
  private historyForRequest(budget: number): { record: Session; dropped: number } {
    const weight = (messages: HistoryMessage[]) => messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
    let total = weight(sessionMessages(this.record));
    let dropped = 0;
    let start = 0;
    while (start < this.record.turns.length && total > budget) {
      const messages = sessionMessages({ ...this.record, turns: [this.record.turns[start++]!] });
      total -= weight(messages);
      dropped += messages.length;
    }
    return { record: dropOldestTurns(this.record, start), dropped };
  }

  /** Pending proposals named by path (all when none are named). */
  private selectPending(paths: readonly string[]): ProposedUpdate[] {
    if (!this.pending.length) throw new Error("No pending edits.");
    if (!paths.length) return [...this.pending];
    const key = (file: string) => path.resolve(this.options.cwd, file.replace(/^@/, ""));
    const wanted = new Set(paths.map(key));
    const unknown = paths.filter((file) => !this.pending.some((update) => key(update.path) === key(file)));
    if (unknown.length) {
      throw new Error(`No pending edit for ${unknown.map((file) => JSON.stringify(file)).join(", ")}. Pending: ${this.pending.map((update) => JSON.stringify(update.path)).join(", ")}.`);
    }
    return this.pending.filter((update) => wanted.has(key(update.path)));
  }

  availableSkills(): Promise<SkillSummary[]> { return discoverSkills(this.skillRoots); }

  async listSkills(term = ""): Promise<string> {
    const available = filterSkills(await this.availableSkills(), term);
    return [
      "Skills (* = active; select with /skill <name>, remove with /unskill <name>)",
      ...available.map((skill) => `${this.skills.some((active) => active.file === skill.file) ? "*" : " "} ${terminalField(skill.name)} — ${terminalField(skill.description)}`),
      ...(available.length ? [] : ["No matching skills."]),
      "Search paths:", ...this.skillRoots.map((root) => `  ${terminalField(root)}`),
    ].join("\n");
  }

  /** User selection only. Validate the whole batch before changing active skills. */
  async selectSkills(terms: readonly string[]): Promise<readonly LoadedSkill[]> {
    if (this.busy || this.pending.length) throw new Error("Finish the current request or resolve pending edits first.");
    if (!terms.length) return [];
    this.busy = true;
    try {
      const available = await discoverSkills(this.skillRoots);
      const selected: LoadedSkill[] = [];
      for (const term of terms) {
        const summary = resolveSkill(term, available);
        selected.push(await loadSkill(summary, summary.name === term ? "name" : "search"));
      }
      const byName = new Map(this.skills.map((skill) => [skill.name, skill]));
      for (const skill of selected) byName.set(skill.name, { name: skill.name, file: skill.file, known: skill });
      this.skills = [...byName.values()];
      await this.persist();
      return selected;
    } finally { this.busy = false; }
  }

  removeSkill(name: string): Promise<void> {
    if (this.busy || this.pending.length) throw new Error("Finish the current request or resolve pending edits first.");
    if (!this.skills.some((skill) => skill.name === name)) throw new Error(`No active skill named ${JSON.stringify(name)}. Use /unskill or /context to view active skills.`);
    this.skills = this.skills.filter((skill) => skill.name !== name);
    return this.persistSelection();
  }

  /** Synchronous edit is visible immediately; hold the busy guard until disk catches up. */
  private persistSelection(): Promise<void> {
    if (!this.named) return Promise.resolve();
    this.busy = true;
    return this.persist().finally(() => { this.busy = false; });
  }

  async submit(text: string, onContextReady?: () => void): Promise<ChatReply> {
    if (this.busy) throw new Error("A request or write is already in progress.");
    if (this.pending.length) throw new Error("Review and /apply or /reject the pending edits before asking again.");
    if (!text.trim()) throw new Error("Enter a question.");
    this.busy = true;
    try {
      // Keep the user's selected file, rather than silently resolving a different
      // skill if discovery precedence changes. Missing/oversized skills fail closed.
      const missing = await this.pruneMissing();
      const skills: LoadedSkill[] = [];
      const catalog = this.skills.length && (this.named || this.skills.some(s => !s.known)) ? await this.availableSkills() : [];
      for (const choice of this.skills) {
        const skill = (!this.named ? choice.known : undefined)
          ?? catalog.find(s => s.name === choice.name && (!choice.file || s.file === choice.file));
        if (!skill) { missing.push(`skill: ${choice.name}`); continue; }
        skills.push(await loadSkill(skill, choice.known?.matched ?? "name"));
      }
      this.skills = skills.map(s => ({ name: s.name, file: s.file, known: s }));
      const added = await Promise.all(chatRefs(text).map((ref) => this.resolveMention(ref)));
      const addedPaths = added.flatMap((resolution) => resolution.paths);
      // A fresh explicit mention restores that file/folder. Merely retaining an
      // old folder reference must not silently undo the user's file exclusions.
      const excluded = new Set([...this.excludedFiles].filter((file) => !addedPaths.some((ref) => containsPath(ref, file))));
      const refs = [...this.attachments, ...addedPaths];
      const context = await collectContext(refs, {
        cwd: this.options.cwd, exactRefs: new Set(refs), limits: this.options.limits ?? {}, excludePaths: [...excluded],
      });
      // Store resolved paths, not fuzzy names that could silently match another file.
      const attachments = [...new Set(context.resolutions.flatMap((resolution) => resolution.paths))];
      const files = await captureEditableFiles(context.blocks, this.options.cwd);
      // Attachment selection is local state, not dependent on provider success.
      // Publish it after validation but before starting the network request.
      this.attachments = attachments;
      this.excludedFiles = excluded;
      this.files = context.blocks.map((block) => block.path);
      onContextReady?.();
      // A validated mention is an explicit context change even if the provider fails.
      if (this.named && JSON.stringify(this.record.selection) !== JSON.stringify(this.selection())) await this.persist();
      const prompt = attachmentMessage(text, context);
      const instructions = await this.options.instructions?.() ?? "";
      const system = [this.options.system, instructions, renderSkills(skills), UPDATE_SYSTEM].filter(Boolean).join("\n\n");
      const { record, dropped: historyDropped } = this.historyForRequest(this.historyBudget(estimateTokens(system) + estimateTokens(prompt)));
      const request = buildRequest({
        prompt,
        model: this.options.model ?? DEFAULT_MODEL,
        system,
        history: sessionMessages(record),
        baseURL: this.options.baseURL,
        maxTokens: this.options.maxTokens,
        temperature: this.options.temperature,
        tokenField: this.options.tokenField,
      });
      let result: Awaited<ReturnType<typeof askOnce>>;
      try { result = await askOnce(this.client, request); }
      catch (error) {
        this.record = rememberFailedPrompt(this.record, text);
        // A provider's 401 message can echo the rejected key. Never display or store it.
        const failure = error && typeof error === "object" && "status" in error && error.status === 401
          ? new Error("401: The endpoint rejected your API credentials. Check the API key and endpoint, then restart ask-tui.") : error;
        try { await this.persist(); }
        catch (saveError) { throw new Error(`${String(failure)}. Prompt available in this chat but not saved: ${String(saveError)}`); }
        throw failure;
      }
      this.turns++;
      this.lastInput = result.usage.input;
      this.lastOutput = result.usage.output;
      if (result.usage.input !== null) { this.totalInput += result.usage.input; this.inputTurns++; }
      if (result.usage.output !== null) { this.totalOutput += result.usage.output; this.outputTurns++; }
      this.record = { ...record, turns: [...record.turns, { at: new Date().toISOString(),
        question: unescapeMentions(text), prompt: text, refs: [], answer: result.text, usage: result.usage }] };
      let saveError: string | undefined;
      try { await this.persist(); } catch (error) { saveError = `Answer not saved: ${String(error)}. Use /switch with an unused name to keep it.`; }
      let proposalError: string | null = null;
      try {
        if (result.finishReason !== "stop") {
          throw new Error(`Edits disabled: incomplete or unexpected response (${result.finishReason ?? "unknown"}).`);
        }
        this.pending = prepareUpdates(parseUpdates(result.text), files);
      } catch (error) {
        this.pending = [];
        proposalError = error instanceof Error ? error.message : String(error);
      }
      this.reviewed.clear();
      return {
        text: result.text, context, proposalError, missing, historyDropped, ...(saveError ? { saveError } : {}),
        status: `${result.model} · ${context.blocks.length} file(s) · skills ${skills.map((skill) => terminalField(skill.name)).join(", ") || "none"} · tokens ${result.usage.input ?? "?"} in / ${result.usage.output ?? "?"} out`,
      };
    } finally { this.busy = false; }
  }

  /** Full-file diffs from the validated snapshots, without authorizing writes. */
  previewDetails(paths: readonly string[] = []): { path: string; diff: string; sensitive: string | null }[] {
    return this.selectPending(paths).map((update) => ({ path: update.path, diff: updateDiff(update), sensitive: sensitivePathReason(update.path) }));
  }

  /** Diffs for pending files (all when none are named); only reviewed files can be applied. */
  reviewDetails(paths: readonly string[] = []): { path: string; diff: string; sensitive: string | null }[] {
    const details = this.previewDetails(paths);
    for (const detail of details) this.reviewed.add(detail.path);
    return details;
  }

  review(paths: readonly string[] = []): string[] {
    return this.reviewDetails(paths).map((detail) => detail.diff);
  }

  /** Leave proposals pending, but require a fresh review before writing. */
  cancelReview(paths: readonly string[]): void {
    if (this.busy) throw new Error("A request or write is already in progress.");
    for (const update of this.selectPending(paths)) this.reviewed.delete(update.path);
  }

  /** Write reviewed proposals only: no commands, hooks, formatting, tests or model follow-up.
   * All when none are named; others stay pending. */
  async apply(paths: readonly string[] = []): Promise<string[]> {
    if (this.busy) throw new Error("A request or write is already in progress.");
    const selected = this.selectPending(paths);
    const unreviewed = selected.filter((update) => !this.reviewed.has(update.path));
    if (unreviewed.length) {
      throw new Error(`Use /review before /apply. Not yet reviewed: ${unreviewed.map((update) => JSON.stringify(update.path)).join(", ")}.`);
    }
    this.busy = true;
    // Failed/partially applied proposals must not be retried against stale snapshots.
    this.pending = this.pending.filter((update) => !selected.includes(update));
    for (const update of selected) this.reviewed.delete(update.path);
    try {
      let applied: string[];
      try { applied = await applyUpdates(selected); }
      catch (error) {
        this.recordDecision(`Local edit application failed; do not assume any proposal applied. ${String(error)}`);
        try { await this.persist(); }
        catch (saveError) { throw new Error(`${String(error)}. Thread outcome not saved: ${String(saveError)}`); }
        throw error;
      }
      this.recordDecision(`Local edit decision: approved and applied updates to ${JSON.stringify(applied)}.`);
      try { await this.persist(); }
      catch (error) { throw new Error(`Files written: ${JSON.stringify(applied)}. Thread outcome not saved: ${String(error)}`); }
      return applied;
    } finally { this.busy = false; }
  }

  private recordDecision(text: string) {
    const last = this.record.turns.at(-1);
    if (last) this.record = { ...this.record, turns: [...this.record.turns.slice(0, -1),
      { ...last, decisions: [...(last.decisions ?? []), text] }] };
  }

  /** Discard proposals (all when none are named); returns the discarded paths. */
  reject(paths: readonly string[] = []): string[] {
    if (this.busy) throw new Error("A request or write is already in progress.");
    const selected = this.selectPending(paths);
    this.pending = this.pending.filter((update) => !selected.includes(update));
    for (const update of selected) this.reviewed.delete(update.path);
    const rejected = selected.map((update) => update.path);
    this.recordDecision(`Local edit decision: rejected proposals for ${JSON.stringify(rejected)}; those files were not written.`);
    return rejected;
  }

  async rejectAndSave(paths: readonly string[]): Promise<string[]> {
    const rejected = this.reject(paths);
    await this.persistSelection();
    return rejected;
  }

  /** Explicit local attachment selection, with no model request or file writes. */
  async attach(ref: string): Promise<ContextResult> {
    if (this.busy || this.pending.length) throw new Error("Finish the current request or resolve pending edits first.");
    this.busy = true;
    try {
      await this.pruneMissing();
      const added = await resolveRef(ref, { cwd: this.options.cwd });
      const excluded = new Set([...this.excludedFiles].filter((file) => !added.paths.some((parent) => containsPath(parent, file))));
      const refs = new Set([...this.attachments, ...added.paths]);
      const context = await collectContext([...refs], {
        exactRefs: refs,
        cwd: this.options.cwd, limits: this.options.limits ?? {}, excludePaths: [...excluded],
      });
      this.attachments = [...new Set(context.resolutions.flatMap((resolution) => resolution.paths))];
      this.files = context.blocks.map((block) => block.path);
      this.excludedFiles = excluded;
      await this.persist();
      return context;
    } finally { this.busy = false; }
  }

  detach(target: string): Promise<void> {
    if (this.busy || this.pending.length) throw new Error("Finish the current request or resolve pending edits first.");
    const absolute = path.resolve(this.options.cwd, target.replace(/^@/, ""));
    const knownFile = this.files.some((file) => path.resolve(this.options.cwd, file) === absolute);
    if (!this.attachments.includes(absolute) && !knownFile) throw new Error(`Not attached: ${JSON.stringify(target)}`);
    this.attachments = this.attachments.filter((file) => file !== absolute);
    if (knownFile) this.excludedFiles.add(absolute);
    this.files = this.files.filter((file) => {
      const name = path.resolve(this.options.cwd, file);
      return !this.excludedFiles.has(name) && this.attachments.some((ref) => containsPath(ref, name));
    });
    return this.persistSelection();
  }

  restoreFile(target: string): Promise<void> {
    if (this.busy || this.pending.length) throw new Error("Finish the current request or resolve pending edits first.");
    const absolute = path.resolve(this.options.cwd, target);
    if (!this.excludedFiles.delete(absolute)) throw new Error(`Not excluded: ${JSON.stringify(target)}`);
    if (!this.attachments.some((ref) => containsPath(ref, absolute))) this.attachments.push(absolute);
    return this.persistSelection();
  }

  /** Start a fresh conversation with the same selected context and settings. */
  clearConversation(): Promise<void> {
    if (this.busy) throw new Error("A request or write is already in progress.");
    if (!this.named) { this.resetHistory(); return Promise.resolve(); }
    this.busy = true;
    const cleared = { ...emptySession(this.scope, this.record.name), selection: this.selection() };
    return commitThread(this.key(this.record.name), cleared, this.revision, "clear").then(revision => {
      this.resetHistory(); this.record = cleared; this.revision = revision; this.unsaved = false;
    }).finally(() => { this.busy = false; });
  }

  private resetHistory(): void {
    this.record = emptySession(this.scope, "temporary");
    this.pending = [];
    this.reviewed.clear();
    this.turns = 0;
    this.lastInput = null;
    this.lastOutput = null;
    this.totalInput = 0;
    this.totalOutput = 0;
    this.inputTurns = 0;
    this.outputTurns = 0;
  }

  private resetMemory(): void {
    this.resetHistory();
    this.attachments = [];
    this.skills = [];
    this.files = [];
    this.excludedFiles.clear();
  }
  reset(): void {
    if (this.busy) throw new Error("A request or write is already in progress.");
    this.resetMemory(); this.named = false; this.revision = null; this.unsaved = false;
  }
}
