import type { CliRenderer, KeyEvent } from "@opentui/core";
import { terminalField } from "@codehaus-au/ask/internal/terminal";
import type { UpdateView } from "@codehaus-au/ask/internal/config";
import { SkillResolutionError } from "@codehaus-au/ask/internal/skills";
import { TuiChat } from "./chat.ts";
import { themeModes, type ThemeMode } from "./themes.ts";
import { TuiTheme } from "./theme.ts";
import { createChatLayout } from "./layout.ts";
import { createTranscript } from "./transcript.ts";
import type { UpdateAction } from "./update-panel.ts";
import { createClipboardController, type ClipboardFactory } from "./clipboard.ts";
import { createCompletion, type UIState } from "./completion.ts";
import { dispatchCommand } from "./commands.ts";

export { TUI_HELP } from "./commands.ts";
export { SIDEBAR_MIN_WIDTH, SIDEBAR_MIN_COLUMNS, CHAT_MIN_COLUMNS } from "./layout.ts";
export interface TuiUIOptions {
  /** Lazy, fixed file discovery; invoked only by the file/mention picker. */
  readonly loadCandidates?: () => Promise<{ readonly paths: readonly string[]; readonly truncated: boolean }>;
  readonly theme?: string;
  readonly updateView?: UpdateView;
  readonly createClipboard?: ClipboardFactory;
  /** Startup warnings, shown in the transcript rather than written over the UI. */
  readonly notices?: readonly string[];
  /** Persist a chosen theme as the default. `warning` explains anything that
   * would still override it next time. */
  readonly saveTheme?: (name: string) => Promise<{ readonly file: string; readonly warning?: string | undefined }>;
}

/** Coordinates components and the single in-flight submission/write lifecycle. */
export function mountChatUI(renderer: CliRenderer, chat: TuiChat, model: string, options: TuiUIOptions = {}) {
  const theme = new TuiTheme();
  if (options.theme !== undefined) theme.select(options.theme, themeModes(options.theme)[0]!);
  const state: UIState = { working: false, alive: true };
  let completion: ReturnType<typeof createCompletion> | undefined;
  const layout = createChatLayout(renderer, model, chat.sessionStats.cwd, {
    onSubmit: () => { void submit(); },
    onContentChange: () => completion?.contentChanged(),
    onCursorChange: () => completion?.refresh(),
  });
  const { root, input, status, picker, transcript } = layout;
  const view = createTranscript(renderer, transcript, theme, options.updateView);
  const clipboard = createClipboardController(renderer, input, status, options.createClipboard);
  function paintTheme() { theme.paint(root); view.paintTheme(); }
  root.renderBefore = paintTheme;
  function applyTheme(name: string, mode: ThemeMode) {
    if (theme.name === name && theme.mode === mode) return;
    theme.select(name, mode); view.updateStyle(); paintTheme();
  }
  function refreshSummary() {
    if (state.alive) layout.refreshSummary(chat.sessionStats, chat.activeSkillNames, chat.pendingCount);
  }
  function addText(content: string, color?: string) { if (state.alive) view.addText(content, color); }
  // A confirmed theme choice (not a preview) becomes the default, one save at a time.
  let saving: Promise<void> = Promise.resolve();
  function themeChosen(name: string, mode: ThemeMode) {
    const label = `Theme: ${terminalField(name)} · ${mode}`;
    if (!options.saveTheme) { status.content = `${label} (this run)`; return; }
    status.content = `${label} · saving…`;
    const save = options.saveTheme;
    saving = saving.then(() => save(name)).then((result) => {
      if (!state.alive) return;
      status.content = `${label} · saved to ${terminalField(result.file)}`;
      if (result.warning) addText(result.warning, "#fcd34d");
    }, (error: unknown) => {
      if (!state.alive) return;
      status.content = `${label} (this run only)`;
      addText(`Theme not saved: ${error instanceof Error ? error.message : String(error)}`, "#fda4af");
    });
  }
  completion = createCompletion(renderer, chat, layout, theme, state, {
    submit, refreshSummary, applyTheme, addText, themeChosen,
    ...(options.loadCandidates ? { loadCandidates: options.loadCandidates } : {}),
  });
  const review = (paths: readonly string[]) => view.review(chat.reviewDetails(paths));
  const syncUpdates = () => view.syncUpdates(chat.pendingReviews, state.working);
  function readyStatus() {
    status.content = chat.pendingCount ? `${chat.pendingCount} pending file(s) · /review to inspect · /apply to approve · /reject to discard` : "Ready · /help for commands";
  }

  async function updateAction(action: UpdateAction, path: string, turn: number) {
    if (!state.alive || state.working || chat.sessionStats.turns !== turn) return;
    state.working = true; syncUpdates();
    try {
      if (action === "review") view.review(chat.reviewDetails([path]), true);
      else if (action === "cancel") chat.cancelReview([path]);
      else if (action === "reject") {
        const rejected = chat.reject([path]);
        view.rejected(rejected);
        addText(`Rejected ${JSON.stringify(rejected)}; nothing written.`);
      } else {
        const applied = await chat.apply([path]);
        if (state.alive) view.applied(applied);
        addText(`Applied updates to ${JSON.stringify(applied)}. Review with git diff.`, "#a7f3d0");
      }
      if (state.alive) readyStatus();
    } catch (error) {
      addText(error instanceof Error ? error.message : String(error), "#fda4af");
      if (state.alive) status.content = "Edit action failed";
    } finally {
      state.working = false;
      if (state.alive) { syncUpdates(); completion!.refresh(); refreshSummary(); }
    }
  }

  async function submit() {
    if (state.working || !state.alive) return;
    const text = input.plainText.trim();
    if (!text) return;
    clipboard.submitted();
    state.working = true; picker.visible = false; input.setText("");
    syncUpdates();
    let timer: ReturnType<typeof setInterval> | undefined;
    try {
      const command = await dispatchCommand(text, chat, {
        quit: () => renderer.destroy(), clear: view.clear, review, rejected: view.rejected,
        applied: (paths) => { if (state.alive) view.applied(paths); }, copy: clipboard.copyText,
        addText, openManager: (mode, query) => completion!.openManager(mode, query),
      });
      if (command === "return" || !state.alive) return;
      if (command === "prompt") {
        view.addUserMessage(text); status.content = `Waiting for ${terminalField(model)}…`;
        // Only a model request shows the waiting timer; local commands do not.
        const started = Date.now();
        timer = setInterval(() => {
          if (state.alive) status.content = `Waiting for ${terminalField(model)}… ${((Date.now() - started) / 1000).toFixed(1)}s · no automatic follow-up`;
        }, 250);
        const reply = await chat.submit(text, refreshSummary);
        if (!state.alive) return;
        if (reply.missing.length) addText(`Removed attachments that no longer exist: ${reply.missing.map(terminalField).join(", ")}`, "#fcd34d");
        if (reply.historyDropped) {
          const limit = chat.sessionStats.contextWindow === null ? "the default history cap (set --context-window to use your model's limit)" : "the context window";
          addText(`Dropped the ${reply.historyDropped} oldest history message(s) to fit ${limit}. Attached files are still sent in full.`, "#fcd34d");
        }
        const turn = chat.sessionStats.turns;
        view.addAnswer(reply.text, chat.pendingCount ? chat.previewDetails() : [], (action, path) => { void updateAction(action, path, turn); });
        if (reply.context.skipped.length) addText(`Skipped context: ${reply.context.skipped.map((item) => `${terminalField(item.path)} (${item.reason})`).join(", ")}`, "#fcd34d");
        if (reply.context.truncated) addText("Context was truncated; truncated files cannot be updated.", "#fcd34d");
        if (reply.proposalError) addText(`Edits unavailable: ${reply.proposalError}`, "#fcd34d");
        if (chat.pendingCount) view.proposals(chat.pendingSummary);
      }
      if (state.alive) readyStatus();
    } catch (error) {
      if (state.alive) {
        addText(error instanceof Error ? error.message : String(error), "#fda4af");
        if (error instanceof SkillResolutionError && error.candidates.length) addText(error.candidates.map(terminalField).join("\n"), "#fcd34d");
        status.content = "Failed · your draft has been restored";
        if (!input.plainText) { input.setText(text); input.gotoBufferEnd(); }
      }
    } finally {
      if (timer) clearInterval(timer);
      state.working = false;
      if (state.alive) { syncUpdates(); input.focus(); completion!.refresh(); refreshSummary(); }
    }
  }

  const keypress = (key: KeyEvent) => {
    // Super is Command; Meta is usually Alt/Option and is intentionally unbound.
    if (key.super && key.name === "c") { key.preventDefault(); clipboard.copyText(clipboard.selectedText() || null); return; }
    if ((key.ctrl || key.super) && key.name === "v") { key.preventDefault(); void clipboard.pasteText(); return; }
    if (key.ctrl && key.name === "c") {
      key.preventDefault();
      const selection = clipboard.selectedText();
      if (selection) clipboard.copyText(selection); else renderer.destroy();
      return;
    }
    if (key.ctrl && key.name === "d") { key.preventDefault(); renderer.destroy(); return; }
    if (key.name === "pageup" || key.name === "pagedown") {
      key.preventDefault(); transcript.scrollBy(key.name === "pageup" ? -10 : 10); return;
    }
    completion!.handleKey(key);
  };
  renderer.keyInput.on("keypress", keypress);
  const resize = () => { layout.resize(); view.resize(); refreshSummary(); completion!.refresh(); };
  renderer.on("resize", resize);
  renderer.once("destroy", () => {
    state.alive = false;
    completion!.dispose(); clipboard.dispose();
    renderer.removeListener("resize", resize);
    renderer.keyInput.removeListener("keypress", keypress);
    view.dispose();
  });
  addText("Ask a question or discuss a function. Attach @files or @folders anywhere.\nSuggested <update> blocks become reviewable diffs, never automatic writes. /help for commands.");
  for (const notice of options.notices ?? []) addText(notice, "#fcd34d");
  if (chat.activeSkillNames.length) addText(`Active skills: ${chat.activeSkillNames.map(terminalField).join(", ")}`);
  refreshSummary();
  return {
    input, composer: layout.composer, sidebar: layout.sidebar, sidebarDivider: layout.sidebarDivider,
    picker, footerLeft: layout.footerLeft, footerRight: layout.footerRight, transcript,
    setCandidates: completion.setCandidates, setIndexError: completion.setIndexError,
    get working() { return state.working; },
    get pasting() { return clipboard.pasting; },
    get loadingSkills() { return completion!.loadingSkills; },
    get loadingCandidates() { return completion!.loadingCandidates; },
    get theme() { return { name: theme.name, mode: theme.mode }; },
  };
}
