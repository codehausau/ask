import {
  BoxRenderable, ScrollBoxRenderable, TextareaRenderable, TextRenderable, StyledText, fg, bold,
  type CliRenderer, type MouseEvent,
} from "@opentui/core";
import { terminalField } from "@codehaus-au/ask/internal/terminal";
import type { TuiSessionStats } from "./chat.ts";

export const SIDEBAR_MIN_WIDTH = 120;
export const SIDEBAR_MIN_COLUMNS = 24;
export const CHAT_MIN_COLUMNS = 60;
export const COMPOSER_PADDING = 2;
const SIDEBAR_DEFAULT_COLUMNS = 32;
const COMPOSER_BORDER_COLUMNS = 1;
const COMPOSER_INPUT_ROWS = 4;
const COMPOSER_ROWS = COMPOSER_INPUT_ROWS + 2;
const sidebarHeading = (text: string) => fg("#f8fafc")(bold(text));

export function createChatLayout(renderer: CliRenderer, model: string, cwd: string, events: {
  onSubmit(): void; onContentChange(): void; onCursorChange(): void;
}) {
  const root = new BoxRenderable(renderer, {
    width: "100%", height: "100%", flexDirection: "column", padding: 1,
    backgroundColor: "#10151d", gap: 0,
  });
  renderer.root.add(root);
  const body = new BoxRenderable(renderer, { flexDirection: "row", flexGrow: 1, minHeight: 0, gap: 2 });
  root.add(body);
  const main = new BoxRenderable(renderer, { flexDirection: "column", flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: 0, gap: 1 });
  body.add(main);
  main.add(new TextRenderable(renderer, {
    content: `ask  /  ${terminalField(model)}  ·  chat, not an agent`, fg: "#82cfff", flexShrink: 0,
  }));
  const transcript = new ScrollBoxRenderable(renderer, {
    flexGrow: 1, minHeight: 1, scrollY: true, scrollX: false,
    stickyScroll: true, stickyStart: "bottom", contentOptions: { flexDirection: "column", gap: 1 },
    verticalScrollbarOptions: { paddingLeft: 2 }, // Reserve the gap only while the scrollbar is visible.
  });
  main.add(transcript);
  const status = new TextRenderable(renderer, { content: "Ready · /help for commands", fg: "#9baac1", height: 1, flexShrink: 0, wrapMode: "none" });
  main.add(status);
  const composer = new BoxRenderable(renderer, { height: COMPOSER_ROWS, flexDirection: "column", flexShrink: 0, overflow: "visible" });
  const composerFooter = new BoxRenderable(renderer, { flexDirection: "column", flexShrink: 0, gap: 0, overflow: "visible" });
  main.add(composerFooter);
  composerFooter.add(composer);
  const cap = (id: string, glyph: string) => new TextRenderable(renderer, {
    id, content: glyph.repeat(renderer.width), width: "100%", height: 1, flexShrink: 0,
    fg: "#1b2533", bg: "#10151d", wrapMode: "none", overflow: "hidden", selectable: false,
  });
  const topCap = cap("composer-top-cap", "▄");
  const bottomCap = cap("composer-bottom-cap", "▀");
  const inputArea = new BoxRenderable(renderer, {
    id: "composer-input-area", width: "100%", height: COMPOSER_INPUT_ROWS,
    flexShrink: 0, paddingX: COMPOSER_PADDING, backgroundColor: "#1b2533",
    border: ["left"], borderColor: "#82cfff",
  });
  composer.add(topCap); composer.add(inputArea); composer.add(bottomCap);
  const picker = new BoxRenderable(renderer, {
    id: "composer-popup", position: "absolute", bottom: COMPOSER_ROWS, left: 0, width: "100%",
    zIndex: 100, visible: false, border: true, borderColor: "#82cfff",
    backgroundColor: "#1b2533", flexDirection: "column", title: "Files / folders",
  });
  const pickerMetadata = new TextRenderable(renderer, { content: "", fg: "#9baac1", height: 2, wrapMode: "none", selectable: false, visible: false });
  const pickerRows = new TextRenderable(renderer, { id: "popup-options", content: "", fg: "#82cfff", wrapMode: "none" });
  const pickerHint = new TextRenderable(renderer, { content: "↑↓ move · Enter/Tab select · Esc close", fg: "#9baac1", height: 1, wrapMode: "none" });
  picker.add(pickerMetadata); picker.add(pickerRows); picker.add(pickerHint);
  composer.add(picker);
  const sidebar = new BoxRenderable(renderer, {
    id: "session-sidebar", width: SIDEBAR_DEFAULT_COLUMNS, flexShrink: 0, flexDirection: "column", gap: 1,
    border: ["left"], borderColor: "#344256", paddingLeft: 2,
    visible: renderer.width >= SIDEBAR_MIN_WIDTH,
  });
  body.add(sidebar);
  const sidebarDivider = new BoxRenderable(renderer, {
    id: "sidebar-divider", position: "absolute", left: -1, top: 0, width: 2, height: "100%",
    zIndex: 20, border: ["left"], borderColor: "#344256",
  });
  sidebar.add(sidebarDivider);
  const summaryScroll = new ScrollBoxRenderable(renderer, { flexGrow: 1, minHeight: 1, scrollY: true, scrollX: false });
  sidebar.add(summaryScroll);
  const summary = new TextRenderable(renderer, { id: "session-summary", content: "", fg: "#cbd5e1", width: "100%", flexShrink: 0 });
  summaryScroll.add(summary);
  const sidebarCwd = new TextRenderable(renderer, {
    id: "sidebar-cwd", content: terminalField(cwd),
    fg: "#9baac1", flexShrink: 0, width: "100%", height: 1,
    wrapMode: "none", overflow: "hidden", textAlign: "right",
  });
  sidebar.add(sidebarCwd);
  const footer = new BoxRenderable(renderer, { id: "session-footer", flexDirection: "row", height: 1, flexShrink: 0, gap: 1 });
  const footerLeft = new TextRenderable(renderer, {
    content: terminalField(cwd), fg: "#9baac1", flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: 0,
    height: 1, wrapMode: "none", overflow: "hidden",
  });
  const footerRight = new TextRenderable(renderer, { content: "Tokens: —", fg: "#82cfff", height: 1, flexShrink: 0, wrapMode: "none" });
  footer.add(footerLeft); footer.add(footerRight); composerFooter.add(footer);
  const input = new TextareaRenderable(renderer, {
    id: "composer", height: COMPOSER_INPUT_ROWS, flexShrink: 0, width: "100%",
    backgroundColor: "#1b2533", focusedBackgroundColor: "#1b2533",
    textColor: "#e2e8f0", cursorColor: "#82cfff", placeholder: "Ask a question… @ to attach context",
    keyBindings: [{ name: "return", action: "submit" }, { name: "return", shift: true, action: "newline" }],
    ...events,
  });
  inputArea.add(input);
  composer.onMouseDown = (event) => {
    if (event.target === topCap || event.target === bottomCap || event.target === inputArea) {
      event.preventDefault(); input.focus();
    }
  };
  root.onMouseDown = (event) => {
    if (event.button !== 0 || event.defaultPrevented) return;
    for (let target = event.target; target; target = target.parent) {
      if (target === input || target === picker || target === sidebarDivider) return;
    }
    event.preventDefault();
    if (!renderer.getSelection()?.isDragging) renderer.clearSelection();
    input.focus();
  };
  input.focus();

  const cwdPath = terminalField(cwd);
  const cwdSegments = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(cwdPath)].map((part) => part.segment);
  function updateSidebarCwd(width: number) {
    if (input.editBuffer.measureText(cwdPath) <= width) { sidebarCwd.content = cwdPath; return; }
    let suffix = "";
    for (let index = cwdSegments.length - 1; index >= 0; index--) {
      const next = cwdSegments[index]! + suffix;
      if (input.editBuffer.measureText("…" + next) > width) break;
      suffix = next;
    }
    sidebarCwd.content = width > 0 ? "…" + suffix : "";
  }
  sidebarCwd.onSizeChange = () => updateSidebarCwd(sidebarCwd.width);
  let preferredSidebarWidth = SIDEBAR_DEFAULT_COLUMNS;
  let sidebarDrag: { x: number; width: number } | null = null;
  let dividerHovered = false;
  function clampSidebarWidth(width: number): number {
    const available = renderer.width - 4;
    const max = Math.max(SIDEBAR_MIN_COLUMNS, Math.min(Math.floor(available / 2), available - CHAT_MIN_COLUMNS - COMPOSER_PADDING * 2 - COMPOSER_BORDER_COLUMNS));
    return Math.max(SIDEBAR_MIN_COLUMNS, Math.min(max, Math.round(width)));
  }
  function layoutSidebar() {
    sidebar.visible = renderer.width >= SIDEBAR_MIN_WIDTH;
    sidebar.width = clampSidebarWidth(preferredSidebarWidth);
    updateSidebarCwd(Math.max(0, sidebar.width - 3));
  }
  function updateDividerAppearance() {
    sidebarDivider.borderColor = sidebarDrag || dividerHovered ? "#82cfff" : "#344256";
    renderer.setMousePointer(sidebarDrag || dividerHovered ? "col-resize" : "auto");
  }
  function dragSidebar(event: MouseEvent) {
    if (!sidebarDrag || !sidebar.visible) return;
    event.preventDefault(); event.stopPropagation();
    preferredSidebarWidth = clampSidebarWidth(sidebarDrag.width + sidebarDrag.x - event.x);
    layoutSidebar(); updateDividerAppearance();
  }
  function finishSidebarDrag(event: MouseEvent) {
    if (!sidebarDrag) return;
    dragSidebar(event); sidebarDrag = null; dividerHovered = false;
    updateDividerAppearance(); input.focus();
  }
  sidebarDivider.onMouseOver = () => { dividerHovered = true; updateDividerAppearance(); };
  sidebarDivider.onMouseOut = () => { dividerHovered = false; updateDividerAppearance(); };
  sidebarDivider.onMouseDown = (event) => {
    if (event.button !== 0 || !sidebar.visible) return;
    event.preventDefault(); event.stopPropagation();
    sidebarDrag = { x: event.x, width: sidebar.width }; updateDividerAppearance();
  };
  sidebarDivider.onMouseDrag = dragSidebar;
  sidebarDivider.onMouseDragEnd = finishSidebarDrag;
  sidebarDivider.onMouseUp = finishSidebarDrag;

  function refreshSummary(stats: TuiSessionStats, skillNames: readonly string[], pendingCount: number) {
    layoutSidebar();
    const number = (value: number | null) => value === null ? "unknown" : value.toLocaleString("en-US");
    const used = stats.lastInput !== null && stats.lastOutput !== null ? stats.lastInput + stats.lastOutput : null;
    const percentage = used !== null && stats.contextWindow !== null ? ` (${(used / stats.contextWindow * 100).toFixed(1)}%)` : "";
    footerRight.content = !stats.turns ? "Tokens: —" : used === null ? "Tokens: unknown" : `${(used / 1000).toFixed(1)}K tokens${percentage}`;
    const capacity = stats.contextWindow === null ? "Window limit: unknown" : `${number(stats.contextWindow)} token capacity`;
    const context = used === null ? "Usage not reported" : stats.contextWindow === null
      ? `${number(used)} tokens (last response)` : `${number(used)} / ${number(stats.contextWindow)} (${(used / stats.contextWindow * 100).toFixed(1)}%)`;
    const total = (value: number, reported: number) => reported ? `${number(value)}${reported < stats.turns ? " (partial)" : ""}` : "unknown";
    const lines = [
      sidebarHeading("Session"), terminalField(model), `${stats.turns} response(s) · ${pendingCount} pending file(s)`, "",
      sidebarHeading("Context window"), ...(!stats.turns ? ["No responses yet"] : [context]), capacity,
      sidebarHeading("Last response (input + output)"), `${number(stats.lastInput)} in / ${number(stats.lastOutput)} out`, "",
      sidebarHeading("Session totals"), `${total(stats.totalInput, stats.inputTurns)} input`, `${total(stats.totalOutput, stats.outputTurns)} output`,
      `Usage reported: ${stats.inputTurns} in / ${stats.outputTurns} out of ${stats.turns} turns`, "",
      sidebarHeading(`Skills (${skillNames.length})`), ...(skillNames.length ? skillNames.map((name) => fg("#82cfff")(`• ${terminalField(name)}`)) : ["None"]), "",
      sidebarHeading(`Files referenced (${stats.files.length})`), ...(stats.files.length ? stats.files.map((file) => fg("#82cfff")(`• ${terminalField(file)}`)) : ["None"]),
    ];
    summary.content = new StyledText(lines.map((line, index) => {
      const suffix = index < lines.length - 1 ? "\n" : "";
      return typeof line === "string" ? fg("#cbd5e1")(line + suffix) : { ...line, text: line.text + suffix };
    }));
  }

  return {
    root, transcript, status, composer, input, picker, pickerMetadata, pickerRows, pickerHint,
    sidebar, sidebarDivider, footerLeft, footerRight, refreshSummary,
    resize() {
      sidebarDrag = null; dividerHovered = false; updateDividerAppearance();
      topCap.content = "▄".repeat(renderer.width); bottomCap.content = "▀".repeat(renderer.width);
    },
  };
}
export type ChatLayout = ReturnType<typeof createChatLayout>;
