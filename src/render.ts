// Markdown → ANSI, for answers shown on a terminal.
//
// `marked` does the parsing (it has no dependencies of its own) and this module
// renders its tokens. Writing the renderer rather than taking marked-terminal
// keeps the dependency tree at two packages, which is the claim this tool makes
// about itself.
//
// Only ever applied when stdout is a terminal: `ask '...' > out.md` must stay
// byte-identical to what the model wrote.

import { marked, type Token, type Tokens } from "marked";

import type { Palette } from "./colour.ts";
import { detectLanguage, highlight } from "./highlight.ts";

export interface RenderOptions {
  readonly palette: Palette;
  /** Terminal width used for horizontal rules and table padding. */
  readonly width?: number;
}

const BULLETS = ["•", "◦", "·"] as const;

/** Render an answer for a terminal. Returns the input unchanged when plain. */
export function renderMarkdown(text: string, options: RenderOptions): string {
  if (!options.palette.enabled) return text;

  let tokens: Token[];
  try {
    tokens = marked.lexer(normaliseNestedFences(dropEmptyFences(text)));
  } catch {
    // A parse failure must never lose the answer.
    return text;
  }

  const width = options.width ?? 80;
  const rendered = renderTokens(tokens, options.palette, width, 0);
  // Blocks each end with their own blank line, which doubles up between them.
  return `${tidyBlankLines(rendered)}\n`;
}

/**
 * Remove fenced blocks that contain nothing.
 *
 * Models sometimes trail a stray empty fence pair after an answer. Left in, it
 * renders as an empty frame, and worse, it confuses the nested-fence repair
 * below, which takes the *last* fence as the closing one.
 */
export function dropEmptyFences(text: string): string {
  const lines = text.split("\n");
  const isFence = (line: string): boolean => /^\s*```/.test(line);
  const keep: boolean[] = lines.map(() => true);

  for (let index = 0; index < lines.length; index += 1) {
    if (!isFence(lines[index] ?? "")) continue;

    // Look ahead past blank lines for an immediate closing fence.
    let next = index + 1;
    while (next < lines.length && (lines[next] ?? "").trim().length === 0) next += 1;
    if (next >= lines.length || !isFence(lines[next] ?? "")) continue;

    // A fence closed by a fence with only blank lines between: an empty block.
    for (let blank = index; blank <= next; blank += 1) keep[blank] = false;
    index = next;
  }

  return lines.filter((_line, index) => keep[index]).join("\n");
}

/**
 * Repair a document-in-a-fence.
 *
 * Asked for "an example README", a model often wraps the whole file in a
 * markdown fence — and if the file itself contains fences, CommonMark ends the
 * outer block at the first inner one, spilling the rest of the document out as
 * though it were the answer's own markdown.
 *
 * Widening the outer fence to four backticks expresses what was meant. The guard
 * is tight: exactly one markdown-tagged fence, and at least one fence inside it.
 * Without inner fences the last fence *is* the closing one, so the rewrite would
 * be a no-op and is skipped.
 */
export function normaliseNestedFences(text: string): string {
  const lines = text.split("\n");
  const isMarkdownFence = (line: string): boolean => /^\s*```(?:markdown|md)\s*$/i.test(line);
  const isFence = (line: string): boolean => /^\s*```/.test(line);

  if (lines.filter(isMarkdownFence).length !== 1) return text;

  const open = lines.findIndex(isMarkdownFence);
  let close = -1;
  for (let index = lines.length - 1; index > open; index -= 1) {
    if (isFence(lines[index] ?? "")) {
      close = index;
      break;
    }
  }
  if (close === -1) return text;

  const inner = lines.slice(open + 1, close).filter((line) => isFence(line)).length;
  if (inner === 0) return text;

  lines[open] = (lines[open] ?? "").replace("```", "````");
  lines[close] = (lines[close] ?? "").replace("```", "````");
  return lines.join("\n");
}

/** At most one blank line between blocks, none at either end. */
export function tidyBlankLines(text: string): string {
  return text
    .split("\n")
    .reduce<string[]>((lines, line) => {
      const blank = line.trim().length === 0;
      const previousBlank = lines.length > 0 && (lines[lines.length - 1] ?? "").trim().length === 0;
      if (blank && (previousBlank || lines.length === 0)) return lines;
      lines.push(blank ? "" : line);
      return lines;
    }, [])
    .join("\n")
    .trimEnd();
}

function renderTokens(tokens: readonly Token[], paint: Palette, width: number, depth: number): string {
  let out = "";

  for (const token of tokens) {
    switch (token.type) {
      case "heading": {
        const heading = token as Tokens.Heading;
        const text = inline(heading.tokens ?? [], paint);
        out += heading.depth <= 2 ? `\n${paint.bold(text)}\n` : `\n${paint.bold(text)}\n`;
        break;
      }
      case "paragraph": {
        out += `${wrap(inline((token as Tokens.Paragraph).tokens ?? [], paint), width, depth)}\n\n`;
        break;
      }
      case "code": {
        const code = token as Tokens.Code;
        // An empty fence is noise: a frame around nothing tells you nothing.
        if (code.text.trim().length === 0) break;

        const language = detectLanguage(code.lang);
        const body = highlight(code.text, language, paint)
          .split("\n")
          .map((line) => `  ${line}`)
          .join("\n");
        // No label for an unlabelled fence: the frame already says "code".
        const header = code.lang ? `${paint.dim("┌─ ")}${paint.dim(code.lang)}` : paint.dim("┌─");
        out += `${header}\n${body}\n${paint.dim("└─")}\n\n`;
        break;
      }
      case "blockquote": {
        const quoted = renderTokens((token as Tokens.Blockquote).tokens ?? [], paint, width - 2, depth)
          .trimEnd()
          .split("\n")
          .map((line) => `${paint.dim("│")} ${line}`)
          .join("\n");
        out += `${quoted}\n\n`;
        break;
      }
      case "list": {
        const list = token as Tokens.List;
        let index = typeof list.start === "number" && list.start > 0 ? list.start : 1;
        for (const item of list.items) {
          const marker = list.ordered
            ? `${index}.`
            : (BULLETS[Math.min(depth, BULLETS.length - 1)] ?? "•");
          index += 1;

          const content = renderTokens(item.tokens ?? [], paint, width - 2, depth + 1).trimEnd();
          const lines = content.split("\n");
          const indent = "  ".repeat(depth);
          out += `${indent}${paint.cyan(marker)} ${lines[0] ?? ""}\n`;
          for (const line of lines.slice(1)) {
            out += `${indent}${" ".repeat(marker.length + 1)}${line}\n`;
          }
        }
        out += "\n";
        break;
      }
      case "table": {
        out += renderTable(token as Tokens.Table, paint);
        break;
      }
      case "hr": {
        out += `${paint.dim("─".repeat(Math.min(width, 60)))}\n\n`;
        break;
      }
      case "space":
        break;
      case "text": {
        const text = token as Tokens.Text;
        out += `${text.tokens ? inline(text.tokens, paint) : text.text}\n`;
        break;
      }
      default: {
        // Anything unhandled is emitted as written rather than dropped.
        const raw = (token as { raw?: string }).raw;
        if (raw) out += raw;
      }
    }
  }

  return out;
}

/** Inline styling: emphasis, code spans, links. */
function inline(tokens: readonly Token[], paint: Palette): string {
  let out = "";

  for (const token of tokens) {
    switch (token.type) {
      case "strong":
        out += paint.bold(inline((token as Tokens.Strong).tokens ?? [], paint));
        break;
      case "em":
        out += paint.cyan(inline((token as Tokens.Em).tokens ?? [], paint));
        break;
      case "codespan":
        out += paint.yellow((token as Tokens.Codespan).text);
        break;
      case "del":
        out += paint.dim(inline((token as Tokens.Del).tokens ?? [], paint));
        break;
      case "link": {
        const link = token as Tokens.Link;
        const label = inline(link.tokens ?? [], paint);
        // Keep the URL: a terminal is not a browser, and a hidden href is a
        // worse answer than a visible one.
        out += label === link.href ? paint.cyan(link.href) : `${label} ${paint.dim(`<${link.href}>`)}`;
        break;
      }
      case "br":
        out += "\n";
        break;
      case "escape":
        out += (token as Tokens.Escape).text;
        break;
      default: {
        const text = (token as { text?: string; raw?: string }).text;
        out += text ?? (token as { raw?: string }).raw ?? "";
      }
    }
  }

  return out;
}

function renderTable(table: Tokens.Table, paint: Palette): string {
  const header = table.header.map((cell) => inline(cell.tokens ?? [], paint));
  const rows = table.rows.map((row) => row.map((cell) => inline(cell.tokens ?? [], paint)));

  const widths = header.map((cell, column) =>
    Math.max(visibleLength(cell), ...rows.map((row) => visibleLength(row[column] ?? ""))),
  );

  const line = (cells: readonly string[]): string =>
    cells
      .map((cell, column) => cell + " ".repeat(Math.max(0, (widths[column] ?? 0) - visibleLength(cell))))
      .join(paint.dim("  │  "));

  let out = `${line(header.map((cell) => paint.bold(cell)))}\n`;
  out += `${paint.dim(widths.map((w) => "─".repeat(w)).join("──┼──"))}\n`;
  for (const row of rows) out += `${line(row)}\n`;
  return `${out}\n`;
}

/** Length ignoring ANSI escapes, so padding lines up. */
export function visibleLength(text: string): number {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*m/g, "").length;
}

/** Wrap to `width`, ignoring ANSI escapes when measuring. */
function wrap(text: string, width: number, depth: number): string {
  const indent = "  ".repeat(depth);
  const limit = Math.max(20, width - indent.length);
  const lines: string[] = [];

  for (const paragraph of text.split("\n")) {
    let current = "";
    for (const word of paragraph.split(/ +/)) {
      if (current.length === 0) {
        current = word;
      } else if (visibleLength(current) + 1 + visibleLength(word) <= limit) {
        current += ` ${word}`;
      } else {
        lines.push(current);
        current = word;
      }
    }
    lines.push(current);
  }

  return lines.map((line) => `${indent}${line}`).join("\n");
}
