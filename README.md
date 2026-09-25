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
| Writes to your filesystem | None; output goes to stdout |
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

Or straight from a release, no toolchain required:

```bash
VERSION=0.1.0
npm install --global \
  "https://github.com/codehausau/ask/releases/download/v$VERSION/codehaus-ask-$VERSION.tgz"
```

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

## Tab completion

```bash
echo "source $PWD/completions/ask.bash" >> ~/.bashrc && exec bash
```

Then `@` completes paths, keeping the prefix:

```console
$ ask @src/ch<TAB>
$ ask @src/chat.ts review this for me
```

| You type | You get |
| --- | --- |
| `@<TAB>` | everything in the current directory; directories gain a `/` so you can keep descending |
| `@buried<TAB>` | when nothing matches as a prefix, a recursive tree search — the same fallback the CLI performs, git-aware when available |
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

### Fuzzy picking

Sourcing the same file also defines `askf` when [fzf](https://github.com/junegunn/fzf)
is installed — the nearest equivalent to an editor's `@` mention search. TAB
selects several files, then the question is passed through:

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
| `--all-matches` | attach every search match instead of the single best one |
| `--include-secrets` | stop skipping `.env`, `*.pem`, key-ish files |
| `--show-context` | list attachments and exit |
| `--dry-run` | print the request JSON and exit |
| `--json` | machine-readable result (text, usage, attachments) |
| `-q, --quiet` | drop the stderr footer |
| `-V, --version` | print the version |

Exit codes: `0` ok, `1` runtime/API error, `2` usage error or an `@ref` that
matched nothing / matched ambiguously.

`api.openai.com` gets `max_completion_tokens` (newer models reject
`max_tokens`); every other base URL gets `max_tokens`. Override with
`--token-field` if your gateway disagrees.

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
pnpm check         # typecheck + tests + runtime audit
```

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
