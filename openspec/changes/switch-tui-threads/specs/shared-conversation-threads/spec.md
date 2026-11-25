# Shared conversation threads

## Purpose

Let a developer resume a named conversation and its selected context in either Ask interface while keeping unrelated threads and edit permissions separate.

## ADDED Requirements

### Requirement: Local thread selection and discovery
The TUI SHALL support `/switch <name>` and `/sessions` using the CLI's thread names and repository scope (working directory outside Git). A successful switch SHALL show the active name and replace the transcript and selected context. Listing SHALL identify the current TUI thread, or mark it temporary.

#### Scenario: Switch away and back
- **WHEN** a user switches from `work` to a new name `docs`, then back to `work`
- **THEN** `docs` starts empty, and `work` resumes its own conversation and context without anything from `docs`

#### Scenario: Find a saved CLI thread after restarting the TUI
- **WHEN** the user starts a new TUI and runs `/sessions` in the same repository
- **THEN** the list includes named threads saved by either interface, excludes other repositories, and leaves the active conversation unchanged

#### Scenario: Choose a thread without remembering its name
- **WHEN** the user enters `/switch` without a name in the TUI
- **THEN** a picker lists this repository's saved threads, including newly named empty threads, and marks the current one
- **AND** browsing or cancelling leaves the conversation unchanged; confirming a name uses the same switch operation as `/switch <name>`

### Requirement: Explicit persistence
A plain TUI launch SHALL start temporary, even if the CLI has a current thread. Selecting an unused name from a temporary conversation SHALL save that conversation under the name. Selecting an existing name SHALL NOT discard a nonempty temporary conversation or append it to the destination.

#### Scenario: Opt in after starting a conversation
- **WHEN** the user asks a question in a temporary TUI and switches to an unused name
- **THEN** that question, answer, and selected context become the named thread; quitting before naming it would have left no saved conversation

#### Scenario: Existing destination with unsaved work
- **WHEN** a temporary conversation with history or selected context attempts to switch to an existing thread
- **THEN** the TUI keeps both intact and explains how to save under an unused name or discard the temporary conversation with `/new`

### Requirement: Bidirectional handoff
The interfaces SHALL share named turns, compaction summaries, selected context, and the repository's current-thread pointer. A named TUI SHALL save completed turns and explicit context changes without requiring a clean exit. Piped CLI requests without session opt-in SHALL continue to ignore the store.

#### Scenario: CLI to TUI to CLI
- **WHEN** the CLI saves a turn in `work`, a fresh TUI switches to `work` and asks a follow-up, and the user resumes `work` in the CLI
- **THEN** both turns appear once, in order; the next request includes only that thread's retained history within the interface's history budget

#### Scenario: Clear or leave a named thread
- **WHEN** the user runs TUI `/clear` in `work`
- **THEN** either interface reopening `work` sees no old turns and retains its selected context
- **WHEN** the user instead runs TUI `/new`
- **THEN** the TUI creates and selects a distinct, automatically named, empty saved thread, immediately visible in `/switch` and `/sessions`; `work` remains available intact
- **WHEN** the user runs `/new <name>` with a name already in use
- **THEN** the TUI keeps the current selection and existing thread intact and offers `/switch <name>` to resume it

### Requirement: Restore the current selection, not historical attachments
Both interfaces SHALL restore the currently selected files, folders, excluded files, and skills. They SHALL read content afresh for the next user request, under current context limits and filters. Restoring a missing reference SHALL NOT silently choose a different file or skill.

#### Scenario: Resume from another repository subdirectory
- **WHEN** a TUI selects a folder, excludes a child, removes a skill, and the CLI resumes the thread from a different subdirectory of the same repository
- **THEN** the same folder is selected, the child is excluded, and the removed skill stays removed despite older turns referencing it
- **AND** a changed file contributes its current content; missing selections are identified without fuzzy substitution

### Requirement: Recall the user's prompts in the active TUI thread
In the focused composer, Up SHALL recall the most recent user prompt, then successively older prompts. Down SHALL move toward newer prompts and restore the original draft past the newest. Recall SHALL change only the input, never a stored turn, context selection, or source file. It SHALL NOT submit a request or execute a command.

#### Scenario: Browse in both directions without losing a draft
- **GIVEN** the user sent `first` and then `second`, and is typing `unfinished`
- **WHEN** they press Up three times, then Down twice
- **THEN** the input shows `second`, `first`, `first`, `second`, then `unfinished`; no request is sent

#### Scenario: Edit before resubmitting
- **WHEN** the user recalls a prompt, changes its text, and deliberately submits it
- **THEN** Ask handles it as one new submission and leaves the original turn unchanged

#### Scenario: Recall after switching or clearing
- **WHEN** the user opens a saved thread and presses Up
- **THEN** only that thread's retained user prompts are available, including questions recorded by the CLI
- **AND** assistant replies, generated summaries, edit decisions, and local slash commands are skipped
- **WHEN** a thread with no retained prompts is active, including after `/clear` or `/new`
- **THEN** Up and Down leave the draft unchanged

#### Scenario: Picker or multiline input owns the arrows
- **WHEN** a picker is open, or the cursor can move another row in the requested direction within a multiline draft
- **THEN** the arrow key navigates the picker or the draft respectively, rather than replacing the draft from history

### Requirement: Thread commands cannot authorize actions
Listing and switching SHALL make zero model requests, launch no commands, and write no source files. A switch SHALL be refused during an in-flight request or write, or while edits await a decision. Restored answers SHALL be inert: their text cannot restore a proposal, snapshot, or approval.

#### Scenario: Pending edit at switch time
- **WHEN** a user attempts `/switch docs` with a pending or reviewed-but-unapplied edit in `work`
- **THEN** the switch is refused, the current thread and proposal remain unchanged, and nothing is applied

#### Scenario: Reopen an answer containing an edit
- **WHEN** a thread containing an old edit block is opened in the TUI
- **THEN** the answer is visible without active write controls, and `/apply` cannot write that historical edit
- **AND** only a new user submission can request a completion

### Requirement: Private, failure-safe thread storage
Named threads SHALL use the CLI's configured state directory and owner-only permissions where supported. The store SHALL NOT separately persist attachment bodies, skill bodies, credentials, or approval state. Invalid names, unreadable destinations, or stale writers SHALL NOT cause silent history loss or redirect an active conversation.

#### Scenario: Another interface updated the thread
- **WHEN** a TUI with an older view tries to save after the CLI modified the same thread
- **THEN** the newer record survives, the TUI reports a conflict, and resolution does not automatically call the model

#### Scenario: Destination cannot be opened
- **WHEN** a switch names an invalid thread or encounters a corrupt record
- **THEN** the TUI reports the error and keeps the previous transcript, context, and active-thread pointer
