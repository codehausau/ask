# ask

[![ci](https://github.com/codehausau/ask/actions/workflows/ci.yml/badge.svg)](https://github.com/codehausau/ask/actions/workflows/ci.yml)
[![security](https://github.com/codehausau/ask/actions/workflows/security.yml/badge.svg)](https://github.com/codehausau/ask/actions/workflows/security.yml)
[![codeql](https://github.com/codehausau/ask/actions/workflows/codeql.yml/badge.svg)](https://github.com/codehausau/ask/actions/workflows/codeql.yml)

User-driven LLM tools for the terminal. Attach files or whole directories as
context, ask a question, get an answer. **No model tools, no agent loop.**

| Package | What it is | Docs |
| --- | --- | --- |
| [`@codehaus-au/ask`](https://www.npmjs.com/package/@codehaus-au/ask) | One-shot CLI: one logical completion per invocation. Node 20+, two runtime dependencies | [`packages/ask`](packages/ask/README.md) · [security](SECURITY.md) |
| [`@codehaus-au/ask-tui`](https://www.npmjs.com/package/@codehaus-au/ask-tui) | Interactive OpenTUI chat: one logical completion per message, reviewed edits. Needs Bun 1.3.14+ | [`packages/ask-tui`](packages/ask-tui/README.md) · [security](SECURITY.md) |

Both interfaces allow up to two SDK transport retries after transient failures
(at most three HTTP attempts). Retries resend the same request body; they do not
add messages, reload attachments, or create model-driven follow-ups. Timeouts
apply per attempt, so total elapsed time can be longer.

```bash
npm install --global @codehaus-au/ask        # the CLI
npm install --global @codehaus-au/ask-tui    # the chat TUI (also installs the matching ask)
```

## Development

This is a pnpm workspace. `ask-tui` imports a few of the CLI's modules through
the `./internal/*` subpaths in `packages/ask/package.json`. Those subpaths are
not a public API: the two packages are versioned together and `ask-tui` pins the
exact `ask` version, so they can change in any release.

```bash
pnpm install
pnpm build           # both packages, core first
pnpm test            # Node tests for both packages
pnpm test:bun        # native OpenTUI tests (needs bun on PATH)
pnpm tui             # build and launch the TUI from this checkout
pnpm ask --help      # run the built CLI
```

Package-level commands (`pnpm smoke`, `pnpm test:dev`, `pnpm dev`) run from
`packages/ask`; see its [README](packages/ask/README.md#layout-and-development).

## CI/CD

All GitHub Actions are pinned to commit SHAs; workflow tokens default to
`permissions: {}` with the minimum granted per job. Dependabot keeps both the
npm deps and those SHA pins current.

| Workflow | Trigger | What it does |
| --- | --- | --- |
| [`ci.yml`](.github/workflows/ci.yml) | push, PR | `tsc --noEmit` for both packages; shellcheck on the completion script; tests on Node 20/22/24; native OpenTUI tests on Bun 1.3.14/1.4.4; offline CLI previews; packs both tarballs, installs the CLI globally and verifies its version/completions, installs both tarballs together and exercises the TUI in a PTY with a local mock provider, and runs npm publish dry-runs |
| [`security.yml`](.github/workflows/security.yml) | push, PR, weekly | `pnpm audit` (runtime blocking, dev advisory); dependency review on PRs; Trivy vulns + secrets + misconfig; TruffleHog over full git history; actionlint + zizmor on these workflows; CycloneDX SBOM artifact |
| [`codeql.yml`](.github/workflows/codeql.yml) | push, PR, weekly | CodeQL `security-extended` for javascript-typescript |
| [`scorecard.yml`](.github/workflows/scorecard.yml) | weekly, branch protection changes | OpenSSF Scorecard (public repos only; guarded by a visibility check) |
| [`release-please.yml`](.github/workflows/release-please.yml) | push to `main`; manual on `main` | maintains one version/changelog PR for both packages; when merged, creates `v<version>` (core) and `ask-tui-v<version>` tags and GitHub Releases and dispatches npm publication at each tag |
| [`release.yml`](.github/workflows/release.yml) | dispatch at a release tag; tags `v*.*.*` (core) / `ask-tui-v*.*.*`; manual validation | selects the package from the tag; typecheck, test, audit, tag/version match check, pack and test one tarball, npm dry-run, SBOM, GitHub attestation, npm publication with provenance (`ask-tui` first waits for the matching `ask` on npm), then attach the same tarball to the GitHub Release |

Run the same gates locally:

```bash
pnpm check           # typecheck + tests + runtime audit, both packages
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

This repository publishes **`@codehaus-au/ask`** (`packages/ask`) and
**`@codehaus-au/ask-tui`** (`packages/ask-tui`). The publishing account must have
access to the npm `codehaus-au` scope, including permission to create
`@codehaus-au/ask-tui` for its first release. If `NPM_TOKEN` is restricted to
selected packages rather than the scope, add `@codehaus-au/ask-tui` to it.

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
2. Release Please opens or updates one release PR containing the next version
   in both `packages/*/package.json`, each package's `CHANGELOG.md`, and
   `.release-please-manifest.json`. The packages are linked (`linked-versions`):
   a change to either releases both at the same version, because `ask-tui`
   depends on the exact matching `ask`.
   Review it and let the checks pass. If GitHub holds the bot-created PR's workflows
   for approval, a maintainer with write access must select **Approve workflows
   to run** on the PR.
3. Merge that release PR. Release Please creates `v<version>` (core) and
   `ask-tui-v<version>` with their GitHub Releases, then explicitly starts
   `release.yml` at each tag, core first. This explicit dispatch is necessary
   because tags created by `GITHUB_TOKEN` do not trigger tag-push workflows.
4. Each tagged run verifies and publishes its npm package, then uploads its
   tarball and SBOM to the existing GitHub Release, preserving the changelog.
   The `ask-tui` run waits up to 20 minutes for the matching `@codehaus-au/ask`
   to appear on npm before publishing. Check both **release** workflow results:
   a GitHub Release is created before npm publication and does not by itself
   mean the package is available on npm.

Version bumps and tags are managed by the release PR; routine releases require
no local version or tagging commands. The configuration lives in
[`release-please-config.json`](release-please-config.json) and
[`.release-please-manifest.json`](.release-please-manifest.json).

#### Tags for two packages

Core keeps the `v<version>` tags it used as a single package
(`include-component-in-tag: false` for `packages/ask`), so Release Please finds
`v0.2.0` as its previous release and no migration tag is needed. `ask-tui` tags
carry its component name (`ask-tui-v<version>`), which keeps the two packages'
tags distinct even though they share a version. A `v<version>` tag therefore
marks a core release, not the whole repository.

`bootstrap-sha` points at the `0.2.0` release commit. Core finds its previous
release by tag, so this mainly limits `ask-tui`'s first changelog, which has no
earlier release, to changes after `0.2.0`. It is ignored once a release PR has
merged. Both manifest entries start at `0.2.0`, so the first release publishes
`ask` and the first `ask-tui` together as `0.3.0`. `@codehaus-au/ask` 0.2.0 on
npm still declares the TUI and OpenTUI; 0.3.0 removes them.

#### Publication and recovery

The tag must match the package's `package.json` exactly (`v` for `ask`, or
`ask-tui-v`, followed by its version), and both packages must have the same version. Stable
versions publish to npm's `latest` dist-tag; prereleases such as `0.2.0-beta.1`
publish to `next`. npm versions are immutable: use a new version for changed
package contents. Direct tag pushes are still supported; when there is no
existing GitHub Release, the publisher creates one after npm publication.

If the automatic dispatch fails, or publication fails before npm accepts the
version, fix the cause (for example, a missing `NPM_TOKEN`) and dispatch the
publisher at the new release tag. Re-running Release Please alone will not
redispatch a release it already created:

```bash
gh workflow run release.yml --repo codehausau/ask --ref v0.3.0
gh workflow run release.yml --repo codehausau/ask --ref ask-tui-v0.3.0
```

Use the actual new tags; publish `ask` before `ask-tui`. If npm publication succeeded but artifact upload failed,
complete the GitHub Release using the published artifact rather than rerunning
npm publication for that version.

Manual dispatch on a branch runs validation, packing and the dry-run without
publishing, for the package chosen with the `package` input. Manual dispatch on a version tag also attempts publication, so use
it only when that npm version has not already been published. The `NPM_TOKEN`
secret is not required for branch validation or local tests.

To inspect a local package without uploading it:

```bash
pnpm --dir packages/ask pack --pack-destination "$PWD/dist-release"
pnpm --dir packages/ask-tui pack --pack-destination "$PWD/dist-release"
npm publish ./dist-release/codehaus-au-ask-0.2.0.tgz \
  --dry-run --ignore-scripts --provenance=false --access public
```

Use `pnpm pack`, not `npm pack`: only pnpm replaces `ask-tui`'s `workspace:*`
dependency with the exact version. Use the filenames printed for the current version. The local
dry-run validates packaging and npm metadata, not registry permissions or CI
provenance signing; the tagged GitHub Actions run performs those operations.

The code is MIT licensed; see [LICENSE](LICENSE).
