# Tasks

## 1. Shared thread storage

- [x] 1.1 Extend `packages/ask/src/session.ts` with validated named records for ordered turns, summaries, usage, and current selection. Test round-trips for selected paths, folder exclusions, and skill identity; inspect the stored JSON for absence of prompt blocks and write approvals.
- [x] 1.2 Add version-aware reads, de-duplicated listing, and migration on mutation. Test existing v1, compacted, and cleared fixtures; verify unsupported or corrupt records are not replaced as empty. Document storage, permissions, and downgrade behavior in `SECURITY.md`.
- [x] 1.3 Serialize revision-checked writes and update the pointer only after a successful open. Test two writers using one state directory, destination failure, interrupted writes, and owner-only permissions on POSIX.
- [x] 1.4 Make clear, archive, reset, and listing account for both storage versions. Test that clearing retains selection and that removing a migrated thread cannot resurrect its legacy copy or pre-compaction backup.

## 2. CLI interoperability

- [x] 2.1 Use the current selection rather than the historical union when assembling a named request. Extend `session-e2e.test.ts` to cover excluded children, removed skills, changed files, subdirectory launches, and a missing file with a similar name.
- [x] 2.2 Preserve explicit versus implicit session semantics in `cli.ts`. Test explicit resume after idle expiry, pointer/flag/environment precedence, normal implicit expiry, and piped runs without opt-in. Document these cases in `packages/ask/README.md`.

## 3. TUI commands and lifecycle

- [x] 3.1 Add temporary versus named state to `TuiChat`. Persist a named turn or selection change when it succeeds. Test temporary launch/exit leaves no new session record, naming a temporary conversation preserves it, and an occupied destination cannot overwrite it.
- [x] 3.2 Wire `/switch <name>` and `/sessions` into `commands.ts`, picker, and help. Pass the precomputed scope from startup. Verify names and listings against the CLI, and assert listing/switching trigger zero provider calls, subprocesses, or source writes.
- [x] 3.3 Restore transcript, summaries, context, and usage; show the active name or temporary status. Test a switch during a request, during a write, and with a pending proposal. Reopen a previous answer and assert its controls and callbacks cannot authorize a write.
- [x] 3.4 Wire named `/clear` and `/new`, and update the TUI guide with a CLI/TUI handoff example. Verify `/clear` persists retained context and `/new` creates a separately selectable saved thread without deleting the old one.
- [x] 3.5 Add Up/Down prompt recall in the composer using the active thread's retained user questions. Document the keys alongside the existing picker and multiline controls. Test oldest/newest boundaries, draft restoration, repeated prompts, multiline edits, literal mentions, picker precedence, and edit-then-Enter. Assert zero provider calls while browsing and one logical completion on submission.

## 4. Cross-interface acceptance

- [x] 4.1 Use a temporary state directory and mock provider for CLI `work`, TUI `work`, TUI `docs`, then CLI `work`. Assert turn order, thread isolation, exact file/skill selections, and one logical completion per submitted prompt.
- [x] 4.2 Verify recall after reopening a CLI-created thread, switching, `/clear`, and `/new`. Assert no prompt leaks between threads and no assistant reply, local command, or generated summary appears in the composer history.
- [x] 4.3 Run workspace typechecks and relevant Node and native Bun tests, including a TUI restart. Verify the documented `/sessions` and `/switch work` sequence against the packaged interfaces.

## 5. Rename a saved thread

- [ ] 5.1 Implement a revision-checked rename in the shared store, including legacy records, compaction backups, and conditional pointer updates. Test destination collisions, stale writers, interrupted moves, and repository isolation.
- [ ] 5.2 Add TUI `/rename <new-name>` to local command handling, picker, help, and guide. Keep the transcript and context in place; handle unchanged names, temporary chats, invalid names, and busy or pending work.
- [ ] 5.3 Test `/new` → `/rename flint-debug` → `/switch` for an empty thread, then rename a populated thread and resume it from the CLI after restart. Verify recall, selections, and usage survive; the old name disappears; and rename makes no provider calls or source edits.
