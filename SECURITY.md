# Security policy

## Reporting a vulnerability

Email **mat@codehaus.co** with the details. Please do not open a public issue
for anything exploitable. Expect an acknowledgement within a few working days.

## Threat model

`ask` sends the file contents you name to a third-party LLM endpoint. That is
its whole purpose, so the security properties worth stating are about what it
will *not* do.

### What the tool guarantees

| Guarantee | Enforced by |
| --- | --- |
| No tool / function calling is ever requested | `OneShotRequest` in `src/chat.ts` is the SDK params type with `tools`, `tool_choice`, `functions`, `function_call`, `parallel_tool_calls`, `stream` removed — setting one is a compile error |
| Exactly one HTTP request per invocation | No loop in the codebase; asserted in `test/chat.test.ts` |
| Only one SDK method is reachable | `createClient` returns a one-method `ChatClient`, not the SDK client |
| The model cannot choose what it reads | Context comes only from `@paths` and `-f` flags you pass |
| Nothing is written to your filesystem unless you ask for it | Answers go to stdout. The only writes are the session thread described below, and `--write` / `--force`, which replace one named file under the conditions in the README |
| Only one subprocess, read-only | `git ls-files` enumerates candidate paths for `@search`; it never reads file contents and is skipped outside a git work tree |
| Credentials are not attached by accident | `.env*`, `*.pem`, `*.key`, `*.p12`, `id_rsa`, `credentials.json` and similar are skipped even when named explicitly, unless `--include-secrets` |
| You can see the payload before sending | `--dry-run` prints the exact JSON body; `--show-context` lists attachments and never calls the API |

### What it does not protect against

- **Data egress is the point.** Anything you attach reaches the configured
  endpoint. Check your provider's retention and training terms, and prefer an
  endpoint your organisation already approves via `OPENAI_BASE_URL`.
- **Prompt injection in attached files.** Output is text printed to your
  terminal, never executed — but treat a review of untrusted code as untrusted
  output, and never pipe it into a shell.
- **Binary and minified content.** Skipped by heuristics (extension list, NUL
  byte sniffing), not guarantees. Use `--show-context` when in doubt.
- **Secret detection.** The credential filter is filename-based. It will not
  catch a key pasted into `src/config.ts`.

## Skills

`--skill <name>` reads a `SKILL.md` from disk and appends it to the system
prompt. Two things follow from that:

- **A skill changes how the model behaves**, so treat a skills directory like
  code you run: review a skill before using it, particularly one you did not
  write. `ask --dry-run` prints the exact system prompt that will be sent.
- **Only `SKILL.md` is read.** Bundled scripts and assets are never executed or
  uploaded; nothing in a skill can cause `ask` to run a command. Skills are
  chosen by the CLI, never by the model — a model that could load a skill on
  demand would be making a tool call.

Skills are capped at 128 KB each, and the selection is reported on stderr so an
inexact match cannot silently change the instructions.

## Session data at rest

Interactive runs keep a conversation thread so follow-ups need no `@references`.
This is the tool's only persistent state, and its only write.

- **Location**: `$XDG_STATE_HOME/ask/sessions/<hash>.json` (or `ASK_STATE_DIR`),
  deliberately outside any repository. Mode `0600`, directory `0700`.
- **Contents**: your questions, the `@refs` as typed, and the model's answers.
  **Not** file contents — those are re-read from disk for each request, so the
  thread never becomes a second copy of your source.
- **Never attachable**: `.ask/` is in the skip rules and the state directory
  lives outside the tree, so a session cannot be fed back in as context.
- **Expiry and pruning**: idle threads are discarded after 2 hours
  (`ASK_SESSION_TTL`); oldest turns are dropped past 32k tokens.
- **Compaction**: `ask /compact` sends the thread to the model once and replaces
  it with the summary. The prior thread is kept alongside as
  `<hash>.pre-compact.json`, same permissions, removed by `ask /new`.
- **Clearing**: `ask /new`, or delete the files. `--no-session` / `ASK_SESSION=0`
  disables the feature entirely; piped and scripted runs never use it.

Sessions do not change the one-request property: each invocation still issues
exactly one chat completion, with no tools.

## Writing to a file

`--write` is the only feature that modifies your source tree, and it is opt-in
per invocation. The model is not given a tool and does not choose to write: it
returns text, and the CLI writes that text to the one file you attached, after
checks that fail closed.

The checks exist for specific failure modes rather than as ceremony:

- **A truncated response is refused outright** (`finish_reason: length`). Writing
  one would silently remove the end of the file.
- **A file truncated by the context caps is refused**, because the model never
  saw the part it would be deleting.
- **A response under 25% of the original size is refused**, which catches a model
  answering with a fragment or a comment instead of the file.
- **The file must be tracked and clean in git**, so `git diff` shows exactly what
  changed and `git checkout --` reverts it. `--force` bypasses this, at which
  point recovery is your responsibility.
- **The target is named, not inferred.** `/write <path>` states which file is
  being replaced; other attached files are read-only references. A target that
  does not exist, is not a regular file, or was excluded by the skip rules is
  refused before the request is sent.

`--diff` performs the same request and prints a patch without writing, which is
the safe way to inspect an edit first.

`/create <path>` writes a *new* file. git is not the safety net there because
creating destroys nothing; instead the path must not already exist, parent
directories are never created implicitly, and the write uses an exclusive-create
flag so a file appearing between the check and the write cannot be overwritten.
A truncated or empty response is refused as above.

## Key handling

`OPENAI_API_KEY` is read from the environment or a local `.env`, which is
gitignored. The key is only ever sent to the configured endpoint as an
`Authorization` header, is never logged, and never appears in `--dry-run` or
`--json` output.

## Supply chain

- Two runtime dependencies, pinned by `pnpm-lock.yaml`: `openai` (the official
  SDK) and `marked` (markdown parsing for terminal rendering, itself
  dependency-free). Neither has transitive dependencies, so the whole tree is
  three packages and readable.
- All GitHub Actions are pinned to commit SHAs, with Dependabot keeping them
  current.
- CI runs `pnpm audit`, Trivy (vulns, secrets, misconfig), TruffleHog over full
  git history, CodeQL, actionlint and zizmor. Releases carry a CycloneDX SBOM
  and a signed build-provenance attestation.
