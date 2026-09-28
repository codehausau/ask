// Terminal syntax highlighting for fenced code blocks.
//
// Deliberately shallow. A full grammar per language is what highlight.js is for,
// and pulling that in would cost this tool the "one small dependency tree" it
// relies on. Instead: comments, strings, numbers and keywords, in that
// precedence, matched once per line.
//
// The rule that keeps it safe is that every branch either styles a token or
// emits it verbatim — nothing is ever dropped or rewritten, so the worst
// possible bug is a mis-coloured word rather than mangled code.

import type { Palette } from "./colour.ts";

export type Language =
  | "ts"
  | "json"
  | "shell"
  | "yaml"
  | "xml"
  | "plain";

const TS_KEYWORDS = new Set([
  "abstract", "as", "async", "await", "break", "case", "catch", "class", "const",
  "continue", "declare", "default", "delete", "do", "else", "enum", "export",
  "extends", "finally", "for", "from", "function", "get", "if", "implements",
  "import", "in", "instanceof", "interface", "is", "keyof", "let", "new", "of",
  "private", "protected", "public", "readonly", "return", "satisfies", "set",
  "static", "super", "switch", "this", "throw", "try", "type", "typeof", "var",
  "void", "while", "yield",
]);

const TS_LITERALS = new Set(["true", "false", "null", "undefined", "NaN", "Infinity"]);

const SHELL_KEYWORDS = new Set([
  "case", "do", "done", "elif", "else", "esac", "export", "fi", "for", "function",
  "if", "in", "local", "return", "then", "while",
]);

/** Map a fence's language tag onto a highlighter. Unknown tags stay plain. */
export function detectLanguage(tag: string | undefined): Language {
  const name = (tag ?? "").trim().toLowerCase().split(/[\s:]/)[0] ?? "";
  switch (name) {
    case "ts":
    case "tsx":
    case "typescript":
    case "js":
    case "jsx":
    case "javascript":
    case "mjs":
    case "cjs":
      return "ts";
    case "json":
    case "json5":
    case "jsonc":
      return "json";
    case "sh":
    case "bash":
    case "zsh":
    case "shell":
    case "console":
    case "terminal":
      return "shell";
    case "yaml":
    case "yml":
      return "yaml";
    case "xml":
    case "html":
    case "svg":
    case "cot":
      return "xml";
    default:
      return "plain";
  }
}

interface Rule {
  readonly pattern: RegExp;
  readonly style: (palette: Palette) => (text: string) => string;
}

/**
 * Ordered rules per language. First match at a position wins, which is why
 * comments and strings come before anything that could appear inside them.
 */
const RULES: Record<Language, readonly Rule[]> = {
  ts: [
    { pattern: /^\/\/[^\n]*/, style: (p) => p.dim },
    { pattern: /^\/\*[\s\S]*?\*\//, style: (p) => p.dim },
    { pattern: /^`(?:\\.|[^`\\])*`/, style: (p) => p.yellow },
    { pattern: /^"(?:\\.|[^"\\])*"/, style: (p) => p.yellow },
    { pattern: /^'(?:\\.|[^'\\])*'/, style: (p) => p.yellow },
    { pattern: /^\b\d[\d_.]*\b/, style: (p) => p.cyan },
    { pattern: /^[A-Za-z_$][\w$]*/, style: (p) => p.bold }, // filtered below
  ],
  json: [
    { pattern: /^"(?:\\.|[^"\\])*"(?=\s*:)/, style: (p) => p.cyan },
    { pattern: /^"(?:\\.|[^"\\])*"/, style: (p) => p.yellow },
    { pattern: /^\b(?:true|false|null)\b/, style: (p) => p.bold },
    { pattern: /^-?\b\d[\d.eE+-]*\b/, style: (p) => p.cyan },
  ],
  shell: [
    { pattern: /^#[^\n]*/, style: (p) => p.dim },
    { pattern: /^"(?:\\.|[^"\\])*"/, style: (p) => p.yellow },
    { pattern: /^'[^']*'/, style: (p) => p.yellow },
    { pattern: /^\$\{?[A-Za-z_][\w]*\}?/, style: (p) => p.cyan },
    { pattern: /^--?[A-Za-z][\w-]*/, style: (p) => p.cyan },
    { pattern: /^[A-Za-z_][\w-]*/, style: (p) => p.bold }, // filtered below
  ],
  yaml: [
    { pattern: /^#[^\n]*/, style: (p) => p.dim },
    { pattern: /^[A-Za-z_][\w.-]*(?=\s*:)/, style: (p) => p.cyan },
    { pattern: /^"(?:\\.|[^"\\])*"/, style: (p) => p.yellow },
    { pattern: /^'[^']*'/, style: (p) => p.yellow },
  ],
  xml: [
    { pattern: /^<!--[\s\S]*?-->/, style: (p) => p.dim },
    { pattern: /^<\/?[A-Za-z_][\w:.-]*/, style: (p) => p.cyan },
    { pattern: /^"(?:\\.|[^"\\])*"/, style: (p) => p.yellow },
    { pattern: /^'[^']*'/, style: (p) => p.yellow },
  ],
  plain: [],
};

/** Keyword-only bolding: an identifier that is not a keyword stays unstyled. */
function styleWord(language: Language, word: string, palette: Palette): string {
  if (language === "ts") {
    if (TS_KEYWORDS.has(word)) return palette.bold(word);
    if (TS_LITERALS.has(word)) return palette.cyan(word);
    return word;
  }
  if (language === "shell") {
    return SHELL_KEYWORDS.has(word) ? palette.bold(word) : word;
  }
  return word;
}

/**
 * Highlight one code block. Returns the input unchanged for an unknown language
 * or a disabled palette, so callers never need to branch.
 */
export function highlight(code: string, language: Language, palette: Palette): string {
  if (!palette.enabled || language === "plain") return code;

  const rules = RULES[language];
  let out = "";
  let rest = code;

  while (rest.length > 0) {
    let matched = false;

    for (const rule of rules) {
      const found = rule.pattern.exec(rest);
      if (!found || found[0].length === 0) continue;

      const token = found[0];
      // The identifier rule decides for itself whether a word is a keyword.
      out += /^[A-Za-z_$]/.test(token)
        ? styleWord(language, token, palette)
        : rule.style(palette)(token);
      rest = rest.slice(token.length);
      matched = true;
      break;
    }

    if (!matched) {
      // Nothing claimed this character: emit it verbatim. This is what makes
      // the highlighter lossless.
      out += rest[0];
      rest = rest.slice(1);
    }
  }

  return out;
}
