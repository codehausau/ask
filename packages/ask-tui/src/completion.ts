import { StyledText, bg, fg, type CliRenderer, type KeyEvent } from "@opentui/core";
import { rankMatch } from "@codehaus-au/ask/internal/refs";
import { terminalField } from "@codehaus-au/ask/internal/terminal";
import type { SkillSummary } from "@codehaus-au/ask/internal/skills";
import type { TuiChat } from "./chat.ts";
import type { ChatLayout } from "./layout.ts";
import type { TuiTheme } from "./theme.ts";
import { THEME_NAMES, themeDescription, themeModes, type ThemeMode } from "./themes.ts";
import { activeMention, serializeMention } from "./mentions.ts";
import { filterPopupItems, isFileCandidateVisible, SLASH_COMMANDS, type PopupItem } from "./picker.ts";

export type ManagerMode = "context" | "attach" | "detach" | "unskill" | "skill" | "skills" | "theme";
export interface UIState { working: boolean; alive: boolean }

/** Composer popups own their selection, async catalogs and temporary previews. */
export function createCompletion(renderer: CliRenderer, chat: TuiChat, layout: ChatLayout, theme: TuiTheme, state: UIState, actions: {
  submit(): Promise<void>; refreshSummary(): void; applyTheme(name: string, mode: ThemeMode): void;
  /** A confirmed choice, not a preview: the UI saves it as the default. */
  themeChosen(name: string, mode: ThemeMode): void;
  addText(text: string, color?: string): void;
  loadCandidates?: () => Promise<{ readonly paths: readonly string[]; readonly truncated: boolean }>;
}) {
  const { input, status, picker, pickerMetadata, pickerRows, pickerHint } = layout;
  let candidates: readonly string[] = [];
  let matches: PopupItem[] = [];
  let mode: "mention" | "commands" | "detach" | "unskill" | "context" | "skills" | "files" | "themes" = "mention";
  let pickerPrefix = "";
  let skillCatalog: readonly SkillSummary[] = [];
  let skillsReady = false;
  let loadingSkills = false;
  let skillLoadId = 0;
  let skillLoadError = "";
  let selected = 0;
  let dismissedAt = "";
  let themeBeforePreview: { name: string; mode: ThemeMode } | null = null;
  let pickerError = "";
  let candidatesReady = false;
  let loadingCandidates = false;
  const mention = () => activeMention(input.editBuffer.getTextRange(0, input.cursorOffset));

  function setCandidates(paths: readonly string[], truncated = false) {
    if (!state.alive) return;
    candidatesReady = true;
    candidates = paths; pickerError = truncated ? "Index capped; type an exact path for missing files." : "";
    if (truncated) actions.addText("Mention index reached its cap; exact @paths still work.", "#fcd34d");
    refresh();
  }
  function setIndexError(message: string) {
    if (!state.alive) return;
    candidatesReady = true; pickerError = terminalField(message); refresh();
  }
  async function loadCandidates() {
    if (loadingCandidates || candidatesReady || !actions.loadCandidates) return;
    loadingCandidates = true;
    try {
      const index = await actions.loadCandidates();
      if (state.alive) setCandidates(index.paths, index.truncated);
    } catch (error) {
      if (state.alive) setIndexError(`Mention index unavailable: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      loadingCandidates = false;
      if (state.alive) refresh();
    }
  }

  function contextItems(kind: "context" | "detach" | "unskill"): PopupItem[] {
    const items: PopupItem[] = [];
    if (kind !== "unskill") {
      const references = new Set(chat.attachmentPaths);
      for (const value of references) items.push({ kind: "detach", value, label: `@${value}`, description: "Remove reference" });
      for (const value of chat.sessionStats.files) {
        if (!references.has(value)) items.push({ kind: "detach", value, label: value, description: "Exclude file from folder context" });
      }
    }
    if (kind !== "detach") {
      for (const value of chat.activeSkillNames) items.push({ kind: "unskill", value, label: value, description: "Remove skill" });
    }
    if (kind === "context") {
      for (const value of chat.excludedFilePaths) items.push({ kind: "restore", value, label: value, description: "Restore excluded file" });
      items.push({ kind: "open-skills", value: "add-skills", label: "Add skills…", description: "Open skill selector" });
      items.push({ kind: "open-files", value: "add-files", label: "Add files…", description: "Open file/folder selector" });
    }
    return items;
  }
  function fileIsAttached(value: string) {
    const name = value.replace(/\/$/, "");
    return chat.attachmentPaths.includes(name) || chat.sessionStats.files.includes(name);
  }
  function invalidateSkills() { skillLoadId++; skillsReady = false; loadingSkills = false; skillLoadError = ""; }
  async function loadSkillCatalog() {
    if (loadingSkills || skillsReady) return;
    loadingSkills = true;
    const id = ++skillLoadId;
    try {
      const catalog = await chat.availableSkills();
      if (!state.alive || id !== skillLoadId) return;
      skillCatalog = catalog;
    } catch (error) {
      if (!state.alive || id !== skillLoadId) return;
      skillCatalog = []; skillLoadError = terminalField(error instanceof Error ? error.message : String(error));
    } finally {
      if (state.alive && id === skillLoadId) { loadingSkills = false; skillsReady = true; refresh(); }
    }
  }
  function cancelThemePreview() {
    if (!themeBeforePreview) return;
    const previous = themeBeforePreview;
    themeBeforePreview = null;
    actions.applyTheme(previous.name, previous.mode);
  }

  function refresh() {
    if (!state.alive) return;
    const prefix = input.editBuffer.getTextRange(0, input.cursorOffset);
    if (state.working || prefix === dismissedAt) { cancelThemePreview(); matches = []; picker.visible = false; return; }
    const previous = matches[selected];
    const oldMode = mode;
    const command = prefix === input.plainText ? /^\/(attach|detach|unskill|context|skills?|theme)\s+([^\n]*)$/.exec(prefix) : null;
    if (command?.[1] !== "theme") cancelThemePreview();
    let startingThemePicker = false;
    if (command) {
      const query = command[2]!.trim().replace(/^@/, "").replace(/^["']/, "").replace(/["']$/, "");
      if (command[1] === "theme") {
        mode = "themes"; startingThemePicker = themeBeforePreview === null;
        themeBeforePreview ??= { name: theme.name, mode: theme.mode };
        matches = filterPopupItems(THEME_NAMES.flatMap((name): PopupItem[] => themeModes(name).map((variant) => ({
          kind: "theme", value: `${name} ${variant}`, label: `${themeBeforePreview!.name === name && themeBeforePreview!.mode === variant ? "✓ " : "  "}${name} · ${variant}`,
          description: themeDescription(name),
        }))), query);
      } else if (command[1] === "skill" || command[1] === "skills") {
        mode = "skills"; void loadSkillCatalog();
        matches = filterPopupItems((skillsReady ? skillCatalog : []).map((skill) => {
          const active = chat.activeSkillNames.includes(skill.name);
          return { kind: "skill", value: skill.name, label: `${active ? "✓ " : "  "}${skill.name}`, description: `${active ? "Active · " : ""}${skill.description}` };
        }), query);
      } else if (command[1] === "attach") {
        mode = "files";
        void loadCandidates();
        matches = filterPopupItems(candidates.filter((value) => isFileCandidateVisible(value, query)).map((value) => {
          const attached = fileIsAttached(value);
          return { kind: "attach", value, label: `${attached ? "✓ " : "  "}${value}`, description: attached ? "Attached · select to detach" : value.endsWith("/") ? "Attach folder" : "Attach file" };
        }), query);
      } else {
        mode = command[1] as "detach" | "unskill" | "context";
        matches = filterPopupItems(contextItems(mode), query);
        if (mode === "context") {
          const order = (item: PopupItem) => item.kind === "unskill" ? 0 : item.kind === "open-skills" ? 1 : item.kind === "open-files" ? 3 : 2;
          matches.sort((a, b) => order(a) - order(b));
        }
      }
    } else if (prefix === input.plainText && /^\/[^\n]*$/.test(prefix) &&
      (!prefix.includes(" ") || !SLASH_COMMANDS.some((entry) => prefix.startsWith(entry.value + " ")))) {
      mode = "commands";
      matches = filterPopupItems(SLASH_COMMANDS.map((entry) => ({ kind: "command", value: entry.value, label: entry.value, description: entry.description })), prefix.slice(1));
    } else {
      const current = mention();
      if (!current) { matches = []; picker.visible = false; return; }
      mode = "mention";
      void loadCandidates();
      matches = candidates.filter((candidate) => isFileCandidateVisible(candidate, current.query))
        .map((candidate) => ({ candidate, rank: current.query ? rankMatch(candidate.replace(/\/$/, ""), current.query) : 0 }))
        .filter((item) => item.rank !== null)
        .sort((a, b) => a.rank! - b.rank! || a.candidate.length - b.candidate.length || a.candidate.localeCompare(b.candidate))
        .map(({ candidate }) => ({ kind: "mention", value: candidate, label: candidate, description: "" }));
    }
    const sameQuery = oldMode === mode && pickerPrefix === prefix;
    pickerPrefix = prefix;
    const kept = sameQuery && previous ? matches.findIndex((item) => item.kind === previous.kind && item.value === previous.value) : -1;
    selected = kept >= 0 ? kept : sameQuery ? Math.max(0, Math.min(selected, matches.length - 1)) : 0;
    if (startingThemePicker && command?.[2]?.trim() === "") {
      const current = matches.findIndex((item) => item.value === `${themeBeforePreview!.name} ${themeBeforePreview!.mode}`);
      if (current >= 0) selected = current;
    }
    paint(); picker.visible = true;
  }

  function paint() {
    if (mode === "themes" && themeBeforePreview) {
      const choice = matches[selected];
      if (choice) {
        const [name, variant] = choice.value.split(" "); actions.applyTheme(name!, variant as ThemeMode);
      } else actions.applyTheme(themeBeforePreview.name, themeBeforePreview.mode);
    }
    const metadataRows = mode === "context" ? 2 : 0;
    pickerMetadata.visible = metadataRows > 0;
    if (metadataRows) pickerMetadata.content = `Working directory: ${terminalField(chat.sessionStats.cwd)}\nSession: ${chat.sessionStats.turns} response(s) · ${chat.pendingCount} pending file(s)`;
    const count = Math.max(1, Math.min(7, renderer.height - 14 - metadataRows - (mode === "context" ? 4 : 0)));
    const start = Math.max(0, selected - count + 1);
    const visible = matches.slice(start, start + count);
    const renderItem = (item: PopupItem) => `${item === matches[selected] ? "›" : " "} ${terminalField(item.label)}${item.description ? `  ${terminalField(item.description)}` : ""}`;
    const hasFiles = chat.attachmentPaths.length > 0 || chat.sessionStats.files.length > 0;
    let rows: string[];
    if (mode === "context") {
      const skillRow = (item: PopupItem) => item.kind === "unskill" || item.kind === "open-skills";
      const skills = visible.filter(skillRow);
      const files = visible.filter((item) => !skillRow(item));
      rows = [
        "Skills", ...(!chat.activeSkillNames.length ? ["  No skills attached."] : []), ...skills.map(renderItem),
        ...(chat.activeSkillNames.length && !skills.some((item) => item.kind === "unskill")
          ? [matches.some((item) => item.kind === "unskill") ? "  … more skills (↑/↓)" : "  No matching skills."] : []),
        "Files", ...(!hasFiles ? ["  No files attached."] : []), ...files.map(renderItem),
        ...(hasFiles && !files.some((item) => item.kind === "detach")
          ? [matches.some((item) => item.kind === "detach") ? "  … more files (↑/↓)" : "  No matching files."] : []),
      ];
    } else rows = matches.length ? visible.map(renderItem)
      : [mode === "mention" ? loadingCandidates ? "Loading files/folders…" : pickerError || "No indexed matches; you can still type an exact @path."
        : mode === "skills" ? loadingSkills ? "Loading skills…" : skillLoadError || "No matching skills."
          : mode === "unskill" ? chat.activeSkillNames.length ? "No matching skills." : "No skills attached."
            : mode === "detach" ? hasFiles ? "No matching files." : "No files attached."
              : mode === "files" ? loadingCandidates ? "Loading files/folders…" : pickerError || "No matching files/folders."
                : mode === "themes" ? "No matching themes." : "No matching commands."];
    const actionRows = new Set(visible.map(renderItem));
    const selectedRow = matches[selected] ? renderItem(matches[selected]!) : undefined;
    pickerRows.content = new StyledText(rows.flatMap((row, index) => {
      // Original ask colors bind to theme roles in TuiTheme.paint(), so the
      // accent background and contrasting text follow live theme previews.
      const chunk = row === selectedRow
        ? bg("#82cfff")(fg("#10151d")(row))
        : fg(actionRows.has(row) ? "#82cfff" : "#e2e8f0")(row);
      // Keep the newline outside the background span.
      return index < rows.length - 1 ? [chunk, fg("#e2e8f0")("\n")] : [chunk];
    }));
    picker.title = { mention: "Files / folders", commands: "Commands", detach: "Detach files / folders", unskill: "Remove skills", context: "Manage context", skills: "Select skills", files: "Select files / folders", themes: "Select theme" }[mode];
    pickerHint.content = mode === "mention" ? "↑↓ move · Enter/Tab select · Esc close"
      : mode === "commands" ? "↑↓ move · Enter run · Tab complete · Esc close"
        : mode === "themes" ? "↑↓ preview · Enter/Tab keep · ✓ current · Esc cancel"
          : mode === "skills" ? "↑↓ move · Enter toggle · ✓ active · type to filter · Esc close"
            : mode === "files" ? "↑↓ move · Enter/Tab toggle · ✓ attached · type to filter · Esc close" : "↑↓ move · Enter action · type to filter · Esc close";
    picker.height = mode === "context" ? rows.length + 3 + metadataRows : (visible.length || 1) + 3;
  }

  function completeMention() {
    const current = mention();
    const candidate = matches[selected];
    if (!current || !candidate) return;
    const quoted = serializeMention(candidate.value.replace(/\/$/, ""));
    if (quoted === null) { status.content = "This filename cannot be represented as a mention; attach it through /attach."; return; }
    const start = input.editBuffer.measureText(current.prefix.slice(0, current.start));
    input.setSelection(start, input.cursorOffset); input.insertText(`${quoted} `);
    dismissedAt = ""; refresh();
  }
  function openManager(kind: ManagerMode, query = "") {
    if (kind === "skill" || kind === "skills") invalidateSkills();
    input.setText(`/${kind} ${query}`); input.gotoBufferEnd(); dismissedAt = ""; refresh();
  }
  async function toggle(item: PopupItem) {
    if (state.working) return;
    state.working = true;
    try {
      let message: string;
      if (item.kind === "skill") {
        const active = chat.activeSkillNames.includes(item.value);
        if (active) chat.removeSkill(item.value); else await chat.selectSkills([item.value]);
        message = `${active ? "Disabled" : "Enabled"} skill ${terminalField(item.value)}. Instructions only; no scripts are executed.`;
      } else if (fileIsAttached(item.value)) {
        chat.detach(item.value.replace(/\/$/, "")); message = `Detached ${terminalField(item.value)} from future file context.`;
      } else {
        const context = await chat.attach(item.value.replace(/\/$/, ""));
        message = `Attached ${terminalField(item.value)} · ${context.blocks.length} file(s) · ${context.skipped.length} skipped${context.truncated ? " · context truncated" : ""}`;
      }
      if (state.alive) status.content = message;
    } catch (error) {
      if (state.alive) status.content = terminalField(error instanceof Error ? error.message : String(error));
    } finally {
      state.working = false;
      if (state.alive) { actions.refreshSummary(); refresh(); }
    }
  }
  function accept(run: boolean) {
    if (state.working) return;
    const item = matches[selected];
    if (!item) return;
    if (item.kind === "mention") { completeMention(); return; }
    if (item.kind === "command") {
      if (["/context", "/attach", "/detach", "/unskill", "/skill", "/skills", "/theme"].includes(item.value)) {
        openManager(item.value.slice(1) as ManagerMode); return;
      }
      input.setText(item.value + (run ? "" : " ")); input.gotoBufferEnd();
      if (run) void actions.submit(); else { dismissedAt = input.plainText; picker.visible = false; }
      return;
    }
    if (item.kind === "attach") { void toggle(item); return; }
    if (item.kind === "theme") {
      const [name, variant] = item.value.split(" ");
      themeBeforePreview = null; actions.applyTheme(name!, variant as ThemeMode);
      input.setText(""); dismissedAt = ""; picker.visible = false; matches = [];
      actions.themeChosen(name!, variant as ThemeMode); input.focus(); return;
    }
    if (!run) return;
    if (item.kind === "open-skills") { openManager("skills"); return; }
    if (item.kind === "open-files") { openManager("attach"); return; }
    if (item.kind === "skill") { void toggle(item); return; }
    try {
      if (item.kind === "detach") { chat.detach(item.value); status.content = `Removed ${terminalField(item.value)} from future file context.`; }
      else if (item.kind === "unskill") { chat.removeSkill(item.value); status.content = `Removed skill ${terminalField(item.value)}.`; }
      else if (item.kind === "restore") { chat.restoreFile(item.value); status.content = `Restored ${terminalField(item.value)} for the next request.`; }
      actions.refreshSummary(); refresh();
    } catch (error) { status.content = terminalField(error instanceof Error ? error.message : String(error)); }
  }

  picker.onMouseScroll = (event) => {
    if (state.working || !picker.visible || mode !== "themes" || !matches.length) return;
    const direction = event.scroll?.direction;
    if (direction !== "up" && direction !== "down") return;
    event.preventDefault(); event.stopPropagation();
    selected = Math.max(0, Math.min(matches.length - 1, selected + (direction === "up" ? -1 : 1))); paint();
  };
  return {
    refresh, openManager,
    contentChanged() { dismissedAt = ""; refresh(); },
    get loadingSkills() { return loadingSkills; },
    get loadingCandidates() { return loadingCandidates; },
    handleKey(key: KeyEvent) {
      if (!state.working && key.sequence === "@" && dismissedAt && mention()?.prefix === dismissedAt) {
        key.preventDefault(); dismissedAt = ""; refresh(); return;
      }
      if (["return", "tab", "up", "down", "escape"].includes(key.name)) refresh();
      if (!picker.visible) return;
      const manager = mode !== "mention" && mode !== "commands";
      if (!matches.length && key.name === "return" && !key.shift && manager) { key.preventDefault(); return; }
      if (key.name === "escape") {
        key.preventDefault();
        if (mode === "skills") invalidateSkills();
        if (mode === "themes") cancelThemePreview();
        if (manager) input.setText("");
        dismissedAt = input.editBuffer.getTextRange(0, input.cursorOffset); picker.visible = false; matches = [];
      } else if (matches.length && (key.name === "up" || key.name === "down")) {
        key.preventDefault(); selected = (selected + (key.name === "up" ? -1 : 1) + matches.length) % matches.length; paint();
      } else if (matches.length && (key.name === "tab" || (key.name === "return" && !key.shift && !key.ctrl && !key.meta))) {
        key.preventDefault(); accept(key.name === "return");
      }
    },
    setCandidates, setIndexError,
    dispose() { invalidateSkills(); skillCatalog = []; candidates = []; matches = []; },
  };
}
