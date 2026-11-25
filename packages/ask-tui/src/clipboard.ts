import { createHostClipboard, PasteEvent, type CliRenderer, type HostClipboardService, type TextareaRenderable, type TextRenderable } from "@opentui/core";
import { sanitizeForTerminal } from "@codehaus-au/ask/internal/terminal";

const MAX_PASTE_BYTES = 1024 * 1024;

export type ClipboardFactory = () => Pick<HostClipboardService, "read" | "dispose">;

/** User-triggered clipboard I/O, scoped to the lifetime and draft of one UI. */
export function createClipboardController(
  renderer: CliRenderer, input: TextareaRenderable, status: TextRenderable,
  createClipboard?: ClipboardFactory,
) {
  let alive = true;
  let pasting = false;
  let draftEpoch = 0;
  let clipboard: ReturnType<ClipboardFactory> | undefined;
  const lifetime = new AbortController();

  function selectedText(): string {
    const draftSelection = input.getSelectedText();
    return (input.focused && draftSelection) || renderer.getSelection()?.getSelectedText() || draftSelection;
  }

  function copyText(text: string | null) {
    if (!text) { status.content = "Nothing to copy. Select text or receive an answer first."; input.focus(); return; }
    const sent = renderer.copyToClipboardOSC52(sanitizeForTerminal(text));
    status.content = sent ? "Copy sent to terminal clipboard (OSC52)" : "Clipboard unavailable. Use Shift+drag or restart with --no-mouse for terminal selection.";
    input.focus();
  }

  function insertPaste(event: PasteEvent) {
    if (!alive) return;
    if (event.metadata?.kind === "binary" || event.bytes.byteLength > MAX_PASTE_BYTES) {
      status.content = "Paste refused: only text up to 1 MiB is supported."; return;
    }
    if (!event.bytes.byteLength) { status.content = "Clipboard is empty."; return; }
    input.focus();
    // Native ANSI stripping; newlines are buffer data, never submission events.
    input.handlePaste(event);
    status.content = "Pasted clipboard text.";
  }

  async function pasteText() {
    if (!alive || pasting) return;
    if (renderer.capabilities?.remote || process.env["SSH_CONNECTION"] || process.env["SSH_TTY"]) {
      status.content = "Remote session: use your terminal's native paste (Command+V or Ctrl+Shift+V).";
      input.focus(); return;
    }
    input.focus();
    const epoch = draftEpoch;
    const draft = input.plainText;
    const cursor = input.cursorOffset;
    const selection = JSON.stringify(input.getSelection());
    pasting = true;
    try {
      clipboard ??= createClipboard?.() ?? createHostClipboard({ maxReadBytes: MAX_PASTE_BYTES, timeoutMs: 2000 });
      const result = await clipboard.read({ preferredTypes: ["text/plain;charset=utf-8", "text/plain"], signal: lifetime.signal });
      if (!alive) return;
      if (result.status !== "read") {
        status.content = result.status === "empty" ? "Clipboard is empty." : `Paste unavailable (${result.status}); use your terminal's native paste.`;
        return;
      }
      if (draftEpoch !== epoch || input.plainText !== draft || input.cursorOffset !== cursor || JSON.stringify(input.getSelection()) !== selection) {
        status.content = "Draft changed while reading clipboard; press paste again."; return;
      }
      if (!/^text\/plain(?:;|$)/i.test(result.representation.mimeType)) {
        status.content = "Paste refused: clipboard does not contain plain text."; return;
      }
      insertPaste(new PasteEvent(result.representation.bytes, { kind: "text", mimeType: result.representation.mimeType }));
    } catch {
      if (alive) status.content = "Clipboard read failed; use your terminal's native paste.";
    } finally { pasting = false; }
  }

  const nativePaste = (event: PasteEvent) => { event.preventDefault(); insertPaste(event); };
  renderer.keyInput.on("paste", nativePaste);
  return {
    selectedText, copyText, pasteText,
    submitted() { draftEpoch++; },
    get pasting() { return pasting; },
    dispose() {
      alive = false;
      lifetime.abort();
      renderer.keyInput.removeListener("paste", nativePaste);
      if (clipboard) void clipboard.dispose().catch(() => {});
    },
  };
}
