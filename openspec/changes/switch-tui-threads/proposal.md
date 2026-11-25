# Proposal

## Why

The CLI can resume a named conversation, but the TUI loses its history and context on exit. A developer should be able to pause `work`, discuss a different task, and resume `work` from either interface without rebuilding its context.

## What Changes

- Add local `/switch <name>` and `/sessions` commands to the TUI. Reuse the CLI's repository scope, thread names, store, and active-thread pointer.
- Save and restore conversation turns and the current selection of files, folders, exclusions, and skills. Show the active thread and restored context before the next submission.
- Add Bash-style prompt recall to the TUI input. Up recalls the user's previous prompt in the active thread; Down moves forward and restores the unfinished draft. Recall never submits a message.
- Keep a plain TUI launch temporary. Explicitly naming a thread opts into saving it. Keep piped CLI requests one-shot unless the user explicitly enables sessions.
- Never transfer pending edits, file snapshots, or approvals. Switching is local: it neither asks the model nor runs a command on the user's behalf.

## Capabilities

### New Capabilities

- `shared-conversation-threads`: Resume the same named history and selected context from the CLI or TUI, without carrying edit authority between conversations.

### Modified Capabilities

## Impact

Changes the shared session store and CLI context assembly in `packages/ask`, plus command handling, chat state, and transcript rendering in `packages/ask-tui`. Both package guides and `SECURITY.md` need to distinguish temporary TUI conversations from explicitly saved ones. No new service, runtime, or model API is required.
