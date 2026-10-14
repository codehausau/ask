import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { applyEnvFiles, describeEnvFiles, endpointFromEnvFile, parseDotenv, PROJECT_ENV_KEYS } from "../src/env.ts";

test("parses the shapes a real .env contains", () => {
  const parsed = parseDotenv(
    [
      "# a comment",
      "",
      "OPENAI_BASE_URL=https://bratwurst.tailba41af.ts.net/ollama/v1",
      "ASK_MODEL=qwen3.8-27b-q8-unsloth",
      "OPENAI_API_KEY=ollama",
      "export EXPORTED=yes",
      "  SPACED = padded  ",
      'QUOTED="has spaces and # hash"',
      "SINGLE='literal $NOPE'",
      "EMPTY=",
      "INLINE=value # trailing comment",
      'ESCAPED="line1\\nline2"',
      "not a variable line",
      "9INVALID=nope",
    ].join("\n"),
  );

  assert.equal(parsed.get("OPENAI_BASE_URL"), "https://bratwurst.tailba41af.ts.net/ollama/v1");
  assert.equal(parsed.get("ASK_MODEL"), "qwen3.8-27b-q8-unsloth");
  assert.equal(parsed.get("OPENAI_API_KEY"), "ollama");
  assert.equal(parsed.get("EXPORTED"), "yes");
  assert.equal(parsed.get("SPACED"), "padded");
  assert.equal(parsed.get("QUOTED"), "has spaces and # hash", "quotes protect a hash");
  assert.equal(parsed.get("SINGLE"), "literal $NOPE", "single quotes are literal");
  assert.equal(parsed.get("EMPTY"), "");
  assert.equal(parsed.get("INLINE"), "value");
  assert.equal(parsed.get("ESCAPED"), "line1\nline2");
  assert.equal(parsed.has("9INVALID"), false, "invalid names are ignored");
  assert.equal(parsed.size, 10, "two malformed lines ignored");
});

test("a URL containing a hash is not truncated", () => {
  // `#` only starts a comment when unquoted and preceded by a space.
  assert.equal(parseDotenv("URL=https://host/path#frag").get("URL"), "https://host/path#frag");
});

test("the real environment wins over a .env file", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ask-env-"));
  const file = path.join(dir, ".env");
  await writeFile(file, "OPENAI_API_KEY=from-file\nASK_MODEL=from-file\n");

  const env: NodeJS.ProcessEnv = { OPENAI_API_KEY: "from-shell" };
  const reports = await applyEnvFiles([file], env);

  assert.equal(env["OPENAI_API_KEY"], "from-shell", "an exported key is not clobbered");
  assert.equal(env["ASK_MODEL"], "from-file");
  assert.deepEqual(reports[0]?.applied, ["ASK_MODEL"]);
  assert.deepEqual(reports[0]?.keys, ["OPENAI_API_KEY", "ASK_MODEL"]);
});

test("the first file to define a key wins", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ask-env-"));
  const first = path.join(dir, "first.env");
  const second = path.join(dir, "second.env");
  await writeFile(first, "ASK_MODEL=first\n");
  await writeFile(second, "ASK_MODEL=second\nASK_SYSTEM=only-in-second\n");

  const env: NodeJS.ProcessEnv = {};
  await applyEnvFiles([first, second], env);

  assert.equal(env["ASK_MODEL"], "first", "cwd .env beats the install root");
  assert.equal(env["ASK_SYSTEM"], "only-in-second");
});

test("a missing file is reported, not fatal", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ask-env-"));
  const missing = path.join(dir, "absent.env");

  const reports = await applyEnvFiles([missing], {});
  assert.deepEqual(reports, [{ file: missing, found: false, keys: [], applied: [] }]);
});

test("the diagnostic distinguishes missing, silent and defining files", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ask-env-"));
  const withKey = path.join(dir, "with.env");
  const withoutKey = path.join(dir, "without.env");
  const missing = path.join(dir, "absent.env");
  await writeFile(withKey, "OPENAI_API_KEY=k\n");
  await writeFile(withoutKey, "ASK_MODEL=m\n");

  const reports = await applyEnvFiles([missing, withoutKey, withKey], {});
  const text = describeEnvFiles(reports, "OPENAI_API_KEY");

  assert.match(text, /checked for OPENAI_API_KEY in:/);
  assert.match(text, new RegExp(`${missing.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} — not found`));
  assert.match(text, /without\.env — read, but no OPENAI_API_KEY \(has: ASK_MODEL\)/);
  assert.match(text, /with\.env — defines OPENAI_API_KEY/);
});

test("restricted files apply only approved keys and never report their values", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "ask-env-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, ".env");
  const allowed = {
    OPENAI_API_KEY: "private-file-key",
    OPENAI_BASE_URL: "https://example.invalid/v1",
    OPENAI_ORG_ID: "private-org",
    OPENAI_PROJECT_ID: "private-project",
    ASK_MODEL: "file-model",
  };
  const blocked = {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.fsmonitor",
    GIT_CONFIG_VALUE_0: "private-payload-path",
    GIT_EXTERNAL_DIFF: "private-diff-path",
    LD_PRELOAD: "private-library-path",
    PATH: "private-executable-path",
    NODE_OPTIONS: "--require=private-module",
    ASK_STATE_DIR: "private-state-path",
    ASK_SKILLS_DIR: "private-skill-path",
    ASK_SYSTEM: "private-system-prompt",
  };
  await writeFile(file, Object.entries({ ...allowed, ...blocked })
    .map(([key, value]) => `${key}=${value}`).join("\n"));

  const env: NodeJS.ProcessEnv = { ASK_MODEL: "shell-model", ASK_SYSTEM: "shell-system" };
  const reports = await applyEnvFiles([{ file, allow: PROJECT_ENV_KEYS }], env);
  assert.deepEqual(env, { ...allowed, ASK_MODEL: "shell-model", ASK_SYSTEM: "shell-system" });
  assert.equal(reports[0]?.restricted, true);
  assert.deepEqual(reports[0]?.ignored, Object.keys(blocked));
  assert.deepEqual(reports[0]?.applied, Object.keys(allowed).filter((key) => key !== "ASK_MODEL"));
  assert.doesNotMatch(JSON.stringify(reports), /private-|shell-system/);
  assert.doesNotMatch(describeEnvFiles(reports, "OPENAI_API_KEY"), /private-|shell-system/);
});

test("a restricted candidate cannot be reloaded unrestricted, in either order", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "ask-env-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, ".env");
  await writeFile(file, "ASK_MODEL=allowed\nLD_PRELOAD=blocked\n");
  const restricted = { file, allow: PROJECT_ENV_KEYS };

  for (const candidates of [[restricted, file], [file, restricted]]) {
    const env: NodeJS.ProcessEnv = {};
    const reports = await applyEnvFiles(candidates, env);
    assert.deepEqual(env, { ASK_MODEL: "allowed" });
    assert.equal(reports.length, 1);
    assert.equal(reports[0]?.restricted, true);
    assert.deepEqual(reports[0]?.ignored, ["LD_PRELOAD"]);
  }
});

test("symlink aliases share the most restrictive policy and keep first-file precedence", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "ask-env-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const first = path.join(dir, "first.env");
  const alias = path.join(dir, "alias.env");
  const second = path.join(dir, "second.env");
  await writeFile(first, "ASK_MODEL=first\nOPENAI_API_KEY=first-key\nLD_PRELOAD=blocked\n");
  await writeFile(second, "ASK_MODEL=second\nOPENAI_API_KEY=second-key\n");
  await symlink(first, alias);

  const env: NodeJS.ProcessEnv = {};
  const reports = await applyEnvFiles([
    first,
    { file: second, allow: PROJECT_ENV_KEYS },
    { file: alias, allow: PROJECT_ENV_KEYS },
    { file: first, allow: new Set(["ASK_MODEL"]) },
  ], env);
  assert.deepEqual(env, { ASK_MODEL: "first", OPENAI_API_KEY: "second-key" });
  assert.deepEqual(reports.map((report) => report.file), [first, second]);
  assert.deepEqual(reports[0]?.ignored, ["OPENAI_API_KEY", "LD_PRELOAD"]);
});

test("an empty allowlist applies no keys and unresolved symlinks are not read", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "ask-env-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, ".env");
  const broken = path.join(dir, "broken.env");
  await writeFile(file, "ASK_MODEL=blocked\n");
  await symlink(path.join(dir, "missing.env"), broken);

  const env: NodeJS.ProcessEnv = {};
  const reports = await applyEnvFiles([
    { file, allow: new Set() },
    { file: broken, allow: PROJECT_ENV_KEYS },
  ], env);
  assert.deepEqual(env, {});
  assert.deepEqual(reports[0]?.ignored, ["ASK_MODEL"]);
  assert.deepEqual(reports[1], { file: broken, found: false, keys: [], applied: [] });
});

test("endpoint provenance follows applied values regardless of API-key source", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "ask-env-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, ".env");
  await writeFile(file, "OPENAI_BASE_URL=https://project.invalid/v1\nOPENAI_API_KEY=dummy\n");
  for (const env of [{}, { OPENAI_API_KEY: "exported-key" }]) {
    const reports = await applyEnvFiles([{ file, allow: PROJECT_ENV_KEYS }], env);
    assert.equal(endpointFromEnvFile(reports), file);
  }
  const env = { OPENAI_BASE_URL: "https://chosen.invalid/v1" };
  const reports = await applyEnvFiles([{ file, allow: PROJECT_ENV_KEYS }], env);
  assert.equal(endpointFromEnvFile(reports), null, "an exported URL takes precedence");
  assert.equal(env.OPENAI_BASE_URL, "https://chosen.invalid/v1");
  assert.equal(endpointFromEnvFile([]), null, "the default endpoint needs no confirmation");
});
