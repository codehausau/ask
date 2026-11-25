# Design

## Context

Design baseline: `origin/main` at `c80574a` (the packaged CLI and TUI). The CLI already exposes `sessionScope`, `listSessions`, name validation, turn records, and a current-thread pointer in `packages/ask/src/session.ts`. Its effective references and skills are currently the union of all turns. That rule would silently undo a TUI detach or skill removal.

`packages/ask-tui/src/chat.ts` keeps resolved selections, excluded files, usage, and edit snapshots in memory. `commands.ts` dispatches local commands before `submit()`. `ui.ts` and `transcript.ts` own the visible transcript and action controls. The TUI README explicitly promises memory-only history today.

## Goals / Non-Goals

**Goals:** Share a named thread without changing ordinary TUI privacy or CLI pipe behavior. Restore what the user selected, not what a previous answer suggested.

**Non-goals:** Cross-repository switching, syncing to a remote service, restoring drafts or edit approvals, and running a model to reconstruct history.

## Decisions

1. **Name a temporary conversation to save it.** `/switch work` opens `work` from an empty TUI. If `work` does not exist, it names the temporary conversation, including any existing turns and selections. If both sides contain state, refuse rather than merge. `/new [name]` explicitly creates and selects a separate, empty saved thread (automatically named if omitted) and updates the CLI pointer. It discards temporary work but leaves existing saved threads intact. `/clear` uses shared clear semantics, including removing the pre-compaction backup; in temporary mode it does not change the CLI pointer.
2. **Use one scoped store.** Pass the already discovered project root (or startup working directory) from `index.ts` to the controller; switching does not invoke Git. Reuse the CLI's name validator, private state directory, scope key and pointer. List threads without activating one. Explicitly opening a saved name resumes it even past the implicit idle TTL; refresh activity on explicit selection in both interfaces. Keep current CLI flag/environment precedence and implicit expiry. A running TUI stays bound to its selected name if another process moves the pointer.
3. **Separate current selection from history.** Extend the shared record with an authoritative selection: exact file/folder identities, excluded children, and skill identity (name and selected source). Save paths relative to the scope when inside it; retain an explicitly selected outside path only under the existing attachment policy. Both interfaces must use this selection for the next request. Do not union it with historical refs or re-parse old answers. Re-read selected content on submission, not on switch. If an identity is missing or no longer eligible, report it and omit it; never substitute another search result.
4. **Restore data, not live UI objects.** Restore ordered turns and summaries with core message conversion. Preserve recorded usage and distinguish missing usage from zero. Persist short local edit outcomes as history metadata if needed to explain a prior decision, never as executable actions. Render old answers as transcript-only text with no review/apply callbacks. Dispose the outgoing view and invalidate its callbacks on successful switch. Retain process-level settings such as theme and model; never restore an endpoint or key from a thread.
5. **Pin writes to a revision.** The TUI is long-lived; an atomic rename alone cannot stop it overwriting a newer CLI turn. Route both interfaces' named-thread mutations through one serialized update per thread: compare the loaded revision under a short-lived lock, write a private same-directory temporary file, then rename. Release the lock before any provider call. Surface contention or a stale revision without overwriting, silently merging, or retrying a completion. Keep an unsaved answer visible on save failure. Prepare and validate the destination before pointer update and UI replacement; if opening fails, the user stays in the source thread.
6. **Recall prompts in the composer, not from rendered transcript rows.** Index the active thread's retained user questions in submission order, including repeated questions as separate turns. Keep the original composer text (including line breaks and escaped mentions) for new TUI turns; use the stored question for CLI and older turns. Skip synthetic records, including compacted summaries, piped-input placeholders, and local edit outcomes. Do not reconstruct prompts from attachment bodies or persist a second history file.
7. **Keep browsing state transient.** On first Up, remember the live draft and cursor. Copy the recalled question into the composer for editing. Clamp at the oldest question; Down past the newest restores the draft and cursor. Give an open picker first use of arrows, then native multiline movement; recall only at the relevant boundary. Reset the browsing cursor on submit, successful switch, `/clear`, or `/new`. Programmatic recall must not dispatch input as a submission or commit a picker choice.

## Risks / Trade-offs

- **Persisted answers can quote source or secrets.** Label temporary versus named mode. Store only questions, answers, summary/usage metadata and selection identities; exclude assembled prompt blocks, credentials, and proposal snapshots. Preserve private file/directory permissions.
- **Legacy refs can be fuzzy, relative, or ambiguous.** A legacy record does not include the original invocation directory. Open its history without guessing: restore unambiguous exact references against the scope, identify unresolved ones for re-selection, and never silently expand a search. Keep a legacy folder selection as a folder.
- **Two tools can write at once.** Prefer an explicit conflict over losing a turn or applying edits twice. Treat missing, corrupt, and unsupported records as distinct load results when switching; the existing nullable loader cannot make that distinction.

## Migration Plan

Ship the CLI and TUI together. Read existing v1 sessions, including compacted and cleared threads. Write the new version to a separate versioned session namespace on first mutation; prefer it on later loads and de-duplicate listings by scope/name. Keep the existing pointer format. Ensure `/clear`, archive, and reset do not resurrect a shadowed legacy copy or leave an old backup where the operation promised deletion. Older installations can read only their legacy records; document that downgrading cannot expose newer turns. No bulk rewrite at install or startup.
