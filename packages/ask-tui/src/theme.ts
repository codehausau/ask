import {
  BoxRenderable, TextRenderable, TextareaRenderable, ScrollBoxRenderable, StyledText, parseColor,
  type Renderable, type RGBA, type TextChunk,
} from "@opentui/core";
import { ASK_PALETTE, themePalette, type ThemeMode, type ThemePalette, type ThemeRole } from "./themes.ts";

const roles = new Map(Object.entries(ASK_PALETTE).map(([role, color]) => [color.toLowerCase(), role as ThemeRole]));
function hex(color: RGBA | undefined): string | undefined {
  if (!color) return undefined;
  const [r, g, b, a] = color.toInts();
  if (a !== 255) return undefined;
  return "#" + [r, g, b].map((part) => part!.toString(16).padStart(2, "0")).join("");
}
interface Slot {
  get(): RGBA | undefined;
  set(value: string): void;
  role?: ThemeRole | undefined;
  last?: string | undefined;
}
interface TextState {
  content: StyledText;
  source: { chunk: TextChunk; fg?: ThemeRole | undefined; bg?: ThemeRole | undefined }[];
  version: number;
}

/** Bind the UI's original ask colors to semantic roles once, retaining those
 * bindings across switches even when a theme uses the same color for many roles.
 * New transcript nodes and newly assigned StyledText are picked up on refresh.
 */
export class TuiTheme {
  name = "ask";
  mode: ThemeMode = "dark";
  palette: ThemePalette = ASK_PALETTE;
  private version = 0;
  private slots = new WeakMap<Renderable, Slot[]>();
  private text = new WeakMap<TextRenderable, TextState>();
  private specialVersion = new WeakMap<Renderable, number>();

  select(name: string, mode: ThemeMode) {
    const palette = themePalette(name, mode);
    this.name = name;
    this.mode = mode;
    this.palette = palette;
    this.version++;
  }

  paint(node: Renderable): void {
    let slots = this.slots.get(node);
    if (!slots) {
      slots = [];
      if (node instanceof BoxRenderable) slots.push(
        { get: () => node.backgroundColor, set: (value) => { node.backgroundColor = value; } },
        { get: () => node.borderColor, set: (value) => { node.borderColor = value; } },
      );
      if (node instanceof TextRenderable) slots.push(
        { get: () => node.fg, set: (value) => { node.fg = value; } },
        { get: () => node.bg, set: (value) => { node.bg = value; } },
      );
      this.slots.set(node, slots);
    }
    for (const slot of slots) {
      const current = hex(slot.get());
      if (current !== slot.last) slot.role = current ? roles.get(current) : undefined;
      if (slot.role) {
        const next = this.palette[slot.role];
        if (!slot.get()?.equals(parseColor(next))) slot.set(next);
        slot.last = hex(slot.get());
      } else slot.last = current;
    }
    if (node instanceof TextRenderable) {
      let state = this.text.get(node);
      if (!state || state.content !== node.content) {
        state = {
          content: node.content, version: -1,
          source: node.chunks.map((chunk) => ({ chunk, fg: roles.get(hex(chunk.fg) ?? ""), bg: roles.get(hex(chunk.bg) ?? "") })),
        };
        this.text.set(node, state);
      }
      if (state.version !== this.version) {
        if (state.source.some((part) => part.fg || part.bg)) {
          node.content = new StyledText(state.source.map(({ chunk, fg, bg }) => ({
            ...chunk,
            ...(fg ? { fg: parseColor(this.palette[fg]) } : {}),
            ...(bg ? { bg: parseColor(this.palette[bg]) } : {}),
          })));
          state.content = node.content;
        }
        state.version = this.version;
      }
    }
    if (this.specialVersion.get(node) !== this.version) {
      if (node instanceof TextareaRenderable) {
        node.backgroundColor = this.palette.panel;
        node.focusedBackgroundColor = this.palette.panel;
        node.textColor = this.palette.text;
        node.focusedTextColor = this.palette.text;
        node.cursorColor = this.palette.accent;
        node.placeholderColor = this.palette.muted;
        node.selectionBg = this.palette.selectionBg ?? this.palette.accent;
        node.selectionFg = this.palette.selectionFg ?? this.palette.background;
      }
      if (node instanceof TextRenderable) {
        node.selectionBg = this.palette.selectionBg ?? this.palette.accent;
        node.selectionFg = this.palette.selectionFg ?? this.palette.background;
      }
      if (node instanceof ScrollBoxRenderable) {
        for (const bar of [node.verticalScrollBar, node.horizontalScrollBar]) {
          bar.trackOptions = { foregroundColor: this.palette.border, backgroundColor: this.palette.background };
        }
      }
      this.specialVersion.set(node, this.version);
    }
    for (const child of node.getChildren()) this.paint(child);
  }
}
