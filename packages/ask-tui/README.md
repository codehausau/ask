# ask-tui

Interactive terminal chat for [`ask`](../ask/README.md), built on
[OpenTUI](https://github.com/sst/opentui). Attach files with `@`, ask a question,
and get one logical completion per message. **No model tools, no agent loop.** Suggested
edits to attached files only become writes after you review a diff and `/apply`.

`ask-tui` is published separately from `@codehaus-au/ask` so the CLI keeps its
small dependency footprint. It reuses the CLI's context collection, endpoint
checks, skills and terminal sanitising by depending on the exact matching
`@codehaus-au/ask` version; the two packages are always released together with
the same version number.

See the shared [security policy](https://github.com/codehausau/ask/blob/main/SECURITY.md)
for both interfaces and vulnerability reporting.

## Install

Requires Node.js 20+ (for the launcher) and **Bun 1.3.14+** on `PATH`:

```bash
npm install --global @codehaus-au/ask-tui
ask-tui --help
```

This also installs the matching `@codehaus-au/ask` as a dependency. Install
`@codehaus-au/ask` globally as well if you want the `ask` command.

The launcher looks Bun up by absolute path. It ignores empty and relative `PATH`
entries and any directory inside the current folder, so a repository cannot
supply its own `bun` (on Windows the current folder would otherwise be searched
first). To use a specific Bun, export `ASK_BUN` with its absolute path.

## Usage

The TUI requires **Bun 1.3.14+**. The existing `ask` CLI still runs on Node 20+;
it never imports OpenTUI. Package managers may warn about OpenTUI's newer engine
requirements when installing under older Node versions; that affects only this
package, not `@codehaus-au/ask`.
The Node `ask-tui` launcher starts Bun with `--no-env-file` and an explicit,
bundled runtime configuration. Repository `bunfig.toml` preload hooks are never
loaded, automatic global runtime configuration is skipped, and dependency auto-installation
is disabled. Use `ask-tui` or `pnpm tui` so these protections take effect before
any Bun code runs. Bun never loads a `.env` itself.

```bash
pnpm install
pnpm tui                        # from the repository root: builds and launches; needs bun on PATH
# Or, after installing the package:
ask-tui                         # Bun must be on PATH
ask-tui --model gpt-4o-mini
```

Configuration is shared with `ask`: layered JSON in `~/.config/ask/`, an optional
`--config <dir>`, the project's `ask.json` and `.ask/`, `$ASK_CONFIG_CONTENT`,
`ASK_*` variables and flags. TUI settings go in `tui.json` (or `tui.jsonc`):

```jsonc
// ~/.config/ask/tui.jsonc
{
  "$schema": "https://raw.githubusercontent.com/codehausau/ask/main/packages/ask/schema/tui.schema.json",
  "theme": "dracula", "contextWindow": 32768, "mouse": true,
  "updateView": "diff", // default; or "search-replace"
}
```

A project cannot choose the endpoint or key until you run `ask /trust`, and
`.env` files are never read. `AGENTS.md` files and `instructions` are added to
the system prompt as for `ask`; the TUI lists them in the transcript at startup
and re-reads them for every message, so edits apply without restarting
(`--no-instructions` skips them). See the `ask`
[configuration notes](https://github.com/codehausau/ask/tree/main/packages/ask#configuration);
`ask-tui --show-config` shows every setting and where it came from.
Run `ask-tui --help` for supported flags.

### Chat, attachments and suggested edits

Type `@` anywhere at a word boundary in your message to open a file/folder
popup immediately above the composer. Keep typing to filter and use Up/Down to
move. **Enter** selects the highlighted entry without sending; **Tab** also
selects. Escape closes the popup; typing `@` again reopens it without inserting
a duplicate sigil. Deleting and retyping a mention also reopens it. Paths with spaces or parser-significant punctuation are quoted automatically;
you can also type `@"path with spaces.ts"` yourself. When no candidate popup is
active, **Enter** sends. **Shift+Enter** always adds a newline. PageUp/PageDown
and the mouse wheel scroll the transcript.

Typed or pasted mentions must name an existing file or folder, or a glob such as
`@src/*.ts`; a mention that names nothing is refused rather than searched for.
Use the `@` menu to search. Type `\@` for a literal `@` (for example
`\@Override`); the model receives a plain `@`. Pasting preserves `@` and any
explicit `\@` escapes, so copied prompts retain their file attachments.

Both `@` and `/attach` hide dotfiles/dotfolders by default. Start a filename
component with `.` to reveal matching hidden entries, for example `@.` or
`@src/.config` (or `/attach src/.`). A period in a normal filename extension
does not reveal hidden paths. Secret/build-directory skip rules still apply.

The composer has a blue left border matching user messages, two columns of
inner padding on each side, and half-block
top/bottom caps (`▄` / `▀`) for visual spacing. Terminal rows remain whole cells;
the half-height appearance comes from these glyphs. The caps are decorative and
never become part of your prompt or clipboard text selected from the editor.
User messages in chat history use the same two-column side padding and
half-block top/bottom spacing, keeping their blue left border.
Ordinary left-clicks in read-only text or the background return keyboard focus
to the prompt without preventing text selection. Scrollbars, popups and the
sidebar divider retain their own mouse behavior; clicks inside the editor
still position its cursor normally.

User messages have a contrasting background and left border; replies appear
without separate `You`/`Assistant` label lines.

### Command and context popups

Type `/` at the start of the composer to open command completion above it. Search
command names **and descriptions**, case-insensitively (for example `/remove skill`).
Use Up/Down to navigate, **Enter** to run a command, or **Tab** to complete its name
without running it. As the query changes, the best-ranked result is highlighted
(so `/skil` selects `/skill`, and an exact name wins over description matches).
Commands that manage context open a second searchable list:

- `/attach` — toggle files or folders in context locally, without sending a prompt.
- `/detach` — choose an attached reference or individual expanded file to remove.
- `/skill` or `/skills` — open the same searchable skill-selection popup.
- `/unskill` — choose an active skill to remove.
- `/context` — manage references, expanded files and skills together; restore
  excluded files, and inspect working-directory/session information in a
  read-only summary, separate from the selectable actions.

The context popup has separate **Skills** and **Files** sections. Empty sections
say **No skills attached** or **No files attached**; filtering existing context
to zero results instead shows **No matching skills/files**. Section headings and
empty-state labels are not selectable actions.
Each section also has an **Add skills…** or **Add files…** action that opens its
selector. Choosing a file/folder attaches it immediately for future requests;
it does not send anything to the model or insert a question automatically.
In `/attach`, use Up/Down and **Enter or Tab** to toggle the highlighted file/folder.
Attached entries show `✓`; selecting one again detaches it. Detaching an individual
file included through a folder excludes that file while keeping the folder
attached. The popup stays open for additional changes, and no source files are deleted.

Keep typing after the command's space to filter its list. Enter applies the
highlighted action; the popup stays open for further changes. Lists scroll as
you move past the visible rows. Escape closes a management popup and clears its
command from the composer. Direct `/detach <path>` and `/unskill <name>` forms
still work. All of these operations are local—no model request or source-file
deletion occurs. Resolve pending edit proposals before changing context.

Removing a file included through a folder excludes that file on later turns,
before reading it or consuming context budgets. The parent folder stays attached.
Use the restore entry in `/context`, or explicitly mention the file again, to
reattach it. Explicitly mentioning a whole folder restores its excluded children.
Expanded file lists reflect the most recent request or local attachment refresh. Earlier answers may
still quote removed context; `/clear` clears conversation history while keeping your current context selection.

### Copying text

Select answer text with the mouse, then press **Ctrl+C** to copy it. Selected
composer text can also be copied. **Without a selection, Ctrl+C exits**;
**Ctrl+D always exits**, even with text selected. `/copy` copies the last answer
as Markdown (including code fences), without needing a selection.
These are explicit local actions, not model tools; responses never automatically
change your clipboard.

Copy uses the terminal's **OSC52 clipboard support**, which may need to be enabled
in your terminal or multiplexer. If unsupported, use your terminal's native
selection (often **Shift+drag**), or launch `ask-tui --no-mouse` and use your usual
terminal copy shortcut. With mouse handling disabled, use PageUp/PageDown to scroll.

### Pasting and Mac shortcuts

**Ctrl+V** pastes plain text from the local system clipboard into the composer,
replacing selected draft text or inserting at the cursor. **Command+C/V** are
also supported when the terminal forwards Command as the enhanced keyboard
protocol's Super modifier. Command+C copies highlighted text without exiting;
with no selection it does nothing. Alt/Option is not treated as Command.

Most Mac terminals handle **Command+V** themselves and deliver a native paste;
that path works too, including multiline text, even after selecting transcript
text. Pasting never submits the prompt. Command+C may likewise be owned by your
terminal; use its native selection or `--no-mouse` in that case.

Local clipboard reads use OpenTUI's built-in native API, only after an explicit
paste shortcut. Reads are bounded to 1 MiB and two seconds, with no extra library
or clipboard subprocess. If the draft changes while a read is pending, paste
again rather than risking insertion at the wrong place. Unsupported clipboard
access leaves the draft unchanged and suggests native terminal paste.

In SSH/remote sessions, use the terminal's native paste shortcut (usually
Command+V on Mac or Ctrl+Shift+V elsewhere). The TUI deliberately does not read
the remote machine's clipboard or query the client's clipboard through OSC52.

### Themes

Choose the starting theme on the command line or export a shell default:

```bash
ask-tui --theme dracula
export ASK_THEME=tokyo-night
ask-tui
# From a checkout:
pnpm tui --theme high-contrast-light
```

`--theme` overrides `ASK_THEME`; without either, the theme is `ask`. Unknown
names are rejected before starting the UI; an empty value means "not set". Set `ASK_THEME` in your shell
or as `theme` in `tui.json`. `/theme` changes the theme straight away and saves your choice (see below).

Run `/theme` to open a searchable theme picker. Type a name
(for example `/theme dracula` or `/theme high-contrast-light`).
**Up/Down** or the mouse wheel over the picker previews highlighted choices live;
filtering previews the best match too. **Enter** or **Tab** keeps the preview.
**Escape** restores the theme in use before opening the picker, as does leaving
the theme command without confirming. `✓` marks that original choice. The picker
initially highlights the current theme when no filter is given. This is entirely local—no
model request or filesystem update is made.

The 40 bundled `@termcn/opentui` themes include `default`, `amoled`, `tokyo-night`,
`catppuccin`, `dracula`, `github`, `gruvbox`, `nord`, `high-contrast` and
`high-contrast-light`. These are the registry's actual fixed palettes, not
fabricated dark/light pairs; `high-contrast-light` is the supplied light option.
The original appearance remains available as `ask` (the default).
Theme source files are adapted to ask's UI color roles, including selection
colors, without installing React, a theme provider, or another runtime library.
Spacing and border shapes remain unchanged. See `THIRD_PARTY_NOTICES.md` for
source revision and license.

Changes recolor existing messages, inline Markdown, message/input backgrounds,
dividers, popups, footer and sidebar, as well as future messages. The choice lasts
across `/new`, and **is saved as your default**: confirming a theme (Enter or Tab,
not previewing) sets `theme` in your global `~/.config/ask/tui.json` (or
`tui.jsonc`), creating the file if needed (owner-only). Only that value changes;
your comments and other settings are kept. A project or `--config` file is never
written. If `ASK_THEME`, `--theme` or a project's `tui.json` also sets a theme,
that still wins next time, and the transcript says so. If saving fails, the
theme still applies for the current run. If the globally saved theme is unavailable
(for example, its palette lives in another project's `.ask/themes/`), startup uses
`ask` and shows a notice. The saved name is kept for directories where it is
available. Explicit unknown themes from a flag, environment variable, project or
`--config` remain errors. Automatic light/dark detection is not supported yet.

#### Custom themes

Put `themes/<name>.json` (or `.jsonc`) in any config directory (`~/.config/ask/`,
a `--config` directory, or the project's `.ask/`), then choose it like any other
theme. Keys are the TUI's colour roles, as hex colours:

```jsonc
// ~/.config/ask/themes/midnight.jsonc
{
  "$schema": "https://raw.githubusercontent.com/codehausau/ask/main/packages/ask-tui/schema/theme.schema.json",
  "extends": "nord",      // optional: any built-in or earlier custom theme
  "mode": "dark",         // optional: "dark" (default) or "light"
  "accent": "#88c0d0",
  "panel": "#3b4252",
}
```

Roles: `background`, `panel`, `accent`, `text`, `muted`, `heading`, `summary`,
`border`, `code`, `warning`, `error`, `selectionBg` and `selectionFg`. Unset roles
come from `extends`, or else from the `ask` palette. A later directory's theme
replaces an earlier one of the same name, and a custom theme may replace a
built-in. Values must be hex colours, so a theme file can only change colours,
never write to the terminal. A broken file is skipped with a note; selecting it
explains why it is unknown. The `/theme` picker marks custom themes with their file.

### Footer and session sidebar

The persistent footer stays within the chat pane, directly beneath the prompt,
and does not extend into the sidebar. It shows the working directory on the left and the last
response's **input + output token count** on the right, formatted with one decimal
and a `K` suffix (`1.2K` means approximately 1,200 tokens). Exact counts remain in
the sidebar. Usage stats no longer add
a message to the transcript after every answer.

At **120 columns or wider**, a sidebar shows context usage, separate input/output
counts, running session totals, active skills, expanded referenced files, pending
edits, and the right-aligned working directory path (without a heading) on its bottom row,
aligned with the chat footer. It hides and restores automatically
on resize; its details scroll independently with the mouse wheel.
Long sidebar paths are truncated from the left with `…`, preserving the current
directory and nearest parents. Widening the sidebar restores more of the path.

Drag the sidebar's **left divider** to adjust its width. It starts at 32 columns,
has a 24-column minimum, and is capped to keep at least 60 columns for chat and
at most half of the available pane area for the sidebar. The divider highlights
and shows a resize cursor on hover where supported by the terminal.

Your chosen width is remembered for the current TUI run (including `/new`), not
written to disk. Smaller terminals temporarily clamp the width or hide the sidebar;
it returns to the chosen width when there is room again. Mouse resizing requires
mouse reporting and is unavailable under `--no-mouse`.

Counts come from the provider's response, not a local estimate. Missing counts
are shown as unknown, and incomplete session totals are marked partial. Context
usage describes the **last completed request plus its output**, not an estimate
of the next request. No model metadata requests are made. To display a capacity
and percentage, supply the actual model/server limit explicitly:

```bash
ask-tui --context-window 32768
# Or set a default in your shell:
export ASK_CONTEXT_WINDOW=32768
ask-tui
# From a checkout:
pnpm tui --context-window 32768
```

The flag overrides `ASK_CONTEXT_WINDOW`; both require a positive integer token
count. Export the variable or set `contextWindow` in `tui.json`.
With a capacity, the footer shows usage such as `1.2K tokens (3.7%)`,
and the sidebar shows the exact count, capacity and percentage. Percentages use
the last response's input plus output, not cumulative session totals.
Without either setting the sidebar shows an unknown window limit and the footer
omits the percentage. The setting never changes the server's context size.

The capacity also limits what is sent. Before each request, the TUI estimates its
size (bytes ÷ 4) and drops the oldest history until the system prompt, history,
your message and attachments fit in 90% of the window, less room for the answer
(`--max-tokens`, or 4096 tokens capped at a quarter of the window). A message
that cannot fit even without history is refused before anything is sent: detach
files or ask about less. Without a capacity, resent history alone is capped at
about 32000 tokens, the same default as CLI sessions.

### Ordinary chat and edits

Set the request timeout for either interface with `--timeout <seconds>` or
export `ASK_TIMEOUT` in your shell:

```bash
ask-tui --timeout 300
ask --timeout 300 'Explain this code'
export ASK_TIMEOUT=300
```

The flag overrides the environment variable; the default is 120 seconds per
request attempt. Positive fractional seconds are supported (millisecond
precision). It can also be set as `timeout` in `ask.json`. Both interfaces allow
up to two SDK retries (three HTTP attempts total) for connection errors, timeouts,
HTTP 408/409/429 and server errors. Each retry resends the same request body,
including messages, attachments and model settings. It does not reread files,
append messages, or start a model-driven follow-up. Total elapsed time can exceed
the per-attempt timeout. Exiting the TUI cancels the active request and its retries.

For example:

```text
Explain the validation in @src/example.ts
What would you improve about that function?
```

References remain attached until `/detach <path>` or `/new`. Resolved file/folder
attachments appear in the sidebar as soon as submission context is validated,
before the model responds, and remain attached if the request fails. Resolved
paths are retained rather than re-running a search. Their contents are
re-read before each submission and appended **after the message** as `<file>`
blocks; previous file contents are not duplicated in chat history. Attachment
skip rules and size caps are shared with the CLI. A file or folder deleted after
it was attached is dropped from the attachments, with a notice, rather than
replaced by another match. A folder reference
includes its children except for files explicitly excluded through context management.

The model can suggest edits to any complete, editable file in the current
attachments, **even when you did not name the file in the latest question**.
It produces ordinary response text with a defined format, not API tool calls:

> ```text
> Reject empty names before doing the work.
>
> <update path="src/example.ts">
> <<<<<<< SEARCH
> function greet(name: string) {
> =======
> function greet(name: string) {
>   if (!name.trim()) throw new Error("Name is required");
> >>>>>>> REPLACE
> </update>
> ```

Update blocks appear in inset, bordered, theme-aware code panels, with the filename
above the border. SEARCH content is red and REPLACE content is green. Click the header
to toggle between SEARCH/REPLACE and a colored full-file diff; the code itself stays
selectable. Blocks start in diff view by default. Set `"updateView": "search-replace"`
in `tui.json` to start in SEARCH/REPLACE view instead. Clicking changes only that panel's view.
The diff is identical to the approval diff, including file-relative line numbers,
context and all proposed edits to that file. Previewing it does not authorize writes.
Invalid proposals show only their original SEARCH/REPLACE text.
Each valid block has **Review** and **Reject** buttons below it. Review selects the
same full-file diff in the block and replaces the buttons with **Apply** and
**Cancel**, plus a note that applying will modify the file. Cancel returns to
Review/Reject and requires a fresh review; Reject discards the file's proposals.
Actions cover **all proposed edits to that file**, with matching blocks sharing
the same review state. Conflicting or otherwise invalid proposals have no buttons.
The `/review`, `/apply` and `/reject` commands work alongside these controls.

After the answer, the TUI lists each proposed file with its added/removed line
counts. Files that can run code or change automation (CI workflows, package
scripts, build files, git hooks, shell scripts, dotfiles) are marked ⚠.
**Nothing is written until you review and apply:**

```text
/review                 show the diff for every pending file
/review src/a.ts        show one file's diff
/apply                  write every reviewed file
/apply src/a.ts         write one file; the rest stay pending
/reject [path...]       discard proposals (all when no path is given)
```

Only files whose full diff you have shown with Review or `/review` can be applied.
The Apply button and `/apply` use the same write checks. Each diff has
one section per edit, with three lines of context, so unchanged lines between two
edits are never shown as removed and re-added. Quote paths containing spaces.
Review and apply are local operations, with no second LLM request. Resolve every
pending file before sending another question.

Safety rules:

- Paths must exactly match an attached file in the current request, inside the
  working directory. Truncated files and symlinks are read-only.
- SEARCH must match exactly once, byte-for-byte in UTF-8. There is no fuzzy matching.
  Multiple edits match the original file and must not overlap. In a file that
  uses CRLF line endings throughout, the model's LF text is matched and written
  as CRLF; files with mixed endings are matched exactly.
- Malformed blocks, incomplete responses, or any invalid edit invalidate the
  entire proposal. Examples inside Markdown code fences are not actionable.
- Approval diffs show control characters as visible escapes, including the
  contents of terminal escape sequences. The bytes written remain unchanged.
- Identity, contents and parent-directory checks run before writing. Changed
  files require a fresh request; stale proposals are never rebased automatically.
- Existing guarded atomic replacement preserves ordinary permissions. Unlike
  CLI `/write`, TUI approval can update dirty/untracked files: you are approving
  a diff against the exact bytes sent, not relying on Git for an undo copy.
- All targets are preflighted before any write, but **multi-file writes are not
  one transaction**. A later failure can leave earlier files updated; the error
  names any files already written. Review your diffs and keep backups/commits.

This initial TUI supports updates to existing files only. Use `ask /create` for
new files. It has **in-memory history only** (separate from CLI sessions), no
compaction, no streaming, no model tools, and no model-driven follow-ups.
`/clear` clears history, the visible transcript, pending edits and conversation
usage counters, while keeping attachments, file exclusions, active skills and
settings. `/new` also removes attachments, exclusions and skills. Both destroy
the cleared transcript's native renderables and keep the selected theme and sidebar
width for the current run. `/context`
opens the context manager; `/help` lists commands; `/quit` or Ctrl+D exits.
Ctrl+C exits only when no text is selected; otherwise it copies the selection.
Each submission resends the conversation history. When it no longer fits (see
`--context-window` above), the oldest messages are dropped first, with a notice,
and history always restarts at a question. Attached files are re-read and sent in
full on each new submission; they are never trimmed. SDK retries reuse that
submission's snapshot. Credential files, including `ask.json` and `ask.jsonc`,
are excluded from attachments and automatic instructions, including symlink aliases.

### Skills in the TUI

Use the same skill directories and discovery rules as `ask`:

```bash
ask-tui --list-skills                      # offline; no API key or terminal needed
ask-tui --skill code-review --skill style  # select startup instructions
```

Inside the TUI:

```text
/skill                  open the searchable skill-selection popup
/skills                 alias of /skill; opens the same popup
/skills review          open it filtered by skill name/description
/skill code-review      open it filtered to code-review
/unskill code-review    remove an exact active name from future requests
/unskill                open the active-skill removal popup
```

Enabled skills persist for this conversation. Each skill is included at most
once; multiple skills compose in activation order in the system
prompt. The resolved instruction file is re-read each turn, with the same 128 KB
cap as the CLI. Missing or oversized selected files stop the request rather than
silently dropping instructions or switching to a different skill. Only instruction
text is loaded—bundled scripts/assets are not executed or attached. The model
cannot select skills, read extra files, or bypass edit approval.

Use Up/Down to move and Enter to toggle a skill on or off; active skills show a
`✓` marker. The popup stays open so you can change several skills. Escape closes it and clears
the command from the composer. Both aliases search names and descriptions, and
neither makes a model request. `/unskill` and `/context` can also remove skills.

Resolve pending edits before changing skills. `/new` clears skills as well as
history, attachments and proposals, including skills selected with `--skill`.
Removing a skill does not remove earlier answers influenced by it from history;
use `/clear` for a clean conversation with the remaining skills, or `/new` to reset
all context too. No additional libraries are required.

Run `pnpm build` followed by `pnpm test:bun` under Bun. This includes the real
Node launcher's isolation from repository/global Bun preloads. Controller/protocol
tests also run in the normal Node test suite without importing OpenTUI.
After installing the tarball, `python3 packages/ask-tui/test/package-smoke.py` exercises its
native renderer, a local mock completion, diff approval and clean exit in a PTY.

The UI coordinator is `src/ui.ts`; layout, completion, clipboard, transcript
rendering and local command dispatch live in separate modules alongside it.
