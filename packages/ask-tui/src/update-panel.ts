import { BoxRenderable, TextRenderable, StyledText, fg, type CliRenderer } from "@opentui/core";
import { terminalField } from "@codehaus-au/ask/internal/terminal";
import type { UpdateView } from "@codehaus-au/ask/internal/config";
import type { UpdateBlock } from "./updates.ts";

export type UpdateAction = "review" | "reject" | "apply" | "cancel";
export interface UpdateReview { readonly path: string; readonly diff: string; readonly sensitive: string | null }
interface ActionState { readonly review?: UpdateReview; readonly working: boolean }

/** Preview and review use the same validated full-file diff; only Review authorizes Apply. */
export function createUpdatePanel(renderer: CliRenderer, id: string, block: UpdateBlock, raw: string, initialView: UpdateView, preview: UpdateReview | undefined, action: (action: UpdateAction) => void) {
  let view = initialView;
  let state: ActionState | undefined;
  let outcome: "applied" | "rejected" | undefined;
  const panel = new BoxRenderable(renderer, {
    id, width: "100%", flexDirection: "column", flexShrink: 0, paddingLeft: 2,
  });
  const code = new BoxRenderable(renderer, {
    id: `${id}-block`, width: "100%", flexDirection: "column", flexShrink: 0,
    border: true, borderColor: "#344256",
  });
  const header = new BoxRenderable(renderer, {
    id: `${id}-toggle`, width: "100%", flexShrink: 0,
    flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between",
  });
  const filename = new TextRenderable(renderer, {
    content: terminalField(block.path), fg: "#82cfff", maxWidth: "100%",
    paddingRight: 1, flexShrink: 0, selectable: false,
  });
  const hint = new TextRenderable(renderer, {
    id: `${id}-hint`, fg: "#82cfff", maxWidth: "100%", flexShrink: 0, selectable: false,
  });
  const body = new TextRenderable(renderer, {
    id: `${id}-code`, fg: "#a7f3d0", width: "100%", paddingX: 1, flexShrink: 0, selectable: true,
  });
  const warning = new TextRenderable(renderer, {
    id: `${id}-warning`, fg: "#fda4af", width: "100%", paddingX: 1, flexShrink: 0, selectable: true, visible: false,
  });
  const row = new BoxRenderable(renderer, {
    id: `${id}-actions`, width: "100%", flexDirection: "row", flexWrap: "wrap", flexShrink: 0, visible: false,
    border: ["top"], borderColor: "#344256", paddingX: 1,
  });
  const buttons = new BoxRenderable(renderer, {
    id: `${id}-buttons`, flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end",
    maxWidth: "100%", marginLeft: "auto", flexShrink: 0,
  });
  function button(name: UpdateAction, label: string, color: string) {
    const button = new TextRenderable(renderer, {
      id: `${id}-${name}`, content: `[ ${label} ]`, fg: color,
      marginRight: name === "review" || name === "apply" ? 2 : 0, flexShrink: 0, selectable: false,
    });
    button.onMouseDown = (event) => {
      if (event.button !== 0) return;
      event.preventDefault(); event.stopPropagation();
      if (state && !state.working && button.visible) action(name);
    };
    buttons.add(button);
    return button;
  }
  const reviewButton = button("review", "Review", "#82cfff");
  const rejectButton = button("reject", "Reject", "#fda4af");
  const applyButton = button("apply", "Apply", "#a7f3d0");
  const cancelButton = button("cancel", "Cancel", "#82cfff");
  const note = new TextRenderable(renderer, {
    id: `${id}-guidance`, content: "Apply will modify this file (all proposed edits).", fg: "#fcd34d",
    maxWidth: "100%", paddingRight: 1, flexShrink: 0, selectable: false,
  });
  row.add(note);
  row.add(buttons);
  const rejectedMessage = new TextRenderable(renderer, {
    id: `${id}-rejected`, content: "Rejected", fg: "#9baac1", flexShrink: 0, selectable: false, visible: false,
  });
  row.add(rejectedMessage);
  const appliedMessage = new TextRenderable(renderer, {
    id: `${id}-applied`, content: "Applied", fg: "#9baac1", flexShrink: 0, selectable: false, visible: false,
  });
  row.add(appliedMessage);
  function paint() {
    const review = state?.review;
    const next = view === "diff" ? "SEARCH / REPLACE" : "diff";
    hint.content = `click for ${next}`;
    hint.visible = !!preview && !review;
    const asDiff = !!preview && (!!review || view === "diff");
    warning.visible = asDiff && !!preview?.sensitive;
    warning.content = preview?.sensitive ? `⚠ ${preview.sensitive}: this file can run code or change automation` : "";
    // Invalid proposals have no validated diff; keep their original text visible.
    const lines = (asDiff ? preview!.diff : raw).split("\n");
    let search = false;
    body.content = new StyledText(lines.map((line, index) => {
      if (line === "<<<<<<< SEARCH") search = true;
      else if (line === "=======") search = false;
      const color = asDiff
        ? line.startsWith("+") ? "#a7f3d0" : line.startsWith("-") ? "#fda4af" : "#cbd5e1"
        : /^(?:<<<<<<< SEARCH|=======|>>>>>>> REPLACE|<\/?update\b)/.test(line) ? "#e2e8f0"
        : search ? "#fda4af" : "#a7f3d0";
      // Never strip terminal-control payloads from either representation.
      return fg(color)(terminalField(line) + (index < lines.length - 1 ? "\n" : ""));
    }));
  }
  header.onMouseDown = (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    if (!preview || state?.review) return;
    view = view === "diff" ? "search-replace" : "diff";
    paint();
  };
  header.add(filename);
  header.add(hint);
  panel.add(header);
  code.add(warning);
  code.add(body);
  code.add(row);
  panel.add(code);
  paint();
  function sync(next: ActionState | undefined) {
    const repaint = state?.review !== next?.review;
    state = outcome ? undefined : next;
    row.visible = !!state || !!outcome;
    buttons.visible = !outcome;
    rejectedMessage.visible = outcome === "rejected";
    appliedMessage.visible = outcome === "applied";
    row.opacity = state?.working ? 0.5 : 1;
    buttons.marginLeft = state?.review ? "auto" : 0;
    reviewButton.visible = rejectButton.visible = !state?.review;
    applyButton.visible = cancelButton.visible = note.visible = !!state?.review;
    if (repaint) paint();
  }
  return {
    node: panel, sync,
    reject() { outcome = "rejected"; sync(undefined); },
    apply() { outcome = "applied"; sync(undefined); },
  };
}
