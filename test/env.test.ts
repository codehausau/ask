import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { applyEnvFiles, describeEnvFiles, parseDotenv } from "../src/env.ts";

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
