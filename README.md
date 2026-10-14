# ask

[![ci](https://github.com/codehausau/ask/actions/workflows/ci.yml/badge.svg)](https://github.com/codehausau/ask/actions/workflows/ci.yml)
[![security](https://github.com/codehausau/ask/actions/workflows/security.yml/badge.svg)](https://github.com/codehausau/ask/actions/workflows/security.yml)
[![codeql](https://github.com/codehausau/ask/actions/workflows/codeql.yml/badge.svg)](https://github.com/codehausau/ask/actions/workflows/codeql.yml)

One-shot LLM CLI in TypeScript. Attach files or whole directories as context,
ask a question, get a single answer. **No tools, no agent loop, no follow-up
turns** — exactly one `POST /v1/chat/completions` per invocation.

```console
$ ask '@src/context.ts - review this file for me'
```

Works against any OpenAI-compatible endpoint (OpenAI, OpenRouter, Together,
vLLM, Ollama, LM Studio, an internal gateway) via `OPENAI_BASE_URL`.

## Why it is not an agent harness

If your organisation has ruled out agentic coding tools, the distinction that
matters should be enforced in code, not policy:

| Property | This CLI |
| --- | --- |
| Tool / function calling | Impossible to send: `OneShotRequest` in [`src/chat.ts`](src/chat.ts) is the SDK's params type with `tools`, `tool_choice`, `functions`, `function_call`, `parallel_tool_calls`, `stream` **removed**, so setting one is a compile error |
| Turns per invocation | Exactly one request, asserted in [`test/chat.test.ts`](test/chat.test.ts) |
| SDK surface used | One method; `createClient` returns a 1-method `ChatClient`, not the whole SDK client |
| Model-driven file access | None — the model only sees paths **you** name with `@` |
| Writes to your filesystem | Only with `--write`, only to the single file you attached, and only after [checks that fail closed](#editing-a-file). The model is given no tool and cannot choose to write; output otherwise goes to stdout |
| Network calls | One, to the endpoint you configure |
| Runtime dependencies | Two: `openai` (the official SDK) and `marked` (markdown parsing, itself dependency-free) |

Everything the model receives can be printed before sending: `--dry-run` (exact
JSON body) or `--show-context` (attachment list + token estimate, no API call).

## Install

Requires Node.js 20 or newer. Install the published CLI from npm:

```bash
npm install --global @codehaus-au/ask
ask --version
ask --help
```

Update a registry installation with:

```bash
npm install --global @codehaus-au/ask@latest
```

For development, build a source checkout instead:

```bash
git clone git@github.com:codehausau/ask.git
cd ask
pnpm install
pnpm build
cp .env.example .env     # add your key; export OPENAI_BASE_URL for a custom endpoint
```

`.env` is read from the working directory first, then the install root.
**Anything already exported wins over the file**, so a shell `OPENAI_API_KEY` is
never silently replaced by a stale `.env`. If a key cannot be found, the error
lists every file that was checked and what each one defined.

All automatically discovered `.env` files, including install-location fallbacks,
may set only `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_ORG_ID`,
`OPENAI_PROJECT_ID`, and `ASK_MODEL`. Other keys are ignored and their names
reported on stderr (`--quiet` suppresses the notice). Canonical paths are
deduplicated so the same file is loaded once, even through a symlink.
Export settings such as `ASK_SYSTEM`, `ASK_STATE_DIR`, and `ASK_SKILLS_DIR` in
your shell instead, or use the corresponding CLI option where available.

**Choose the endpoint explicitly.** An `OPENAI_BASE_URL` loaded from any automatic
`.env` file is refused before sending a request, even if that file also supplies
an API key or the endpoint is local. Set `--base-url <url>` or export
`OPENAI_BASE_URL` in your shell instead; this prevents a repository from choosing
where your credentials, attached files, and session history are sent. The same
rule applies to `/compact`. Offline `--dry-run` and `--show-context` remain usable.

**Remote endpoints must use HTTPS by default.** HTTP is allowed for recognised
loopback endpoints (`localhost`, `*.localhost`, `127.0.0.1`, and `[::1]`), so
local servers work as before. To deliberately use a non-loopback HTTP endpoint,
pass `--allow-insecure-http`; credentials and context will be sent unencrypted.
This is a per-invocation flag for both normal requests and `/compact`, and does
not authorize an endpoint selected only by a `.env` file.

Or straight from a release, no toolchain required:

```bash
VERSION=0.1.0
npm install --global \
  "https://github.com/codehausau/ask/releases/download/v$VERSION/codehaus-au-ask-$VERSION.tgz"
```

### Make a source checkout available as `ask`

A fresh pnpm installation may have no global binary directory configured.
Run this once:

```bash
pnpm setup
```

**Open a new terminal** so the generated `PNPM_HOME`/`PATH` configuration is loaded.
Then return to the checkout and build/link it:

```bash
cd /path/to/ask
pnpm build
pnpm link --global
pnpm bin --global                       # the global bin directory must be on PATH
command -v ask                          # verify which command the shell will run
ask --version
```

`ERR_PNPM_NO_GLOBAL_BIN_DIR` means the global-bin setup is missing or the current
shell has not loaded it. `pnpm link --global` does not build `dist/src/cli.js`,
so build before linking. If `command -v ask` reports an old alias, remove or update
that alias so it does not shadow the linked command.

Without global linking, run `node ./dist/src/cli.js --help` from the checkout.
This also works when the checkout path contains spaces and needs no shell alias.

For a linked source checkout, upgrading later is:

```bash
cd /path/to/ask
pnpm refresh
```

Reopen the shell when the completion script changes. The global link continues
to use the rebuilt checkout.

## Smoke test

No API key needed, nothing sent:

```bash
pnpm typecheck                                       # strict tsc, no emit
pnpm test                                            # build + unit and integration tests
pnpm smoke                                           # prints the request JSON
node dist/src/cli.js --show-context '@src' 'summarise'
```

Against a real endpoint:

```bash
ask -q '@README.md summarise this in one sentence'
```

## Tab completion and the `@` picker

```bash
ask --install-completion --apply && exec bash
```

That resolves the absolute path itself, writes a guarded block, and clears any
stale lines from earlier attempts — a hand-written `source $PWD/...` line is easy
to get wrong and then errors on every new shell. Omit `--apply` to print the
block instead of writing it; `ASK_RC` overrides the target file.

What `@<TAB>` does depends on whether [fzf](https://github.com/junegunn/fzf) is
installed (`apt-get install fzf`, `brew install fzf`):

**With fzf** — an interactive picker: a highlighted list you move through with
the arrow keys, keep typing to filter, **TAB or ENTER** to insert, ESC to cancel.
Closest thing to an editor's `@` mention. (`askf` keeps TAB for multi-select,
since choosing several files is the whole point of it.)

```console
$ ask @t<TAB>
  ╭──────────────────────────────╮
  │ > t                          │
  │   test/chat.test.ts          │
  │ > test/completion.test.ts    │   ← arrow keys move the highlight
  │   src/context.ts             │
  ╰──────────────────────────────╯
$ ask @test/completion.test.ts
```

**Without fzf** — plain bash completion: a unique match completes, several list.
For cycling behaviour closer to a dropdown, add to `~/.inputrc`:

```
set show-all-if-ambiguous on
set menu-complete-display-prefix on
TAB: menu-complete
"\e[Z": menu-complete-backward
```

TAB then inserts the first candidate and cycles forward, Shift-TAB backwards.

Set `ASK_FZF=0` to force plain completion even when fzf is installed.

TAB completion handles Bash's default `@` word breaks without changing other
commands' completion settings. Returned paths are explicitly shell-quoted before
readline inserts them, including spaces, quotes and command-substitution syntax.
Complete an **unquoted prefix**, then add your quoted question; completion leaves
quoted or nested shell expressions untouched. Picker input/output uses NUL-delimited
records so Git's filename quoting and embedded newlines do not change selected paths.
`ASK_MODELS` is treated as a whitespace-separated list of literal model names;
completion never evaluates shell expansions stored in that variable.

### Opening the picker without TAB

`ASK_AT_KEY=1` makes typing `@` open the picker immediately — no TAB:

```bash
export ASK_AT_KEY=1
source /path/to/ask/completions/ask.bash
```

`@` becomes a readline widget, the same mechanism as fzf's own `CTRL-T`, so it
is deliberately narrow. The picker opens **only** at the start of a word on an
`ask` or `askf` command line; everywhere else `@` inserts a literal `@`:

| You type | What happens |
| --- | --- |
| `ask @` | picker opens, selection inserted as `@path ` |
| `ask @a.ts @` | picker opens again for a second file |
| `ssh user@host` | literal `@` — any other command is untouched |
| `ask name@2x.png` | literal `@` — mid-word, so not a reference |
| picker cancelled (ESC) | literal `@`, as if you had just typed it |

Without fzf, or with `ASK_FZF=0`, `@` stays literal and TAB completion still
works. Set `ASK_AT_KEY=0` (or drop the export) to unbind.

Either way, `@` keeps its prefix:

```console
$ ask @src/ch<TAB>
$ ask @src/chat.ts review this for me
```

| You type | You get |
| --- | --- |
| `@<TAB>` | with fzf, the picker — files **and directories**, so you can attach a whole tree; otherwise everything in the current directory, directories gaining a `/` so you can keep descending |
| `@buried<TAB>` | plain mode: when nothing matches as a prefix, a recursive tree search — the same fallback the CLI performs, git-aware when available |
| `<TAB>` on an empty first word | the verbs `/new`, `/reset`, `/session` |
| `/<TAB>`, `/se<TAB>` | the verbs, filtered |
| `-<TAB>` / `--max-t<TAB>` | flags |
| `--token-field <TAB>` | `max_tokens`, `max_completion_tokens` |
| `-m <TAB>` | models listed in `$ASK_MODELS`, if you export it |
| `-f <TAB>`, `--system-file <TAB>` | plain paths, no `@` |
| anything else | nothing — TAB stays out of the way while you type the question |

Quote only the parts the shell would eat, so completion keeps working:

```bash
ask @src/chat.ts review this file            # no quotes needed
ask @src/chat.ts 'any bugs?'                 # quote the ? only
```

zsh, using bash's completion bridge:

```bash
autoload -U +X bashcompinit && bashcompinit
source /path/to/ask/completions/ask.bash
```

### Picking several files

Sourcing the same file also defines `askf` when fzf is installed. Same picker,
but TAB selects multiple files before the question is passed through:

```console
$ askf review these for consistency
```

## Usage

```bash
ask '@src/cli.ts review this file for me'           # one file
ask '@src @test where is the control flow?'         # directories
ask -f 'name with spaces.ts' 'any bugs?'            # explicit path
git diff --staged | ask 'review this diff'          # stdin
ask '@docs/cot.md is this CoT taxonomy consistent?' > review.md
```

`@ref` tokens are pulled out of the prompt; everything else stays as the
question. Attachments are rendered as `<file path="...">…</file>` blocks ahead of
the question, in sorted order, so the same tree always yields the same prompt.

### How `@ref` resolves

Three cases, tried in order, so the cheap and unambiguous ones win:

| You write | Meaning |
| --- | --- |
| `@src/chat.ts`, `@src` | **path** — it exists on disk, used verbatim, no searching |
| `@"name with spaces.md"` | **quoted path** — the explicit way to name a file whose name contains spaces |
| `@'src/**/*.ts'` | **glob** — `*` and `?` stay within a path segment, `**` crosses them. Quote it, or the shell expands it first |
| `@chat` | **search** — ranked substring search over the tree |

Search ranks candidates so the obvious answer wins: exact basename, then
basename without extension, then basename prefix, then basename substring, then
path substring; ties break on shortest path. `@chat` in this repo picks
`src/chat.ts` over `test/chat.test.ts`.

```console
$ ask --show-context '@chat'
match   @chat → src/chat.ts [search]
attach  src/chat.ts  4.6 KB
```

A search that ties at the best rank is an error, not a guess:

```console
$ ask '@dup summarise'
ask: @dup matches 2 paths equally well
      a/dup.ts
      b/dup.ts
      name one of them, use a glob, or pass --all-matches
```

### Filenames with spaces

A space would otherwise end the reference, so `@tender/101521 Quotation.docx`
would look for `tender/101521`. Two ways through:

```bash
ask '@"tender/101521 Quotation.docx" what is this'   # explicit
ask '@tender/101521 Quotation.docx what is this'     # also works
```

The second works because a reference that resolves to nothing tries absorbing
the words that follow it, and keeps the **longest** result that is a real path:

```
-- read @tender/101521 Quotation.docx as one path (spaces)
```

Only an existing path can absorb words, so this cannot quietly eat question text.
`-f 'name with spaces.md'` remains available and needs no `@` at all.

### Binary documents are not attachable

`.docx`, `.xlsx`, `.pptx` and `.pdf` are archives or binary formats, so there is
nothing useful to send as text and `ask` refuses rather than attaching noise:

```console
$ ask '@quote.docx what is this doc'
-- quote.docx is not text, so nothing was attached
-- convert it and pipe the text in instead, e.g.
--   pandoc -t plain 'quote.docx' | ask 'what is this document?'
--   pdftotext file.pdf - | ask 'summarise this'
```

Piping is the answer: conversion belongs to tools that do it well, and keeping it
outside `ask` means no extra subprocess or dependency in a tool whose trust story
is its smallness.

Search only ever offers files that would actually be attached — the skip rules
below apply to the search index too, so `node_modules`, binaries, lockfiles and
credential-looking files are never matched. Every non-literal resolution is
printed to stderr before the request goes out, so you always know what was sent.

Inside a git work tree the candidate list comes from `git ls-files --cached
--others --exclude-standard`, so `.gitignore` is respected and build output does
not crowd out your source. Git is the CLI's only subprocess executable, used for
metadata and diff previews through a hardened wrapper. It does not supply file
contents for prompts. Outside a repo (or if Git is missing or lacks the required
safety options) search falls back to a filesystem walk. Either way the listing is capped at
50,000 entries, and if the cap bites, the error says so rather than claiming the
file does not exist.

Git calls disable fsmonitor, pagers, optional index writes and lazy fetching, and
discard inherited Git overrides and loader/shell startup injection variables.
Diff previews also disable external diff/textconv and isolate attribute handling,
since even `git diff --no-index` can otherwise invoke clean/process filters.
Completion's Git calls use the same restrictions in a subshell.

A Git version supporting `--no-lazy-fetch` is required for Git-backed operations.
Unsupported safety flags are never silently dropped: search falls back as above,
diff previews report Git unavailable, and `/write` requires an explicit `--force`
when Git cannot verify the undo copy.

### Options

| Flag | Meaning |
| --- | --- |
| `-m, --model <name>` | model id (env `ASK_MODEL`, default `gpt-4o-mini`) |
| `-s, --system <text>` / `--system-file <path>` | system prompt (env `ASK_SYSTEM`) |
| `--base-url <url>` | OpenAI-compatible endpoint (env `OPENAI_BASE_URL`) |
| `--allow-insecure-http` | explicitly allow unencrypted HTTP to a non-loopback endpoint |
| `--api-key <key>` | API key (env `OPENAI_API_KEY`) |
| `-f, --file <path>` | attach a path explicitly; repeatable |
| `--max-tokens <n>` / `--temperature <n>` | only sent when set |
| `--token-field <name>` | force `max_tokens` or `max_completion_tokens` |
| `--max-file-bytes` / `--max-total-bytes` / `--max-files` | context caps |
| `--skill <name>` | prepend a skill's instructions; repeatable, searched if inexact |
| `--list-skills` / `/skills [term]` | list or search available skills |
| `--create <path>` / `/create` | write a new file; refuses if it exists |
| `--write <path>` / `/write <path>` | replace that file with the answer |
| `--diff <path>` / `/diff <path>` | show the proposed change, write nothing |
| `--force` | allow `--write` on a dirty or untracked file, and bypass the size check |
| `--all-matches` | attach every search match instead of the single best one |
| `--include-secrets` | stop skipping `.env`, `*.pem`, key-ish files |
| `--show-context` | list attachments and exit |
| `--dry-run` | print the request JSON and exit |
| `--json` | machine-readable result (text, usage, attachments) |
| `-q, --quiet` | drop the stderr footer |
| `--raw` | skip Markdown rendering; terminal control sanitisation still applies on a TTY |
| `--no-next` | do not suggest a follow-up command (also `ASK_NEXT=0`) |
| `-V, --version` | print the version |

Exit codes: `0` ok, `1` runtime/API error, `2` usage or configuration error, or
an `@ref` that matched nothing / matched ambiguously.

While a request is in flight a spinner shows the model and elapsed time, which
matters when a local model takes half a minute:

```
⠹ asking qwen2.5-coder:7b… 12.4s
```

It writes to stderr and only animates when stderr is a terminal, so piped output
and CI logs stay clean; the line is erased before the answer prints. `--quiet`,
`ASK_SPINNER=0`, `TERM=dumb` or any `CI` variable disables it, and
`ASK_SPINNER=ascii` (also used automatically on a non-UTF-8 locale) swaps braille
for `-\|/`.

### Rendered answers

On a terminal the answer is rendered rather than dumped: headings bolded, lists
bulleted, tables aligned, and fenced code framed with shallow syntax
highlighting for TypeScript/JavaScript, JSON, shell, YAML and XML.

```
┌─ ts
  // Newer models reject max_tokens.
  export function tokenLimitField(baseURL: string | undefined): TokenField {
    if (!baseURL) return "max_completion_tokens";
  }
└─
```

**Redirected answers are neither rendered nor sanitised**, even with
`FORCE_COLOR=1`. Use `ask '…' > out.md` to retain the answer text, or
`ask --json '…' | jq` for structured output. `--raw` skips Markdown rendering on
a terminal, and `--no-color`/`NO_COLOR` disables rendering along with colour.

On a terminal, answers and `/compact` summaries have control sequences removed
before styling, including clipboard/title/hyperlink commands and cursor/erase
sequences. This also applies under `--raw` and `--no-color`. Ordinary Unicode,
tabs and newlines survive; CRLF becomes LF, lone CR is dropped, and Unicode
direction-format controls are shown as escapes. Filenames, skill/session names,
status lines and other single-line fields show controls as visible escapes so
they cannot forge additional rows. Shell hints retain those characters in safely
quoted form, so copying them still names the original file. JSON shown on a TTY
escapes additional C1/format controls without changing its parsed values.

Two rough edges in model output are smoothed over first: a stray empty fence is
dropped rather than framed, and a document wrapped in a ` ```markdown ` fence that
contains its own fences gets the outer fence widened to four backticks — otherwise
CommonMark ends the block at the first inner fence and the rest of the document
spills out as though it were the answer's own prose. That repair only fires when
there is exactly one markdown-tagged fence with fences inside it.

Two deliberate limits:

- **Highlighting is shallow** — comments, strings, numbers and keywords, matched
  once per line. Every branch either styles a token or emits it verbatim, so a
  bug can only mis-colour a word, never mangle code. A test asserts that stripping
  the escapes from any highlighted sample returns the input exactly.
- **Two dependencies, not thirty.** `marked` parses the markdown (it has no
  dependencies of its own) and the ANSI renderer here is ~200 lines.
  `marked-terminal` would look better and pull in `highlight.js`, `yargs` and
  `parse5` behind it; that trade costs the claim at the top of this README.

### Colour

Status is dimmed, warnings are yellow and errors are red. Answer and diff
rendering add their own styling only when stdout is a terminal:

```
⠹ asking qwen2.5-coder:7b… 12.4s          ← dim, stderr
The rendered answer.                    ← stdout
-- qwen2.5-coder:7b | thread ask turn 2   ← dim, stderr
```

Opt out with `--no-color` or [`NO_COLOR=1`](https://no-color.org); force it on
for status/listing output with `FORCE_COLOR=1`. `NO_COLOR` wins over `FORCE_COLOR`.
Forcing colour does not enable answer/diff rendering on redirected stdout.

`api.openai.com` gets `max_completion_tokens` (newer models reject
`max_tokens`); every other base URL gets `max_tokens`. Override with
`--token-field` if your gateway disagrees.

## Editing a file

### Suggested next command

Because a one-shot tool cannot take the next step itself, **you** are the loop —
so it tells you what the next command would be:

```console
$ ask '@src/chat.ts why does tokenLimitField swallow a malformed URL?'
...the answer, which happens to mention src/refs.ts...

-- next: ask '@src/chat.ts @src/refs.ts why does tokenLimitField swallow a malformed URL?'
--       (src/refs.ts was mentioned but not attached)
```

The suggestions are computed here, not asked of the model, so they cost no tokens
and cannot be invented: a path is only offered if it **exists on disk**, and the
flags come from this CLI rather than a model's memory of it.

| When | Suggested |
| --- | --- |
| the answer names a file that exists but was not attached | re-ask with it attached |
| the answer hit the token cap | `--max-tokens` at double what it used |
| an attached file was truncated by the caps | `--max-file-bytes 524288` |
| an edit was asked for, answered with exactly one code block, and not applied | `ask /write <file> '<question>'` |
| the thread's history passes ~8k tokens | `ask /compact` |

At most two are shown, on stderr, and `--no-next` or `ASK_NEXT=0` turns them off.

What this deliberately cannot do is suggest *intent*. It knows `src/refs.ts` was
mentioned; it has no idea why. A model could say "check whether `globToRegExp` has
the same unguarded catch", but that costs tokens on every request and would need
validating against the filesystem anyway — which is what these rules already do.

**`@` attaches, it does not edit.** `ask '@test.ts add another function'` answers
in the terminal and leaves the file alone — so when the request reads like an
instruction, the footer points at the verb that would apply it:

```console
$ ask '@test.ts add another function'
...the answer...
-- nothing was written. To apply an answer like this to the file:
--   ask /write 'test.ts' 'add another function'
--   ask /diff  ... to preview it first
```

That is a suggestion, never an inference. Treating "mentions a file, sounds like
an instruction" as permission to overwrite is the failure this design is built to
avoid; naming the target is what makes the intent unambiguous.

`/write <path>` replaces that file with the model's answer, and `/diff <path>`
previews the change without touching anything (`--write` and `--diff` are the
flag aliases). **The target is named, never inferred** — the file is attached
automatically, and any `@refs` you add are read-only references:

The path may be written `@src/env.ts` if that is the habit; the sigil is
accepted and stripped.

```console
$ ask /write src/env.ts '@src/skip.ts match the comment style in skip.ts'

$ ask /diff src/chat.ts 'add a docstring to tokenLimitField'
diff --git a/src/chat.ts b/ask-proposed-chat.ts
@@ -78,6 +78,10 @@
+/**
+ * ...
+ */

$ ask /write src/chat.ts 'add a docstring to tokenLimitField'
-- wrote src/chat.ts: 157 → 161 lines, 4.6 KB → 4.8 KB
-- review with 'git diff', undo with 'git checkout --'
```

This is the only feature that modifies your source tree, so it refuses rather
than risk it. **The model never decides to write** — you pass the flag, and the
CLI writes. Every one of these must hold:

| Refused when | Why |
| --- | --- |
| the target does not exist | that is `/create`'s job, and the message says so |
| the target is not a regular file | a directory or device is not editable |
| the target or a parent on its path is a symbolic link | Git would validate a different object from the one being edited; name the real path instead |
| the target was not attached | the skip rules exclude credentials, lockfiles and binaries; writing one would rewrite it from contents the model never saw |
| the target was truncated by the context caps | the model never saw the end of it, so its answer would delete code |
| the response hit the token cap (`finish_reason: length`) | **the most dangerous case** — writing a truncated answer silently chops the file |
| the response is empty | nothing to write |
| the response is under 25% of the original size | looks like a partial answer rather than an edit (`--force` overrides) |
| HEAD, index and raw worktree bytes/mode do not match, or the undo blob is unavailable | Git must have an available undo copy (`--force` overrides) |
| the target's identity, contents or parent directories changed during the request | the answer was generated from a stale file; retry, even when using `--force` |

Path and context checks run before the request. The response and current target
are checked again afterwards, and Git state is checked before applying a change.
The Git check uses metadata plus an in-process raw-byte hash rather than
`git status`, which can run configured clean/process filters. It supports SHA-1
and SHA-256 repositories and does not trust assume-unchanged flags. Files that
only match Git after filtering or CRLF conversion conservatively require
`--force`, even if an ordinary `git status` reports them clean.
`--force` only overrides Git cleanliness/tracking and the response-size floor;
it does not bypass symlink or stale-target checks. `/diff` uses the same target
guards and compares private copies of the original context and proposed text.

An update is written to an exclusive temporary file beside the target and synced
before a final validation and rename. A staging failure leaves the source intact.
Ordinary permission bits (including executable bits) and ownership are preserved;
set-ID bits are not carried over. Replacement updates only the named path, so
other hard links retain the original contents. Other metadata such as ACLs or
extended attributes is not copied.

Other behaviour worth knowing:

- A markdown code fence wrapping the **whole** answer is stripped, and reported.
  A file that legitimately contains fences (like this README) is left alone.
- The file's trailing-newline convention is preserved.
- In write mode the answer goes to the file, not stdout, and the thread records
  `(wrote src/chat.ts: …)` rather than the file contents.
- Write mode replaces the system prompt with one demanding the complete file and
  nothing else; `--system` still overrides it.
- An answer identical to the file reports `unchanged` and writes nothing, leaving
  the mtime alone.

### Creating a new file

`/create <path>` writes a file that does not exist yet:

```console
$ ask /create test/env.test.ts '@src/env.ts @test/refs.test.ts write tests for env.ts in this style'
-- created test/env.test.ts: 74 lines, 2.1 KB
-- untracked; review it, then 'git add test/env.test.ts'
```

Two differences from `/write`:

- **Any amount of context is allowed.** For a new file you usually want several
  files as examples, so the one-file rule does not apply.
- **git is not the safety net**, because creating destroys nothing. The guard is
  simply that the path must not exist — clobbering is `/write`'s job. Parent
  directories are never created implicitly, and the write itself uses an
  exclusive-create flag so nothing can slip in between the check and the write.

Refused if the path exists, the parent directory does not, `/write` or `/diff`
were also passed, the response is empty, or the response hit the token cap.
There is no minimum-size check: a one-line file is a perfectly good new file.

The redirection you might otherwise reach for — `ask '...' > new.ts` — saves the
model's prose and code fence into the file as well. `/create` uses a system
prompt demanding the bare file contents, and strips a wrapping fence if one
appears anyway.

## Skills

A skill is reusable instructions with `name` and `description` front matter. Two
layouts work, and they can be mixed in one tree:

```
skills/
  bmad-code-review/
    SKILL.md            conventional form; may sit beside assets/ and scripts
  cot-review.md         single-file form, which is all a rubric needs
  tak/
    cot-author/
      SKILL.md          grouping directories are walked, up to 3 levels deep
  README.md             ignored, along with LICENSE/CHANGELOG/CONTRIBUTING/index
```

The conventional layout is the one agent harnesses use, so an existing skills
directory works unchanged. A directory containing `SKILL.md` is **one** skill —
markdown beside it is that skill's own material, not more skills.

```console
$ ask /skills                    # list what is available
$ ask /skills code-review        # search names and descriptions

$ ask --skill code-review '@src/chat.ts review this'
-- skill bmad-code-review [search]
```

The skill's body is appended to the system prompt, wrapped in
`<skill name="...">`: instructions belong there, not in the user message
alongside your files. `--skill` is repeatable and composes in the order given.

| Behaviour | Detail |
| --- | --- |
| Where skills come from | `$ASK_SKILLS_DIR` (colon-separated), then `.ask/skills` and `.agents/skills` **in the current directory and every ancestor**, then `~/.config/ask/skills` and `~/.claude/skills`. First match wins, so a repository-local skill shadows a personal one |
| Ancestor search | working in `repo/packages/thing` finds `repo/.agents/skills`, the way git finds its root — no configuration needed for a workspace-level skills directory |
| Nesting | grouping directories are walked to 5 levels, which reaches a synced layout like `skills/synced/<bucket-id>/<skill>/SKILL.md`; symlink loops are guarded, and `assets/`, `scripts/`, `resources/`, `templates/`, `node_modules` and dot-directories are skipped |
| The single-file trade-off | inside a directory dedicated to skills, any `.md` counts as one, so a scratch file will show up in `ask /skills` until you remove it |
| Selection | exact name, else a ranked search over names and descriptions; a tie lists the candidates instead of guessing, and any search match is reported before the request |
| What is read | **`SKILL.md` only.** Bundled `assets/` and scripts are ignored — a one-shot CLI cannot run them, and a large skill directory would silently eat the context budget. Attach files a skill refers to with `@` |
| Front matter | stripped; it is metadata, not instructions |
| Size limit | 128 KB per skill, refused above that |
| Sessions | skills carry across a thread like `@refs`, re-read from disk each turn |
| Cost | shown on its own line by `--show-context`, and named in the footer |

```console
$ ask --skill code-review --show-context '@package.json review'
estimated tokens for the next request
  files     ~400
  skills    ~1013 (bmad-code-review)
  question  ~2
  system    ~45
  total     ~1460
```

**The model never selects the skill.** A model that could choose what to load
would be making a tool call, which is the one thing this tool does not do. You
name it, or the CLI searches and tells you what it picked.

> **Skills written for agents may not fit.** A skill that says "launch parallel
> reviews" or "conversationally guide the user through…" assumes tools and many
> turns. In one shot the model can only approximate it. The skills that work well
> here are rubrics — what to check, what to prefer, how to report — rather than
> conversation scripts.

## Sessions

Interactive runs continue the previous conversation for the current repository,
so a follow-up needs no `@references`:

```console
$ ask '@src/chat.ts what does this do?'
...
-- gpt-4o-mini | thread ask turn 1 | 1 file(s) 4.6 KB | tokens in 1174 out 210

$ ask 'now explain the token field logic'
...
-- gpt-4o-mini | thread ask turn 2 | 1 file(s) 4.6 KB | tokens in 1502 out 260
```

```bash
ask /new '<prompt>'   # file the thread away, start fresh, then ask
ask /new              # file the thread away and start fresh
ask /reset            # throw the current thread away
ask /session          # show the current thread, no API call
ask /sessions         # list this repository's threads
ask /switch <name>    # switch thread, creating it if new
ask /write <path> '<prompt>'     # edit that file (@path accepted too)
ask /diff  <path> '<prompt>'     # preview that edit
ask /create <path> '<prompt>'   # write a new file
ask /skills [term]              # list or search skills
ask /compact          # summarise the thread into notes, files stay attached
```

### `/new` keeps the old conversation

`/new` does not delete anything. It files the current thread away under a
timestamped name and starts the slot empty, so threads accumulate:

```console
$ ask /new
-- archived 4 turn(s) as default-20260928-1032; started a new thread
--   come back with 'ask /switch default-20260928-1032'

$ ask /sessions
threads for takbot

* default                  empty
  default-20260928-1032      4 turn(s)  ~820 tokens  2026-09-28T10:32:11.402Z  (archived)
  default-20260927-1655      9 turn(s)  ~2.1k tokens 2026-09-27T16:55:03.881Z  (archived)
```

`/reset` is the destructive one: it throws the current thread away and keeps
nothing. The ten most recent archives per name are kept; older ones are removed
when a new archive is made.

### Switching threads

Keep separate conversations for separate lines of work in the same repository:

```console
$ ask /switch refactor
-- switched to thread refactor (new)

$ ask 'how would I split this module?'        # goes to `refactor`

$ ask /sessions
threads for ask

* refactor               1 turn(s)  ~11 tokens  2026-09-26T02:58:41.479Z
  default                4 turn(s)  ~820 tokens  2026-09-26T02:41:03.012Z

* = active. Switch with 'ask /switch <name>'.

$ ask /switch default
-- switched to thread default (4 turn(s))
```

`/switch` persists per repository, so a new terminal in the same repo continues
where you left off. Name precedence, highest first:

| Source | Scope |
| --- | --- |
| `--session <name>` | this invocation only |
| `ASK_SESSION=<name>` | this shell — useful for two terminals on two threads |
| `/switch <name>` | this repository, until switched again |
| `default` | when none of the above apply |

`ASK_SESSION=0` still means "no sessions at all" rather than a thread named `0`.
Names are restricted to letters, digits, dot, dash and underscore, since they
become a filename component.

### Seeing what it costs

Three views, none of which call the API:

```console
$ ask --show-context '@src' 'follow up'   # what the next request would cost
...
estimated tokens for the next request
  files     ~3314
  history   ~20
  question  ~4
  system    ~34
  total     ~3372

$ ask /session                            # thread size and spend so far
thread ask  2 turn(s)
history ~20 tokens, resent every turn
spent   200 in / 40 out
```

After every answer the footer reports the real numbers from the endpoint, and
from turn 2 onward the running thread total:

```
-- gpt-4o-mini | thread ask turn 2 | 1 file(s) 2.3 KB | tokens in 1502 out 260
-- thread total: 2.7k in / 340 out over 2 turns (~820 history resent next turn)
```

`spent` counts only turns where the endpoint reported usage, and says so
(`2/3 turns`) when some did not — a partial total is never passed off as complete.

`--new` / `--reset`, `--show-session` and `--no-session` are flag aliases for
scripting. It is still **one request per invocation** — a session only decides
what goes into that request. No tools, no loop.

### The rules, and why

| Rule | Reason |
| --- | --- |
| **Implicit only when stdout is a terminal.** Piped and scripted runs are always one-shot | `git diff \| ask 'review'` in a loop must stay reproducible. `--session <name>` forces sessions on anyway |
| **Turns store your question, the refs as typed, and the answer — never file contents.** Files are re-read from disk each turn | A follow-up after an edit sees current code, and a file is sent once per request rather than once per turn |
| **Scoped to the git repo root** (falling back to cwd) | You ask about a codebase, not a terminal. Each project gets its own thread |
| **Idle threads expire after 2 h** (`ASK_SESSION_TTL`, minutes) | Yesterday's conversation should not colour today's unrelated question |
| **Oldest turns are pruned past 32k tokens** (`--session-max-tokens`), and pruning is announced on stderr | The whole thread is resent every turn, so silent growth is the one thing implicit state must not do |
| **Stored `0600` under `$XDG_STATE_HOME/ask/`** (or `ASK_STATE_DIR`), outside any repo, and `.ask/` is in the skip rules | A session quotes your source. It must also never be attachable, or the model reads its own transcript back as "code" |
| **`--dry-run` includes the assembled history**; the footer always names the thread and turn | Implicit state has to be visible, and "you can always see exactly what is sent" is the audit story |

Refs from earlier turns that no longer resolve (renamed, deleted) are dropped
with a note rather than failing the follow-up.

### Compacting

A long thread can be summarised into continuation notes:

```console
$ ask /compact
- src/skip.ts holds the shared skip rules
- decided: search and attachment must use the same filters
- open: whether .tmp should be configurable

-- compacted 9 turn(s): ~8400 → ~180 tokens of history
-- 2 file(s) stay attached; previous thread kept at .../sessions/<id>.pre-compact.json
```

- **Still one request per invocation.** `/compact` *is* the request; nothing is
  ever summarised behind your back during a normal question. That is why it is
  an explicit verb rather than something pruning does automatically.
- **Files stay attached** — every ref from the compacted turns carries over, and
  is re-read from disk as usual.
- **Lossy, so recoverable.** The pre-compaction thread is kept alongside as
  `<id>.pre-compact.json`; `ask /new` removes both.
- **The summary is printed** so you can see what was kept, and the footer reports
  the before/after token count. If the summary is no smaller than the thread —
  which happens on short threads — it says so.
- `--compact` is the flag alias; `--dry-run` shows the summarisation request
  without sending it.

> **Cost.** Every turn resends the history plus current file contents. A 6k-token
> file over five turns is ~37k input tokens, not 6k. Use `ask /session` to see
> the thread, `/new` liberally, and `--no-session` for one-offs. On a local model
> with a small context window, prefer `/new` per question.

## Local models (Ollama, llama.cpp, LM Studio, vLLM)

Any OpenAI-compatible endpoint works. For Ollama:

```bash
ollama serve
ollama pull qwen2.5-coder:7b

export OPENAI_BASE_URL=http://localhost:11434/v1
export ASK_MODEL=qwen2.5-coder:7b
ask '@src/chat.ts review this file for me'
```

No API key is needed — a loopback `OPENAI_BASE_URL` (`localhost`, `127.0.0.1`,
`[::1]`) skips the key requirement, since local servers ignore the
`Authorization` header. A remote endpoint still requires one.

Two things are handled for you: the request carries `max_tokens` rather than
`max_completion_tokens` (Ollama rejects the latter), and nothing tool-related is
ever sent, so models without tool support are unaffected.

> **Mind the context window.** Ollama defaults to a small `num_ctx` (2–4k
> tokens) and **silently truncates** anything longer — a 20 KB file becomes a
> confidently wrong answer. Check the size before you send it with
> `ask --show-context '@src'`, and raise the window:
>
> ```bash
> OLLAMA_CONTEXT_LENGTH=32768 ollama serve
> ```
>
> Or bake it into a model: `ollama create mymodel -f Modelfile` with
> `PARAMETER num_ctx 32768`. `ask`'s own caps (256 KB per file, 1 MB total) are
> far larger than a typical local window, so lower them with
> `--max-total-bytes` when working locally.

## What gets attached from a directory

Walks are sorted and filtered so a `@src` reference stays cheap and predictable:

- **skipped dirs**: `.git`, `node_modules`, `dist`, `build`, `target`,
  `coverage`, `.next`, `.gradle`, `.venv`, `__pycache__`, `.terraform`, …
- **skipped files**: binary extensions, files containing NUL bytes, lockfiles
- **skipped credentials**: `.env*`, `*.pem`, `*.key`, `*.p12`, `id_rsa`,
  `credentials.json`, … — even when named explicitly, unless `--include-secrets`
- **symlinks**: exact, glob and search results are canonicalised before use.
  Aliases that redirect outside the working directory are skipped, including
  directory references and symlinked parent components. Secret-name checks apply
  to both the supplied name and the real target. `--include-secrets` does not
  override outside-tree symlink rejection. Directory walks skip nested symlink
  entries; explicitly referenced internal aliases remain usable. Directly named
  outside files/directories without redirecting links remain explicit choices.
- **caps**: 256 KB per file (truncated with a marker), 1 MB total, 200 files

Skips are reported by `--show-context` and in `--json` output, so nothing is
dropped silently. The footer prints the real token usage returned by the API.
Unresolvable paths, unreadable files and detected path replacements are skipped.

## Layout and development

```
src/next.ts           deterministic "what to run next" suggestions
src/render.ts         markdown → ANSI for a terminal, over marked's tokens
src/highlight.ts      shallow, lossless code highlighting
src/skills.ts         SKILL.md discovery, selection and injection
src/refs.ts           @ref → paths: exact path, glob, or ranked search
src/skip.ts           skip rules shared by attachment and search
src/context.ts        resolved paths → sorted, filtered, capped text blocks
src/chat.ts           request builder + one-shot transport (no tools by construction)
src/options.ts        the flag table, shared with the completion test
src/cli.ts            flags, stdin, .env, output modes
completions/ask.bash  bash/zsh completion + optional fzf picker
test/                 node:test, no network, no key required
```

`test/completion.test.ts` drives the completion function through a bash harness
and asserts its flag list matches `src/options.ts`, so adding a flag without
updating the completion script fails CI.
`test/completion-pty.test.ts` also drives real Bash/readline TAB and ENTER through
a Python 3 standard-library PTY harness, checking the arguments the shell actually
passes. The fzf cases run when fzf is installed. Development tests require Bash,
Git, Python 3 and pnpm; these are test tools, not additional runtime dependencies.
`test/install-global.test.ts` verifies `pnpm setup` and global linking in an
isolated home, without modifying the developer's shell configuration.

Strict TypeScript (`strict`, `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`, `verbatimModuleSyntax`). Relative imports are
written with `.ts` extensions and rewritten to `.js` on build, which gives two
ways to run:

```bash
pnpm build && node dist/src/cli.js '@src summarise'   # compiled (what `ask` uses)
pnpm dev '@src summarise'                             # no build, type-stripped
pnpm test          # compiled tests
pnpm test:dev      # same tests, no build
```

`pnpm dev` / `pnpm test:dev` use Node's type stripping, which prints an
experimental warning on Node 22 and needs no flag from Node 23.6.

## CI/CD

All GitHub Actions are pinned to commit SHAs; workflow tokens default to
`permissions: {}` with the minimum granted per job. Dependabot keeps both the
npm deps and those SHA pins current.

| Workflow | Trigger | What it does |
| --- | --- | --- |
| [`ci.yml`](.github/workflows/ci.yml) | push, PR | `tsc --noEmit`; shellcheck on the completion script; tests on Node 20/22/24; offline CLI previews; packs and installs the tarball, verifies its version/completions, and runs an npm publish dry-run |
| [`security.yml`](.github/workflows/security.yml) | push, PR, weekly | `pnpm audit` (runtime blocking, dev advisory); dependency review on PRs; Trivy vulns + secrets + misconfig; TruffleHog over full git history; actionlint + zizmor on these workflows; CycloneDX SBOM artifact |
| [`codeql.yml`](.github/workflows/codeql.yml) | push, PR, weekly | CodeQL `security-extended` for javascript-typescript |
| [`scorecard.yml`](.github/workflows/scorecard.yml) | weekly, branch protection changes | OpenSSF Scorecard (public repos only; guarded by a visibility check) |
| [`release-please.yml`](.github/workflows/release-please.yml) | push to `main`; manual on `main` | maintains a version/changelog PR; when merged, creates its tag and GitHub Release and dispatches npm publication at that tag |
| [`release.yml`](.github/workflows/release.yml) | dispatch at a release tag; tag `v*.*.*`; manual validation | typecheck, test, audit, tag/version match check, pack and test one tarball, npm dry-run, SBOM, GitHub attestation, npm publication with provenance, then attach the same tarball to the GitHub Release |

Run the same gates locally:

```bash
pnpm check           # typecheck + tests + runtime audit
pnpm lint:workflows  # actionlint + zizmor, as the security workflow runs them
```

`lint:workflows` needs `actionlint` and `zizmor` on your `PATH`
(`pip install zizmor`, and actionlint's `download-actionlint.bash`). Two things
that will otherwise hide findings CI does see: zizmor fails on **low**-severity
findings, so do not filter with `--min-severity`; and it must be pointed at
**`.github/`**, not `.github/workflows/`, because `dependabot.yml` is audited
too.

Two deliberate choices worth knowing about:

- **CodeQL needs code scanning**, which is free on public repos and requires
  GitHub Advanced Security on private ones. If this repo is private without
  GHAS, delete `codeql.yml`; the blocking Trivy and audit jobs are unaffected.
- **`release.yml` disables the dependency cache** so a poisoned cache entry
  cannot reach a published artifact (flagged by zizmor's `cache-poisoning`
  audit).

### npm publishing setup

The npm package is **`@codehaus-au/ask`**; the GitHub repository remains
`codehausau/ask`. The publishing account must have access to the npm `codehaus-au`
scope, including permission to create this package for the first release.

Create a **granular npm access token** with read/write package access for that
scope and **Bypass 2FA** enabled for unattended publishing. Store it in this
repository under **Settings → Secrets and variables → Actions → New repository
secret**, named **`NPM_TOKEN`**. Keep it out of `.env` and version control, and
renew the secret before the token expires. An npm token is not an OpenAI API key.

The workflow exposes that secret as `NODE_AUTH_TOKEN` only in the npm publishing
step. `actions/setup-node` configures npm registry authentication, and the existing
`id-token: write` permission supplies the identity for npm provenance. Publishing
uses the already tested tarball with lifecycle scripts disabled; it does not
rebuild the package while the token is available.

### Automatic versioning and releases

Enable **Settings → Actions → General → Workflow permissions → Allow GitHub
Actions to create and approve pull requests** (the organization must permit it
too). Release Please uses the built-in `GITHUB_TOKEN`; the only additional secret
needed for publication is `NPM_TOKEN`. Permissions are scoped per job, including
`actions: write` for the publication dispatch.

1. Merge changes into `main` using [Conventional Commits](https://www.conventionalcommits.org/):
   `fix:` bumps the patch version, `feat:` bumps the minor version, and `!` or a
   `BREAKING CHANGE:` footer marks a breaking change. Before 1.0, breaking changes
   bump the minor version; from 1.0 onward, they bump the major. For squash merges,
   use a conventional squash-commit title. Documentation/chore-only changes do
   not normally open a new release PR.
2. Release Please opens or updates a release PR containing the next
   `package.json` version, `CHANGELOG.md`, and `.release-please-manifest.json`.
   Review it and let the checks pass. If GitHub holds the bot-created PR's workflows
   for approval, a maintainer with write access must select **Approve workflows
   to run** on the PR.
3. Merge that release PR. Release Please creates `v<version>` and its GitHub
   Release, then explicitly starts `release.yml` at that tag. This explicit
   dispatch is necessary because tags created by `GITHUB_TOKEN` do not trigger
   tag-push workflows.
4. The tagged workflow verifies and publishes the npm package, then uploads its
   tarball and SBOM to the existing GitHub Release, preserving the changelog.
   Check the **release** workflow result: the GitHub Release is created before
   npm publication and does not by itself mean the package is available on npm.

Version bumps and tags are managed by the release PR; routine releases require
no local version or tagging commands. The configuration lives in
[`release-please-config.json`](release-please-config.json) and
[`.release-please-manifest.json`](.release-please-manifest.json).

#### First automated release

The existing `v0.1.0` tag points to the initial commit, before the release workflow
existed, so pushing it could not run the current publisher. The manifest starts
from `0.1.0`, and `bootstrap-sha` includes the changes after that initial commit
in the first automated changelog. The existing feature commits should therefore
produce a `0.2.0` release PR. Keep the old tag in place and merge the new release
PR to publish a version tagged at the correct code. After the first Release
Please release, `bootstrap-sha` is ignored.

#### Publication and recovery

The tag must match `package.json` exactly (`v` followed by its version). Stable
versions publish to npm's `latest` dist-tag; prereleases such as `0.2.0-beta.1`
publish to `next`. npm versions are immutable: use a new version for changed
package contents. Direct tag pushes are still supported; when there is no
existing GitHub Release, the publisher creates one after npm publication.

If the automatic dispatch fails, or publication fails before npm accepts the
version, fix the cause (for example, a missing `NPM_TOKEN`) and dispatch the
publisher at the new release tag. Re-running Release Please alone will not
redispatch a release it already created:

```bash
gh workflow run release.yml --repo codehausau/ask --ref v0.2.0
```

Use the actual new tag. If npm publication succeeded but artifact upload failed,
complete the GitHub Release using the published artifact rather than rerunning
npm publication for that version.

Manual dispatch on a branch runs validation, packing and the dry-run without
publishing. Manual dispatch on a version tag also attempts publication, so use
it only when that npm version has not already been published. The `NPM_TOKEN`
secret is not required for branch validation or local tests.

To inspect a local package without uploading it:

```bash
pnpm pack --pack-destination dist-release
npm publish ./dist-release/codehaus-au-ask-0.1.0.tgz \
  --dry-run --ignore-scripts --provenance=false --access public
```

Use the filename printed by `pnpm pack` for the current version. The local
dry-run validates packaging and npm metadata, not registry permissions or CI
provenance signing; the tagged GitHub Actions run performs those operations.

## Cost note

Directory context is billed input. `--show-context` estimates it (bytes ÷ 4)
before you spend anything; prefer naming files over whole trees.
