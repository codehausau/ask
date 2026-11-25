import {
  BoxRenderable, MarkdownRenderable, SyntaxStyle, TextRenderable, StyledText,
  bold, fg, italic, strikethrough, type CliRenderer, type ScrollBoxRenderable, type TextChunk,
} from "@opentui/core";
import type { Token } from "marked";
import { sanitizeForTerminal, terminalField } from "@codehaus-au/ask/internal/terminal";
import type { UpdateView } from "@codehaus-au/ask/internal/config";
import type { TuiTheme } from "./theme.ts";
import { parseUpdateRegions, type UpdateRegion, type UpdateSummary } from "./updates.ts";
import { createUpdatePanel, type UpdateAction, type UpdateReview } from "./update-panel.ts";
import { COMPOSER_PADDING } from "./layout.ts";

/** Native inline markup, without a Tree-sitter worker/download. */
function inlineChunks(tokens: readonly Token[]): TextChunk[] {
  return tokens.flatMap((token): TextChunk[] => {
    switch (token.type) {
      case "strong": return inlineChunks(token.tokens ?? []).map(bold);
      case "em": return inlineChunks(token.tokens ?? []).map(italic);
      case "del": return inlineChunks(token.tokens ?? []).map(strikethrough);
      case "codespan": return [fg("#a7f3d0")(String(token.text))];
      case "link": return [...inlineChunks(token.tokens ?? []), fg("#9baac1")(` (${String(token.href)})`)];
      case "image": return [fg("#9baac1")(`${String(token.text)} (${String(token.href)})`)];
      case "br": return [fg("#e2e8f0")("\n")];
      case "text": return token.tokens ? inlineChunks(token.tokens) : [fg("#e2e8f0")(String(token.text))];
      default: return [fg("#e2e8f0")(token.raw)];
    }
  });
}

export function createTranscript(renderer: CliRenderer, transcript: ScrollBoxRenderable, theme: TuiTheme, updateView: UpdateView = "diff") {
  let serial = 0;
  const markdownText = new Set<TextRenderable>();
  const caps: { text: TextRenderable; glyph: string }[] = [];
  const updatePanels = new Map<string, ReturnType<typeof createUpdatePanel>[]>();
  const reviews = new Map<string, UpdateReview>();
  const style = SyntaxStyle.fromStyles({
    default: { fg: theme.palette.text },
    "markup.heading": { fg: theme.palette.accent, bold: true },
    "markup.strong": { bold: true },
    "markup.raw": { fg: theme.palette.code },
  }, renderer.nativeScene);

  function addText(content: string, color = "#9baac1") {
    transcript.add(new TextRenderable(renderer, {
      id: `message-${serial++}`, content: sanitizeForTerminal(content), fg: color, width: "100%", flexShrink: 0, selectable: true,
    }));
  }

  function cap(id: string, glyph: string) {
    const text = new TextRenderable(renderer, {
      id, content: glyph.repeat(renderer.width), width: "100%", height: 1, flexShrink: 0,
      fg: "#1b2533", bg: "#10151d", wrapMode: "none", overflow: "hidden", selectable: false,
    });
    caps.push({ text, glyph });
    return text;
  }

  function addUserMessage(content: string) {
    const id = `user-${serial++}`;
    const message = new BoxRenderable(renderer, { id, width: "100%", flexDirection: "column", flexShrink: 0 });
    const panel = new BoxRenderable(renderer, {
      id: `${id}-body`, width: "100%", flexShrink: 0,
      backgroundColor: "#1b2533", border: ["left"], borderColor: "#82cfff", paddingX: COMPOSER_PADDING,
    });
    panel.add(new TextRenderable(renderer, {
      content: sanitizeForTerminal(content), fg: "#e2e8f0", width: "100%", flexShrink: 0, selectable: true,
    }));
    message.add(cap(`${id}-top-cap`, "▄"));
    message.add(panel);
    message.add(cap(`${id}-bottom-cap`, "▀"));
    transcript.add(message);
  }

  function addMarkdown(content: string) {
    transcript.add(new MarkdownRenderable(renderer, {
      id: `answer-${serial++}`, content: sanitizeForTerminal(content), syntaxStyle: style,
      width: "100%", flexShrink: 0, conceal: true, internalBlockMode: "top-level",
      // Override every block: even default paragraphs can load Tree-sitter.
      renderNode: (token) => {
        const chunks = token.type === "paragraph" || token.type === "heading" ? inlineChunks(token.tokens ?? []) : null;
        const text = new TextRenderable(renderer, {
          content: chunks ? new StyledText(token.type === "heading" ? chunks.map((chunk) => fg("#82cfff")(bold(chunk))) : chunks)
            : sanitizeForTerminal(token.type === "code" ? String(token.text) : token.raw.replace(/\n+$/, "")),
          fg: token.type === "code" ? "#a7f3d0" : "#e2e8f0", width: "100%", flexShrink: 0, selectable: true,
        });
        markdownText.add(text);
        theme.paint(text);
        return text;
      },
    }));
  }

  function addAnswer(content: string, previews: readonly UpdateReview[], action: (action: UpdateAction, path: string) => void) {
    for (const panels of updatePanels.values()) for (const panel of panels) panel.sync(undefined);
    updatePanels.clear(); reviews.clear();
    let regions: UpdateRegion[];
    try { regions = parseUpdateRegions(content); }
    catch { addMarkdown(content); return; }
    if (!regions.length) { addMarkdown(content); return; }
    const lines = content.replace(/\r\n/g, "\n").split("\n");
    const byPath = new Map(previews.map((preview) => [preview.path, preview]));
    let start = 0;
    for (const region of regions) {
      const prose = lines.slice(start, region.startLine).join("\n");
      if (prose.trim()) addMarkdown(prose);
      const raw = lines.slice(region.startLine, region.endLine).join("\n");
      const panel = createUpdatePanel(renderer, `update-${serial++}`, region.block, raw, updateView, byPath.get(region.block.path), (name) => action(name, region.block.path));
      const panels = updatePanels.get(region.block.path) ?? [];
      panels.push(panel); updatePanels.set(region.block.path, panels);
      transcript.add(panel.node);
      start = region.endLine;
    }
    const prose = lines.slice(start).join("\n");
    if (prose.trim()) addMarkdown(prose);
  }

  /** What the model proposed, before any diff is shown. Nothing is written yet. */
  function proposals(summary: readonly UpdateSummary[]) {
    const rows = summary.map((file) =>
      `  ${terminalField(file.path)}  +${file.added} -${file.removed}${file.sensitive ? `  ⚠ ${file.sensitive}` : ""}`);
    const sensitive = summary.filter((file) => file.sensitive).length;
    addText([
      `Proposed edits to ${summary.length} file(s); nothing has been written:`, ...rows,
      ...(sensitive ? [`⚠ ${sensitive} file(s) can run code or change automation. Read those diffs closely.`] : []),
      "Run /review to see the diffs, then /apply (all) or /apply <path>. /reject discards.",
    ].join("\n"), sensitive ? "#fda4af" : "#fcd34d");
  }

  function review(diffs: readonly UpdateReview[], inline = false) {
    for (const detail of diffs) reviews.set(detail.path, detail);
    if (inline) return;
    for (const { diff, sensitive } of diffs) {
      const panel = new BoxRenderable(renderer, { flexDirection: "column", width: "100%", flexShrink: 0 });
      if (sensitive) {
        panel.add(new TextRenderable(renderer, {
          content: `⚠ ${sensitive}: this file can run code or change automation`, fg: "#fda4af", flexShrink: 0, selectable: true,
        }));
      }
      for (const line of diff.split("\n")) {
        panel.add(new TextRenderable(renderer, {
          // Approval must expose every byte, not remove escape-string payloads.
          content: terminalField(line), flexShrink: 0, selectable: true,
          fg: line.startsWith("+") ? "#a7f3d0" : line.startsWith("-") ? "#fda4af" : "#cbd5e1",
        }));
      }
      transcript.add(panel);
    }
    addText("Review the proposed diffs above. Control characters are shown as escapes. /apply writes every reviewed file, or /apply <path> just one; /reject [path] discards.\nMultiple files are written individually, not as an all-or-nothing transaction.", "#fcd34d");
  }

  function clear() {
    updatePanels.clear(); reviews.clear();
    renderer.clearSelection();
    for (const child of [...transcript.getChildren()]) {
      transcript.remove(child);
      child.destroyRecursively();
    }
    // Markdown owns native blocks that getChildren() does not expose.
    for (const text of markdownText) if (!text.isDestroyed) text.destroyRecursively();
    markdownText.clear();
    caps.length = 0;
    transcript.scrollTo(0);
  }

  return {
    addText, addUserMessage, addAnswer, proposals, review, clear,
    rejected(paths: readonly string[]) {
      for (const path of paths) for (const panel of updatePanels.get(path) ?? []) panel.reject();
    },
    applied(paths: readonly string[]) {
      for (const path of paths) for (const panel of updatePanels.get(path) ?? []) panel.apply();
    },
    syncUpdates(pending: readonly { path: string; reviewed: boolean }[], working: boolean) {
      const byPath = new Map(pending.map((file) => [file.path, file]));
      for (const [path, panels] of updatePanels) {
        const file = byPath.get(path);
        if (!file?.reviewed) reviews.delete(path);
        const review = reviews.get(path);
        for (const panel of panels) panel.sync(file ? { working, ...(review ? { review } : {}) } : undefined);
      }
    },
    paintTheme() {
      for (const text of markdownText) {
        if (text.isDestroyed) markdownText.delete(text); else theme.paint(text);
      }
    },
    updateStyle() {
      style.registerStyle("default", { fg: theme.palette.text });
      style.registerStyle("markup.heading", { fg: theme.palette.accent, bold: true });
      style.registerStyle("markup.raw", { fg: theme.palette.code });
    },
    resize() { for (const { text, glyph } of caps) text.content = glyph.repeat(renderer.width); },
    dispose() { markdownText.clear(); caps.length = 0; updatePanels.clear(); reviews.clear(); style.destroy(); },
  };
}
