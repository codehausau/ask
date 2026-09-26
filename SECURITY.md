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
| Nothing is written to your filesystem | Output goes to stdout / stderr only |
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

## Key handling

`OPENAI_API_KEY` is read from the environment or a local `.env`, which is
gitignored. The key is only ever sent to the configured endpoint as an
`Authorization` header, is never logged, and never appears in `--dry-run` or
`--json` output.

## Supply chain

- One runtime dependency (`openai`), pinned by `pnpm-lock.yaml`.
- All GitHub Actions are pinned to commit SHAs, with Dependabot keeping them
  current.
- CI runs `pnpm audit`, Trivy (vulns, secrets, misconfig), TruffleHog over full
  git history, CodeQL, actionlint and zizmor. Releases carry a CycloneDX SBOM
  and a signed build-provenance attestation.
