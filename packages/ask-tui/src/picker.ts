/** Local UI choices only: this registry never becomes a model tool schema. */
export const SLASH_COMMANDS = [
  { value: "/context", description: "Manage attached files, folders and skills" },
  { value: "/attach", description: "Attach or detach files and folders" },
  { value: "/detach", description: "Remove a file or folder from context" },
  { value: "/unskill", description: "Remove an active skill" },
  { value: "/skill", description: "Search skills and enable or disable them" },
  { value: "/skills", description: "Enable or disable skills (alias of /skill)" },
  { value: "/review", description: "Show pending edit diffs (all, or name files)" },
  { value: "/apply", description: "Write reviewed edits (all, or name files)" },
  { value: "/reject", description: "Discard pending edits (all, or name files)" },
  { value: "/copy", description: "Copy the last answer to the clipboard as Markdown" },
  { value: "/theme", description: "Choose a color theme (saved as your default)" },
  { value: "/clear", description: "Clear conversation and pending edits; keep attachments and skills" },
  { value: "/new", description: "Clear conversation, attachments and skills" },
  { value: "/help", description: "Show commands and keyboard shortcuts" },
  { value: "/quit", description: "Exit the TUI" },
  { value: "/exit", description: "Exit the TUI (alias of /quit)" },
] as const;

export type PopupKind = "mention" | "command" | "skill" | "attach" | "detach" | "unskill" | "restore" | "open-skills" | "open-files" | "theme";
export interface PopupItem {
  readonly kind: PopupKind;
  readonly value: string;
  readonly label: string;
  readonly description: string;
}

/** Dot path components require an explicit dot-prefixed search component.
 * A period in an ordinary filename/extension does not reveal hidden entries.
 * This is display filtering only; attachment security/skip rules remain shared.
 */
export function isFileCandidateVisible(candidate: string, query: string): boolean {
  const hidden = candidate.split("/").filter((part) => part.startsWith(".") && part !== "." && part !== "..");
  if (!hidden.length) return true;
  const parts = query.trim().toLowerCase().split("/");
  const requested = parts.filter((part, index) => part.startsWith(".") && part !== ".." && (part !== "." || index === parts.length - 1));
  return hidden.every((part) => requested.some((prefix) => part.toLowerCase().startsWith(prefix)));
}

/** Word-wise, case-insensitive substring search over labels and descriptions. */
export function filterPopupItems(items: readonly PopupItem[], query: string): PopupItem[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return items.filter((item) => {
    const text = `${item.label} ${item.description}`.toLowerCase();
    return words.every((word) => text.includes(word));
  }).sort((a, b) => {
    const needle = query.trim().toLowerCase();
    const score = (item: PopupItem) => item.value.toLowerCase().replace(/^\//, "") === needle ? 0
      : item.value.toLowerCase().replace(/^\//, "").startsWith(needle) ? 1 : 2;
    return score(a) - score(b);
  });
}
