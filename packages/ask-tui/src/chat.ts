// UI-independent chat controller. Only submit() can ask the model, exactly once.
import { stat } from "node:fs/promises";
import path from "node:path";
import { askOnce, buildRequest, DEFAULT_MODEL, type ChatClient, type HistoryMessage, type TokenField } from "@codehaus-au/ask/internal/chat";
import { collectContext, type ContextResult, type LimitOverrides } from "@codehaus-au/ask/internal/context";
import { applyUpdates, captureEditableFiles, parseUpdates, prepareUpdates, sensitivePathReason, UPDATE_SYSTEM, updateDiff, updateSummary, type ProposedUpdate, type UpdateSummary } from "./updates.ts";
import { discoverSkills, filterSkills, loadSkill, renderSkills, resolveSkill, skillSearchPaths, type LoadedSkill, type SkillSummary } from "@codehaus-au/ask/internal/skills";
import { terminalField } from "@codehaus-au/ask/internal/terminal";
import { hasGlobMagic, resolveRef, type Resolution } from "@codehaus-au/ask/internal/refs";
import { DEFAULT_SESSION_MAX_TOKENS, estimateTokens } from "@codehaus-au/ask/internal/session";
import { chatRefs } from "./mentions.ts";
export { chatRefs } from "./mentions.ts";

function containsPath(parent: string, file: string): boolean {
  const relative = path.relative(parent, file);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export interface TuiChatOptions {
  readonly cwd: string;
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
  private readonly history: HistoryMessage[] = [];
  private attachments: string[] = [];
  private pending: ProposedUpdate[] = [];
  private reviewed = new Set<string>();
  /** Dropped history not yet reported, including drops before a failed request. */
  private unreportedDrops = 0;
  private busy = false;
  private skills: LoadedSkill[] = [];
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
  get lastAnswer(): string | null { return this.history.findLast((message) => message.role === "assistant")?.content ?? null; }
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
  private trimHistory(budget: number): void {
    let total = this.history.reduce((sum, message) => sum + estimateTokens(message.content), 0);
    let dropped = 0;
    while (this.history.length && (total > budget || this.history[0]!.role !== "user")) {
      total -= estimateTokens(this.history.shift()!.content);
      dropped++;
    }
    this.unreportedDrops += dropped;
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
      for (const skill of selected) byName.set(skill.name, skill);
      this.skills = [...byName.values()];
      return selected;
    } finally { this.busy = false; }
  }

  removeSkill(name: string): void {
    if (this.busy || this.pending.length) throw new Error("Finish the current request or resolve pending edits first.");
    if (!this.skills.some((skill) => skill.name === name)) throw new Error(`No active skill named ${JSON.stringify(name)}. Use /unskill or /context to view active skills.`);
    this.skills = this.skills.filter((skill) => skill.name !== name);
  }

  async submit(text: string, onContextReady?: () => void): Promise<ChatReply> {
    if (this.busy) throw new Error("A request or write is already in progress.");
    if (this.pending.length) throw new Error("Review and /apply or /reject the pending edits before asking again.");
    if (!text.trim()) throw new Error("Enter a question.");
    this.busy = true;
    try {
      // Keep the user's selected file, rather than silently resolving a different
      // skill if discovery precedence changes. Missing/oversized skills fail closed.
      const skills = await Promise.all(this.skills.map((skill) => loadSkill(skill, skill.matched)));
      const missing = await this.pruneMissing();
      const added = await Promise.all(chatRefs(text).map((ref) => this.resolveMention(ref)));
      const addedPaths = added.flatMap((resolution) => resolution.paths);
      // A fresh explicit mention restores that file/folder. Merely retaining an
      // old folder reference must not silently undo the user's file exclusions.
      const excluded = new Set([...this.excludedFiles].filter((file) => !addedPaths.some((ref) => containsPath(ref, file))));
      const refs = [...this.attachments, ...addedPaths];
      const context = await collectContext(refs, {
        cwd: this.options.cwd, limits: this.options.limits ?? {}, excludePaths: [...excluded],
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
      const prompt = attachmentMessage(text, context);
      const instructions = await this.options.instructions?.() ?? "";
      const system = [this.options.system, instructions, renderSkills(skills), UPDATE_SYSTEM].filter(Boolean).join("\n\n");
      this.trimHistory(this.historyBudget(estimateTokens(system) + estimateTokens(prompt)));
      const result = await askOnce(this.client, buildRequest({
        prompt,
        model: this.options.model ?? DEFAULT_MODEL,
        system,
        history: this.history,
        baseURL: this.options.baseURL,
        maxTokens: this.options.maxTokens,
        temperature: this.options.temperature,
        tokenField: this.options.tokenField,
      }));
      this.turns++;
      this.lastInput = result.usage.input;
      this.lastOutput = result.usage.output;
      if (result.usage.input !== null) { this.totalInput += result.usage.input; this.inputTurns++; }
      if (result.usage.output !== null) { this.totalOutput += result.usage.output; this.outputTurns++; }
      this.history.push({ role: "user", content: unescapeMentions(text) }, { role: "assistant", content: result.text });
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
      const historyDropped = this.unreportedDrops;
      this.unreportedDrops = 0;
      return {
        text: result.text, context, proposalError, missing, historyDropped,
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

  /** Write reviewed proposals (all when none are named). Others stay pending. */
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
      const paths = await applyUpdates(selected);
      this.history.push({ role: "user", content: `Local edit decision: approved and applied updates to ${JSON.stringify(paths)}.` });
      return paths;
    } catch (error) {
      this.history.push({ role: "user", content: `Local edit application failed; do not assume any proposal applied. ${String(error)}` });
      throw error;
    } finally { this.busy = false; }
  }

  /** Discard proposals (all when none are named); returns the discarded paths. */
  reject(paths: readonly string[] = []): string[] {
    if (this.busy) throw new Error("A request or write is already in progress.");
    const selected = this.selectPending(paths);
    this.pending = this.pending.filter((update) => !selected.includes(update));
    for (const update of selected) this.reviewed.delete(update.path);
    const rejected = selected.map((update) => update.path);
    this.history.push({ role: "user", content: `Local edit decision: rejected proposals for ${JSON.stringify(rejected)}; those files were not written.` });
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
      const context = await collectContext([...new Set([...this.attachments, ...added.paths])], {
        cwd: this.options.cwd, limits: this.options.limits ?? {}, excludePaths: [...excluded],
      });
      this.attachments = [...new Set(context.resolutions.flatMap((resolution) => resolution.paths))];
      this.files = context.blocks.map((block) => block.path);
      this.excludedFiles = excluded;
      return context;
    } finally { this.busy = false; }
  }

  detach(target: string): void {
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
  }

  restoreFile(target: string): void {
    if (this.busy || this.pending.length) throw new Error("Finish the current request or resolve pending edits first.");
    const absolute = path.resolve(this.options.cwd, target);
    if (!this.excludedFiles.delete(absolute)) throw new Error(`Not excluded: ${JSON.stringify(target)}`);
    if (!this.attachments.some((ref) => containsPath(ref, absolute))) this.attachments.push(absolute);
  }

  /** Start a fresh conversation with the same selected context and settings. */
  clearConversation(): void {
    if (this.busy) throw new Error("A request or write is already in progress.");
    this.history.length = 0;
    this.pending = [];
    this.reviewed.clear();
    this.turns = 0;
    this.lastInput = null;
    this.lastOutput = null;
    this.totalInput = 0;
    this.totalOutput = 0;
    this.inputTurns = 0;
    this.outputTurns = 0;
    this.unreportedDrops = 0;
  }

  reset(): void {
    this.clearConversation();
    this.attachments = [];
    this.skills = [];
    this.files = [];
    this.excludedFiles.clear();
  }
}
