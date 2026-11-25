import type { TuiChat } from "./chat.ts";
import type { ManagerMode } from "./completion.ts";

export const TUI_HELP = `Chat: mention @files or @folders anywhere; quote paths with spaces.
Typed mentions must name an existing path or glob; use the @ menu to search. Type \\@ for a literal @.
Pasted @mentions work like typed mentions. Each submission makes one logical completion; no model tools.
Transient failures may retry the same request up to twice, without model-driven follow-ups.
/review [path...]  show pending diffs    /apply [path...]  write reviewed files
/reject [path...]  discard proposals     (no paths = every pending file)
/context  manage context    /detach [path]  remove a reference or file
/attach [term]  toggle attached files/folders locally
/skill [term] or /skills [term]  open the same searchable skill-selection popup
/unskill [name]  choose/remove an active skill (instructions only; no scripts)
/copy  copy the last answer (Markdown) to your terminal clipboard
/theme [name]  choose a theme; it is saved as your default in tui.json
/clear  clear conversation and pending edits; keep attachments and skills
/new  clear conversation, attachments and skills    /help    /quit
Enter selects an open mention, otherwise sends · Shift+Enter inserts a newline
Type / for searchable commands · /context, /detach and /unskill open management popups
Ctrl+C copies highlighted text (OSC52); without a selection it exits
Ctrl+D always exits · /copy copies the last answer as Markdown
Ctrl+V pastes local clipboard text · Command/Super+C copies · Command/Super+V pastes
Tab also selects a mention · Esc closes picker · Shift+drag uses native terminal selection
PageUp/PageDown scroll the conversation. Chat history is not saved after exit.
Updates only: use the existing ask /create command for new files.`;

/** Local command dispatch never initiates a model request. */
/** Whitespace-separated paths; quote a path containing spaces. */
export function commandPaths(text: string): string[] {
  return [...text.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((match) => match[1] ?? match[2] ?? match[3]!);
}

export async function dispatchCommand(text: string, chat: TuiChat, actions: {
  quit(): void; clear(): void; review(paths: readonly string[]): void; copy(text: string | null): void;
  addText(text: string, color?: string): void; openManager(mode: ManagerMode, query?: string): void;
  rejected(paths: readonly string[]): void;
  applied(paths: readonly string[]): void;
}): Promise<"handled" | "return" | "prompt"> {
  if (text === "/quit" || text === "/exit") { actions.quit(); return "return"; }
  if (text === "/help") actions.addText(TUI_HELP);
  else if (text === "/clear") {
    chat.clearConversation(); actions.clear();
    actions.addText("Conversation, transcript and pending edits cleared; attachments and skills kept.");
  }
  else if (text === "/new") {
    chat.reset(); actions.clear();
    actions.addText("Started a new conversation; history, transcript, attachments, skills and pending edits cleared.");
  } else if (/^\/skills?(?:\s|$)/.test(text)) actions.openManager("skills", text.replace(/^\/skills?\s*/, ""));
  else if (text === "/unskill") actions.openManager("unskill");
  else if (text.startsWith("/unskill ")) {
    chat.removeSkill(text.slice(9).trim().replace(/^(["'])(.*)\1$/, "$2"));
    actions.addText("Skill removed from future requests. Earlier answers remain in chat history.");
  } else if (text === "/context") actions.openManager("context");
  else if (/^\/theme(?:\s|$)/.test(text)) actions.openManager("theme", text.replace(/^\/theme\s*/, ""));
  else if (/^\/attach(?:\s|$)/.test(text)) actions.openManager("attach", text.replace(/^\/attach\s*/, ""));
  else if (text === "/copy") { actions.copy(chat.lastAnswer); return "return"; }
  else if (text === "/detach") actions.openManager("detach");
  else if (text.startsWith("/detach ")) {
    chat.detach(text.slice(8).replace(/^(["'])(.*)\1$/, "$2")); actions.addText("Reference/file removed from future file context.");
  } else if (/^\/review(?:\s|$)/.test(text)) actions.review(commandPaths(text.slice(7)));
  else if (/^\/reject(?:\s|$)/.test(text)) {
    const rejected = chat.reject(commandPaths(text.slice(7)));
    actions.rejected(rejected);
    actions.addText(`Rejected ${JSON.stringify(rejected)}; nothing written.${chat.pendingCount ? ` ${chat.pendingCount} file(s) still pending.` : ""}`);
  } else if (/^\/apply(?:\s|$)/.test(text)) {
    const applied = await chat.apply(commandPaths(text.slice(6)));
    actions.applied(applied);
    actions.addText(`Applied updates to ${JSON.stringify(applied)}. Review with git diff.${chat.pendingCount ? ` ${chat.pendingCount} file(s) still pending.` : ""}`, "#a7f3d0");
  }
  else if (text.startsWith("/")) throw new Error("Unknown command. Use /help.");
  else return "prompt";
  return "handled";
}
