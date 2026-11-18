# Security policy

## Reporting a vulnerability

Email **mat@codehaus.co** with the details. Please do not open a public issue
for anything exploitable. Expect an acknowledgement within a few working days.

## Threat model

This policy covers both `ask` (`@codehaus-au/ask`, the Node.js CLI) and
`ask-tui` (`@codehaus-au/ask-tui`, the Bun/OpenTUI interface). The TUI depends
on the exact matching core package version and shares its context collection,
credential filtering, configuration, endpoint checks, skills and write primitives.
Source paths below are relative to the repository root.

Both interfaces send user-selected context to a configured LLM endpoint. That is
their purpose, so the security properties worth stating are about what they
will *not* do.

### Shared guarantees

| Guarantee | Enforced by |
| --- | --- |
| No tool / function calling is ever requested | `OneShotRequest` in `packages/ask/src/chat.ts` is the SDK params type with `tools`, `tool_choice`, `functions`, `function_call`, `parallel_tool_calls`, `stream` removed — setting one is a compile error |
| One logical completion per CLI question or TUI submission | No model-driven execution loop; SDK transport retries resend the same body, at most twice |
| Only one SDK method is reachable | `createClient` returns a one-method `ChatClient`, not the SDK client |
| The model cannot initiate reads | Inputs come from user/configuration-controlled attachments, instructions, skills and history, plus CLI stdin; no model-directed filesystem or network tools |
| Nothing is written to your source tree unless you authorize it | CLI `/write` and `/create` explicitly name targets; TUI proposals require Review or `/review`, then Apply or `/apply` |
| Credential-named attachments are filtered | `.env*`, `ask.json`, `ask.jsonc`, `*.pem`, `*.key`, `*.p12`, `id_rsa`, `credentials.json` and similar are skipped even when named explicitly; only the CLI offers `--include-secrets` |
| An untrusted repository cannot choose your endpoint or key | Project configuration cannot set `endpoint` or use `{env:}` until `ask /trust` records its exact contents; `.env` files are not loaded as configuration |

### Differences between the interfaces

| Boundary | `ask` CLI | `ask-tui` |
| --- | --- | --- |
| Runtime/subprocesses | Node.js runtime spawns only hardened Git commands; shell completion and development/release tooling have their own executable dependencies | Node.js launcher also spawns Bun with isolated runtime configuration; the TUI uses native OpenTUI dependencies and shared Git helpers |
| Attachment selection | Explicit references and `-f`; references can use the CLI's search resolution | Typed and pasted mentions must name an existing path or glob; search and attachment popups are local user actions |
| Request inspection | `--dry-run` prints the exact JSON body; `--show-context` lists inputs without calling the API | Context/sidebar controls show selections; these CLI payload-preview flags are not TUI features |
| Conversation storage | Disk-backed sessions for interactive runs or explicit `--session` | In-memory history only, separate from CLI sessions |
| Edit authorization | Explicit `/write <path>` or `/create <path>` invocation; `/diff` previews without writing | Model may propose edits to any eligible current attachment; explicit per-file review and apply are required |
| Git undo requirement | `/write` requires a clean tracked file and local undo blob unless `--force` | Reviewed edits may replace dirty or untracked files without a Git undo copy |
| Clipboard | No application clipboard read/write commands | Explicit user-triggered clipboard integration, described below |

Transport retries resend the identical request body, including the same messages
and attachment snapshot. They are not new conversation turns. Timeouts apply per
attempt; exiting the TUI cancels an in-flight request and its retries. Local
management commands do not call the model.

### What it does not protect against

- **Data egress is the point.** Anything you attach reaches the configured
  endpoint. Check your provider's retention and training terms, and prefer an
  endpoint your organisation already approves via `OPENAI_BASE_URL`.
- **Prompt injection in attached files.** Terminal control sequences are
  sanitised for display, but the model can still produce misleading advice or
  unsafe code. Treat a review of untrusted code as untrusted output, and never
  pipe it into a shell.
- **Binary and minified content.** Skipped by heuristics (extension list, NUL
  byte sniffing), not guarantees. The CLI's `--show-context` can help inspect inputs.
- **Secret detection.** The credential filter is filename-based. It will not
  catch a key pasted into `src/config.ts`.

## Shell completion and hints (`ask`)

The `@` widget and TAB completion explicitly quote selected filenames for Bash
rather than relying on readline's incomplete default filename quoting. TAB handles
Bash's native `@` word breaks, and both entry paths decline quoted/nested shell
contexts rather than evaluating them. fzf candidate streams are NUL-delimited,
including Git's `-z` output, so filename quotes/backslashes/newlines remain data.
Interactive regression tests press TAB and ENTER in a real Bash PTY and verify
the received arguments and absence of command-substitution side effects.

## Git subprocesses

The core Node.js runtime's only subprocess executable is Git. Calls shared by
both interfaces are centralised in `packages/ask/src/git.ts` and use an
argument-array wrapper with `--no-pager`,
`--no-optional-locks`, `--no-lazy-fetch`, `--literal-pathspecs`, and
`-c core.fsmonitor=false`. The child environment discards all inherited `GIT_*`
overrides (including alternate index/worktree locations), loader variables such
as `LD_*`/`DYLD_*`, shell startup variables, `NODE_OPTIONS`, and Ask/OpenAI
configuration. Only known-safe Git controls are reintroduced. Shell completion
uses equivalent restrictions in a subshell, leaving the interactive environment
unchanged. The Git executable selected by the user's `PATH` is trusted; this is
not a sandbox for a substituted Git binary.

For CLI `/write`, `git status` is not used for write safety: it can run
clean/process filters even with fsmonitor disabled. The check compares HEAD/index object IDs and modes,
verifies that the undo blob exists locally, and hashes raw worktree bytes in
process. Missing promisor objects never trigger fetching or remote helpers.
Filtered/CRLF-normalised files are conservatively considered dirty if raw bytes
differ from the stored blob; no configured transformation is executed to decide.

CLI diff previews use `--no-index --no-ext-diff --no-textconv` plus an explicit null
Git directory and null attributes file, with system attributes disabled. This
isolation is necessary because `--no-index` alone still consults attributes and
can run clean/process filters. Only exit code 1 is accepted as a normal differing
patch; other failures do not emit arbitrary partial stdout as a valid diff.

Git must support the safety options, including `--no-lazy-fetch`. Older or
unavailable builds fail closed rather than retrying without those options.
Tests exercise malicious configuration with harmless marker programs, check
that helpers stay unexecuted, and verify that read-only queries leave index
contents and modification time unchanged.

### Bun launcher and native runtime (`ask-tui`)

The Git-only statement above does not apply to the TUI launcher. Its fixed Node.js
entry point resolves Bun to an absolute path (`ASK_BUN`, or a `PATH` search that
skips empty and relative entries and directories inside the working directory).
It spawns Bun without a shell, with `--no-env-file` and an absolute
`--config=<bundled bunfig.toml>` path. This skips automatic repository/global
runtime configuration and disables runtime dependency auto-installation. Bun's
automatic `.env` loading is disabled as well.

Use `ask-tui` or `pnpm tui`: checks inside a Bun entry point alone cannot prevent
a hook from executing before that entry point. Direct development invocations
require both `--no-env-file` and
`--config=<absolute path to packages/ask-tui/src/bunfig.toml>`; do not add preloads
or `--env-file`. The selected Bun binary and native dependencies are trusted code,
not sandboxed executables.

OpenTUI is loaded only by the Bun TUI entry point, never by the Node.js CLI.
Code blocks are rendered without Tree-sitter, so displaying an answer does not
download parsers. TUI edit diffs are generated in process rather than through
the CLI's Git diff subprocess.

## Context paths

File and directory references are canonicalised before reading or walking them.
A symlink that redirects outside the canonical working directory is skipped,
including a link in a parent component or an explicitly referenced directory.
Credential-name filtering checks both the supplied path and the canonical target.
Common configuration files (`ask.json` and `ask.jsonc`) are credential-bearing
by convention and use the same filter. Automatic instruction loading checks the
full canonical path, including secret-named parent directories, and always
excludes these credential files.
For CLI attachments, `--include-secrets` bypasses only that filename filter, not
symlink containment. It does not relax automatic instruction filtering.
Explicitly named outside paths without redirecting links remain supported.
Directory walks continue to skip nested symlink entries.

Canonicalisation failures do not fall back to the unchecked lexical path. Files
are opened by canonical name with `O_NOFOLLOW` where available; their type and
device/inode identity, along with path resolution, are checked before reading
through the same handle. Detected replacements are skipped. These checks reduce
replacement races but are not a filesystem sandbox against a process actively
swapping parent directories throughout validation; portable Node APIs do not
provide an atomic directory-relative containment primitive.

## Terminal output

### CLI rendering

CLI answers, compacted summaries and diff previews shown on a TTY have ESC/C1
control sequences removed before the CLI adds its own ANSI styling. This includes OSC
clipboard/title/hyperlink operations and CSI cursor/erase operations. `--raw`,
`--no-color` and `NO_COLOR` do not disable sanitisation. Single-line metadata and
diagnostics visibly escape control characters, including embedded line breaks;
Unicode direction-format controls are made visible as well. Spinner labels are
escaped separately from the spinner's trusted erase sequence.

Redirected answers and patches remain unrendered and unsanitised, including when
`FORCE_COLOR` is set. They remain untrusted if later displayed or executed by
another program. JSON displayed on a terminal escapes DEL/C1 and Unicode format
controls in addition to JSON's standard C0 escapes, preserving parsed values.
Session storage, API payloads and file writes retain the original data: escaping
is a presentation boundary, not a rewrite of the model's answer or source files.

### TUI rendering

Ordinary TUI prose uses the shared terminal sanitiser and native renderables.
Update blocks and approval diffs instead show control characters as visible
escapes, including terminal escape-sequence payloads. This exposes bytes that
would be written rather than hiding code inside an OSC/DCS sequence. The block's
diff preview and Review use the same full-file diff; viewing the preview does
not itself authorize a write. The underlying response and written bytes are
unchanged. Only explicit clipboard actions emit the TUI's trusted OSC52 sequence.

## Skills

Both interfaces load user-selected Markdown skill instructions from disk and
append them to the system prompt. Discovery includes `SKILL.md` directories and
standalone Markdown skill files. Two things follow from that:

- **A skill changes how the model behaves**, so treat a skills directory like
  code you run: review a skill before using it, particularly one you did not
  write. `ask --dry-run` prints the exact system prompt that will be sent.
- **Only selected instruction text is sent.** Bundled scripts and assets are never
  executed or auto-attached; nothing in a skill can cause either interface to run
  a command. Skills are chosen by the user, never by the model — a model that
  could load a skill on demand would be making a tool call.

Skills are capped at 128 KB each. Discovery and loading read regular files through
a bounded buffer, at most 128 KB plus one overflow-detection byte; growing files
cannot defeat the bound. Oversized files can be listed by their bounded metadata
prefix but cannot be submitted. The CLI reports selection on stderr so an inexact
match cannot silently change the instructions.

In `ask`, `--skill` selects instructions and `/skills` lists/searches locally.
In `ask-tui`, `--skill` and the `/skill` or `/skills` selector are explicit user
selections; `/skills` is an alias of `/skill`, including enabling/disabling skills.
These local actions make no model request. Selected instruction files are re-read
on each submission and their actual loaded size is checked. Missing or oversized
files prevent the request. `/unskill` removes a skill from future prompts.
Removing a skill does not remove earlier answers influenced by it: `/clear`
clears that history while retaining the remaining selection, and `/new` clears
the selected skills too. Skills cannot grant tools or bypass write validation.

## Session data at rest

### CLI disk sessions

Interactive `ask` runs keep a conversation thread so follow-ups need no
`@references`. Piped/scripted runs are one-shot unless `--session <name>` opts in.

- **Location**: `$XDG_STATE_HOME/ask/sessions/<hash>.json` (or `ASK_STATE_DIR`),
  outside repositories by default. Environment overrides can relocate storage.
  Session files use mode `0600`, created directories `0700`.
- **Contents**: questions, `@refs` as typed, skill names, model answers and reported usage.
  **Not** file contents — those are re-read from disk for each request, so the
  thread never becomes a second copy of your source.
- **Attachment boundaries**: `.ask/` is skipped and default state storage is
  outside repositories. The active state directory is not universally excluded
  by filename rules, especially when relocated or explicitly attached. Session
  data can quote source and should be treated as sensitive context.
- **Expiry and pruning**: by default, idle threads expire after 2 hours and oldest
  turns are pruned past a 32k-token history budget. These limits are configurable
  through CLI settings/flags and `ASK_SESSION_TTL`; TTL 0 disables expiry.
- **Compaction**: `ask /compact` sends the thread to the model once and replaces
  it with the summary. The prior thread is kept alongside as
  `<hash>.pre-compact.json`, same permissions, removed by `ask /new`.
- **Clearing**: `ask /clear` removes current questions, answers and the
  pre-compaction backup while retaining reference and skill names separately from
  turns. It does not call the model unless a prompt is supplied. `ask /reset`
  removes the current thread and its retained context; `/new` archives its turns
  and starts fresh. `--no-session` always disables sessions. `ASK_SESSION=0`
  disables them unless an explicit `--session <name>` overrides that default.

Sessions do not change the one-logical-completion policy or enable model tools.

### TUI in-memory conversations

`ask-tui` retains resolved file/folder selections and re-reads their current contents
for each submission. Contents are appended after the user message; prior file
contents are not duplicated in history. Conversation history is only in memory
and is not shared with CLI sessions.

`/clear` clears history, pending edits, usage counters and the visible transcript
while retaining attachments, exclusions, skills and settings. `/new` also clears
attachments, exclusions and skills. Both destroy the transcript's native
renderables, including old answers and diff panels, and clear selection. Theme
and layout preferences remain selected. Unlike CLI `/new`, TUI `/new` does not
archive a conversation to disk.

Footer/sidebar usage comes from provider-reported counts. Missing usage is not
treated as zero and partial totals are labelled. Context-window capacity is
explicitly configured, never guessed or looked up through another request. When
set, it bounds each submission by trimming oldest history or refusing oversized
input; it never changes provider settings. Without it, history has a default cap.

### Other persistent state and saved preferences

Sessions are not the only writes: explicit file edits, CLI project-trust records,
CLI completion installation and TUI theme preferences also write local data.

Confirming `/theme` is the only way `ask-tui` writes configuration (previews do
not). It writes only the user's global `tui.json` or `tui.jsonc`, never a project
or `--config` file, and changes only the validated `theme` value. It refuses a
file that every user can write or another user owns, preserves existing
permissions, creates new files owner-only, and writes atomically. API keys are
never written by this preference operation.

## Writing to a file

### CLI `/write`, `/diff` and `/create`

CLI source writes are opt-in per invocation through `/write` or `/create` (and
their flag forms). The model is not given a write tool: it returns text, and the
CLI writes it to the explicitly named target after checks that fail closed.
For `/write`, other attached files remain read-only references.

The checks exist for specific failure modes rather than as ceremony:

- **A truncated response is refused outright** (`finish_reason: length`). Writing
  one would silently remove the end of the file.
- **A file truncated by the context caps is refused**, because the model never
  saw the part it would be deleting.
- **A response under 25% of the original size is refused**, which catches a model
  answering with a fragment or a comment instead of the file.
- **The file must match HEAD and the index without transformations**, with a
  local undo blob available. Raw bytes (and executable mode on POSIX) are checked
  without invoking filters. `--force` bypasses this, at which point recovery is
  your responsibility.
- **The target is named, not inferred.** `/write <path>` states which file is
  being replaced; other attached files are read-only references. A target that
  does not exist, is not a regular file, or was excluded by the skip rules is
  refused before the request is sent.
- **Symlink targets and symlinked parents are refused**, including dangling links
  and links to files inside the repository. `lstat` distinguishes the link from
  its referent. An already-symlinked cwd/shared ambient ancestor is canonicalised
  rather than treated as a target-path link. `--force` cannot bypass this check.
- **The target is revalidated against a snapshot.** Device/inode identity, version
  metadata, parent-directory identities and exact context bytes are checked before
  the request and again afterwards. A newer edit, replacement, deletion or link
  swap is refused, even if the response is unchanged or Git reports a clean file.

Writes use a same-directory, exclusively created staging file, then revalidate
the target before renaming the completed file over its directory entry. Opening
the original never uses `O_TRUNC`; no-follow flags are used where supported.
Staging failures leave the original intact. A final-component symlink appearing
in the last validation/rename gap is replaced rather than followed. Ordinary
permissions and ownership are preserved, set-ID bits are dropped, and other hard
links keep the old contents. ACLs and extended attributes are not copied.

The final validation and rename are not an atomic compare-and-swap. As with
context collection, portable Node APIs do not guarantee safety against a process
actively swapping parent directories throughout the operation. Temporary-file
cleanup is best effort if a parent is moved or the process is interrupted.

`--diff` performs the same request and prints a patch without writing, which is
the safe way to inspect an edit first. It uses private copies of the captured
original and proposed contents rather than asking Git to reopen the target path.

`/create <path>` writes a *new* file. git is not the safety net there because
creating destroys nothing; instead the path must not already exist, parent
directories are never created implicitly, and the write uses an exclusive-create
flag so a file appearing between the check and the write cannot be overwritten.
A truncated or empty response is refused as above.

### TUI update proposals and approval

`<update>` blocks are ordinary response text, not function calls. Parsing them
never performs I/O. The model may suggest changes to any eligible file attached
to the current request, including one not named in the latest message. The TUI
does not execute those proposals or feed results back in an automatic follow-up.

Actionable targets must exactly match complete attachments from that request
inside the working directory. Truncated attachments, symbolic links, invalid
UTF-8 and failed write snapshots are read-only. Blocks must use the strict
SEARCH/REPLACE grammar; examples in Markdown fences are ignored. Each nonempty
SEARCH must occur exactly once in the original file, and edits cannot overlap.
Any invalid block or non-`stop` completion disables the whole proposal. The TUI
updates existing files only; new-file creation remains a CLI `/create` operation.

After a reply, the TUI lists proposed files with line counts and flags paths that
run code or change automation (CI workflows, package scripts, build files, Git
hooks, shell scripts and dotfiles). Apply and `/apply` only write files whose
full diff was explicitly shown with Review or `/review`. Block actions cover all
pending edits to that file. Cancel revokes its reviewed state without discarding
edits; Reject or `/reject` discards them. Invalid proposals have no action buttons.
The default diff preview is the same full-file diff, but previewing it does not
authorize a write. Applied/rejected blocks show their outcome in the footer.

Each approval diff is built from the exact edit ranges with fixed surrounding
context. Unchanged lines between distant edits are not shown as changes. These
diffs visibly escape control characters and their payloads as described above.

**TUI approval may replace dirty or untracked files without a Git undo copy.**
Unlike CLI `/write`, explicit review is the authorization; CLI size-shrink and
clean-Git requirements are not TUI requirements. All selected snapshots are
preflighted, then each file uses `packages/ask/src/safe-write.ts` for stale-target
checks and atomic replacement. The symlink, parent-path, metadata and portable
filesystem limitations described for CLI replacement apply here too. Multiple
files are written individually, not as a transaction: a later failure can leave
earlier files written, and errors report those paths. Review proposals as
untrusted code and keep your own backups or commits.

## Clipboard and context popups (`ask-tui`)

The TUI emits a clipboard-write OSC52 sequence only after Ctrl+C or
Command/Super+C with a selection, or `/copy`. Copied answers are display-sanitised
first; selecting text copies the visible selection. Model responses cannot
trigger clipboard writes themselves. No external clipboard executable is
launched. OSC52 support and policy belong to the user's terminal/multiplexer;
native mouse selection is available with `--no-mouse` when OSC52 is unavailable.

Forwarded Command/Super+C never exits. Ctrl+V and forwarded Command/Super+V read
plain text through OpenTUI's native host clipboard API, lazily and only in
response to the user's shortcut. Reads are limited to 1 MiB and two seconds and
cancelled on exit. SSH/remote sessions refuse host reads to avoid reading the
wrong machine's clipboard; native terminal paste is still supported.

Native paste is routed to the composer exactly once through OpenTUI's
ANSI-stripping handler. Pasted newlines are data, not submission events. Typed
and pasted `@` mentions must name an existing path or glob, without fuzzy search;
explicit `\@` escapes remain literal text. Pasted content is sent only after the
user submits. A changed draft/cursor/selection causes a delayed host clipboard
read to be discarded rather than overwriting input.

Slash completion and context-management popups are local UI actions, not model
tools. Detaching references or removing skills changes future request assembly;
it never deletes source files or automatically calls the model. Files excluded
from an attached folder are omitted before reading/budget accounting and cannot
be update targets in that request. Restoring exclusions requires an explicit
user action or a new explicit file/folder mention. Context changes are refused
while a request/write or proposal is pending. Removing context cannot erase
information already quoted in earlier answers; `/clear` or `/new` clears that
conversation history.

## Key handling

Both interfaces use layered JSON configuration (see
[Configuration](packages/ask/README.md#configuration)): the
global `~/.config/ask/`, an optional `--config` directory or `$ASK_CONFIG`, the
project's `ask.json(c)` and `.ask/`, `$ASK_CONFIG_CONTENT`, single-setting
`ASK_*` variables, then flags. `.env` files are never loaded as configuration;
when no key is found, a legacy file may be inspected only to diagnose obsolete
settings, not to import them.

**Project layers are untrusted by default.** They are written by whoever wrote
the repository, so until the user runs `ask /trust` they cannot set `endpoint`
(URL, key, organisation, project): otherwise a cloned repository could send your
attachments, history and key to its own server, or supply its own key so your
requests go to an account it can read. Nor can they use `{env:NAME}`, which
would copy any secret in your environment into a request. Ignored settings are
named on stderr (in the TUI, in the transcript). Trust is stored in the state
directory as a SHA-256 of the project's config file paths and contents, so a
modified or added file needs trusting again. Project layers can still set the
model, system prompt and similar preferences; like attached files, those are
content the repository chose, and `--show-config` shows where each came from.

**Instructions are announced and contained.** `AGENTS.md` files and
`instructions` entries are added to the system prompt, so they change what the
model is told. Each run names the files it used. An untrusted project may list
only relative paths inside itself, and its files (including `AGENTS.md`) are
read only if their real path, after symlinks, stays inside the project: a
repository cannot pull `~/.ssh/id_rsa` or another project's files into a
request. Parent directories of the project root are never searched. Credential-
like names and binary files are skipped, sizes are capped, and a missing file is
reported rather than replaced by a ranked search match. `--no-instructions`
skips them all.

**Keys stay with their endpoint.** If a layer changes `endpoint.url` without
setting `apiKey` (or organisation/project), the lower layer's values are dropped
rather than sent to the new URL. A `--base-url` flag is explicit and keeps the
effective key. `OPENAI_*` exports are only defaults, below every config file,
because other tools use the same names.
This pairing also applies when `endpoint.url: null` resets a foreign URL to the
default endpoint: credentials for that foreign destination are dropped.

**Files must be private to you.** Config files that every user can write, or
that another user (other than root) owns, are not read, and the refusal is
always reported, even with `--quiet`. Group-writable files are accepted, as
common umasks create them for the owner's private group. Wrong types are errors
naming the file and setting; unknown settings are reported and ignored.
`--show-config` never prints API keys.

Both request paths refuse a non-loopback `http://` endpoint before creating the
API client. HTTPS and recognised loopback HTTP endpoints are allowed.
`--allow-insecure-http` explicitly opts a single invocation into cleartext
transport, and is not a config setting. The CLI's `--dry-run` and `--show-context`
flags provide offline previews without sending a request.

The key is only ever sent to the configured endpoint as an `Authorization`
header, is never logged, and never appears in `--dry-run` or `--json` output.

## Supply chain

- Release Please uses the built-in `GITHUB_TOKEN` to maintain a version/changelog
  PR on `main`. Merging that PR creates the version tag and GitHub Release. A
  separate job with `actions: write` explicitly dispatches publication at that
  tag; it has no npm token. The GitHub Release exists before npm publication, so
  the tagged publication workflow's result determines whether publication and
  artifact upload completed.
- `@codehaus-au/ask` and `@codehaus-au/ask-tui` are published separately from
  version-tagged GitHub Actions runs, together with matching versions. The TUI's
  core dependency is pinned to the exact released version when pnpm packs
  `workspace:*`; the CLI does not depend on OpenTUI.
  The granular `NPM_TOKEN` repository secret is mapped to `NODE_AUTH_TOKEN` only
  for publishing the already built and installation-tested tarballs. Lifecycle
  scripts are disabled in that step, the destination registry is explicit, and
  npm provenance is generated using the job's OIDC permission. The same tarballs
  are attached to the GitHub Release. Manual runs on branches perform validation
  and a dry-run without an npm publishing secret; version-tagged runs may publish.
- The core package has two direct runtime dependencies: `openai` (the official
  SDK) and `marked` (Markdown parsing for terminal rendering). The TUI additionally
  depends on `@opentui/core`, with native platform packages and transitive
  dependencies, and requires Bun 1.3.14+. The dependency versions and complete
  tree are recorded in `pnpm-lock.yaml`.
- All GitHub Actions are pinned to commit SHAs, with Dependabot keeping them
  current.
- CI runs `pnpm audit`, Trivy (vulns, secrets, misconfig), TruffleHog over full
  git history, CodeQL, actionlint and zizmor. Releases carry a CycloneDX SBOM
  and a signed build-provenance attestation.
