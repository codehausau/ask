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
| Runtime dependencies | One (`openai`, the official SDK) |

Everything the model receives can be printed before sending: `--dry-run` (exact
JSON body) or `--show-context` (attachment list + token estimate, no API call).

## Install

```bash
git clone git@github.com:codehausau/ask.git
cd ask
pnpm install
pnpm build
cp .env.example .env     # add your key, and a base URL if not using OpenAI
```

`.env` is read from the working directory first, then the install root.
**Anything already exported wins over the file**, so a shell `OPENAI_API_KEY` is
never silently replaced by a stale `.env`. If a key cannot be found, the error
lists every file that was checked and what each one defined.

Or straight from a release, no toolchain required:

```bash
VERSION=0.1.0
npm install --global \
  "https://github.com/codehausau/ask/releases/download/v$VERSION/codehaus-ask-$VERSION.tgz"
```

Upgrading later is one command (the symlink points at `dist/`, which is
gitignored, so a rebuild is what actually publishes the change):

```bash
cd ~/ask && pnpm refresh && exec bash
```

`exec bash` is only needed when the completion script changed.

Put it on your `PATH` as `ask`:

```bash
pnpm link --global                      # provides the `ask` command
# or, without linking:
echo "alias ask='node $PWD/dist/src/cli.js'" >> ~/.bashrc
```

## Smoke test

No API key needed, nothing sent:

```bash
pnpm typecheck                                       # strict tsc, no emit
pnpm test                                            # build + 22 unit tests
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
the arrow keys, keep typing to filter, ENTER to insert, ESC to cancel. Closest
thing to an editor's `@` mention.

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

Search only ever offers files that would actually be attached — the skip rules
below apply to the search index too, so `node_modules`, binaries, lockfiles and
credential-looking files are never matched. Every non-literal resolution is
printed to stderr before the request goes out, so you always know what was sent.

Inside a git work tree the candidate list comes from `git ls-files --cached
--others --exclude-standard`, so `.gitignore` is respected and build output does
not crowd out your source. This is the one subprocess `ask` runs: read-only,
local, and never consulted for file *contents*. Outside a repo (or if git is
missing) it falls back to a filesystem walk. Either way the listing is capped at
50,000 entries, and if the cap bites, the error says so rather than claiming the
file does not exist.

### Options

| Flag | Meaning |
| --- | --- |
| `-m, --model <name>` | model id (env `ASK_MODEL`, default `gpt-4o-mini`) |
| `-s, --system <text>` / `--system-file <path>` | system prompt (env `ASK_SYSTEM`) |
| `--base-url <url>` | OpenAI-compatible endpoint (env `OPENAI_BASE_URL`) |
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

### Colour

Status is dimmed, warnings are yellow and errors are red, so the model's answer
stands out as the only plain text on screen:

```
⠹ asking qwen2.5-coder:7b… 12.4s          ← dim, stderr
The answer, in default colour.            ← stdout, never styled
-- qwen2.5-coder:7b | thread ask turn 2   ← dim, stderr
```

**The answer itself is never coloured.** It goes to stdout and is routinely
piped, redirected or pasted, where escape codes cause damage; `ask ... > out.md`
is byte-for-byte the model's text. Colour applies only to what `ask` says *about*
the request, and only when the relevant stream is a terminal.

Opt out with `--no-color` or [`NO_COLOR=1`](https://no-color.org); force it on
for a pipe with `FORCE_COLOR=1`. `NO_COLOR` wins over `FORCE_COLOR`.

`api.openai.com` gets `max_completion_tokens` (newer models reject
`max_tokens`); every other base URL gets `max_tokens`. Override with
`--token-field` if your gateway disagrees.

## Editing a file

`/write <path>` replaces that file with the model's answer, and `/diff <path>`
previews the change without touching anything (`--write` and `--diff` are the
flag aliases). **The target is named, never inferred** — the file is attached
automatically, and any `@refs` you add are read-only references:

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
| the target was not attached | the skip rules exclude credentials, lockfiles and binaries; writing one would rewrite it from contents the model never saw |
| the target was truncated by the context caps | the model never saw the end of it, so its answer would delete code |
| the response hit the token cap (`finish_reason: length`) | **the most dangerous case** — writing a truncated answer silently chops the file |
| the response is empty | nothing to write |
| the response is under 25% of the original size | looks like a partial answer rather than an edit (`--force` overrides) |
| the file is not tracked and clean in git | git is the undo button, so it has to be able to act as one (`--force` overrides) |

Everything above the git check is verified *before* the request is sent, so an
impossible write costs no tokens.

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
| Where skills come from | `$ASK_SKILLS_DIR` (colon-separated), `./.ask/skills`, `./.agents/skills`, `~/.config/ask/skills`, `~/.claude/skills` — first match wins, so a repository-local skill shadows a personal one |
| Nesting | grouping directories are walked to 3 levels; symlink loops are guarded, and `assets/`, `scripts/`, `templates/`, `node_modules` and dot-directories are skipped |
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
ask /new '<prompt>'   # start a fresh thread, then ask
ask /new              # start a fresh thread and stop
ask /session          # show the current thread, no API call
ask /sessions         # list this repository's threads
ask /switch <name>    # switch thread, creating it if new
ask /write <path> '<prompt>'     # edit that file
ask /diff  <path> '<prompt>'     # preview that edit
ask /create <path> '<prompt>'   # write a new file
ask /skills [term]              # list or search skills
ask /compact          # summarise the thread into notes, files stay attached
```

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
- **caps**: 256 KB per file (truncated with a marker), 1 MB total, 200 files

Skips are reported by `--show-context` and in `--json` output, so nothing is
dropped silently. The footer prints the real token usage returned by the API.

## Layout and development

```
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
| [`ci.yml`](.github/workflows/ci.yml) | push, PR | `tsc --noEmit`; shellcheck on the completion script; tests on Node 20/22/24; `--dry-run` / `--show-context` (no key, no egress); packs the tarball, installs it globally and runs `ask --version` |
| [`security.yml`](.github/workflows/security.yml) | push, PR, weekly | `pnpm audit` (runtime blocking, dev advisory); dependency review on PRs; Trivy vulns + secrets + misconfig; TruffleHog over full git history; actionlint + zizmor on these workflows; CycloneDX SBOM artifact |
| [`codeql.yml`](.github/workflows/codeql.yml) | push, PR, weekly | CodeQL `security-extended` for javascript-typescript |
| [`scorecard.yml`](.github/workflows/scorecard.yml) | weekly, branch protection changes | OpenSSF Scorecard (public repos only; guarded by a visibility check) |
| [`release.yml`](.github/workflows/release.yml) | tag `v*.*.*` | typecheck, test, audit, tag/version match check, pack, verify the tarball installs, SBOM, signed build-provenance attestation, GitHub Release via `gh` |

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

Cut a release:

```bash
pnpm version patch && git push --follow-tags
```

## Cost note

Directory context is billed input. `--show-context` estimates it (bytes ÷ 4)
before you spend anything; prefer naming files over whole trees.
