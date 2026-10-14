// Untrusted text must be sanitised before adding the CLI's own ANSI styling.
// Documents retain their line structure; metadata must fit a single line.

const FORMAT_CONTROLS = /[\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g;
const FIELD_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g;
const JSON_CONTROLS = /[\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g;

function unicodeEscape(char: string): string {
  return `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;
}

/** Visible escapes prevent filenames, names and other fields from forging rows. */
export function terminalField(text: string): string {
  return text.replace(FIELD_CONTROLS, (char) => {
    if (char === "\n") return "\\n";
    if (char === "\r") return "\\r";
    if (char === "\t") return "\\t";
    return unicodeEscape(char);
  });
}

/** JSON.stringify already escapes C0. Escape the remainder without changing its parsed value. */
export function escapeJsonForTerminal(json: string): string {
  return json.replace(JSON_CONTROLS, unicodeEscape);
}

/**
 * Strip terminal instructions from a complete document (not streaming chunks).
 * Handles ESC and C1 forms of CSI, OSC, DCS, SOS, PM and APC, including ST/BEL
 * terminators and multi-byte ESC forms. Unterminated control strings are dropped
 * through EOF. This linear scan never leaves active control bytes in its output.
 * CRLF becomes LF; lone CR and other C0/C1 controls are dropped, except LF/tab.
 * Unicode direction/line-format controls are made visible, not executed.
 */
export function sanitizeForTerminal(text: string): string {
  let state: "text" | "escape" | "intermediate" | "csi" | "osc" | "string" = "text";
  const out: string[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    const code = text.charCodeAt(index);

    if (state === "osc" || state === "string") {
      if (code === 0x9c || (state === "osc" && code === 0x07)) {
        state = "text";
      } else if (code === 0x1b && text[index + 1] === "\\") {
        index += 1;
        state = "text";
      }
      continue;
    }

    // A new introducer restarts an incomplete escape/CSI sequence.
    if (code === 0x1b) { state = "escape"; continue; }
    if (code === 0x9b) { state = "csi"; continue; }
    if (code === 0x9d) { state = "osc"; continue; }
    if (code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) {
      state = "string";
      continue;
    }

    if (state === "escape") {
      if (char === "[") { state = "csi"; continue; }
      if (char === "]") { state = "osc"; continue; }
      if ("PX^_".includes(char)) { state = "string"; continue; }
      if (code >= 0x20 && code <= 0x2f) { state = "intermediate"; continue; }
      state = "text";
      if (code >= 0x30 && code <= 0x7e) continue;
    } else if (state === "intermediate") {
      if (code >= 0x20 && code <= 0x2f) continue;
      state = "text";
      if (code >= 0x30 && code <= 0x7e) continue;
    } else if (state === "csi") {
      if (code >= 0x40 && code <= 0x7e) { state = "text"; continue; }
      if (code <= 0x3f) continue;
      state = "text";
    }

    if (char === "\r") {
      if (text[index + 1] === "\n") { out.push("\n"); index += 1; }
      continue;
    }
    if ((code < 0x20 && char !== "\n" && char !== "\t") || (code >= 0x7f && code <= 0x9f)) continue;
    out.push(char);
  }
  return out.join("").replace(FORMAT_CONTROLS, unicodeEscape);
}
