// .env files are no longer read; only parsed to explain what is no longer used.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { legacyEnvNotice, parseDotenv } from "../src/env.ts";

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

test("settings left in a no-longer-read .env are explained without being applied", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "ask-legacy-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, ".env");
  await writeFile(file, "OPENAI_API_KEY=old-key\nASK_MODEL=old-model\nDATABASE_URL=unrelated\n");
  const env: NodeJS.ProcessEnv = { ASK_MODEL: "configured", XDG_CONFIG_HOME: path.join(dir, "xdg") };
  const notice = await legacyEnvNotice([file, path.join(dir, "missing.env")], env);
  assert.match(notice ?? "", /no longer reads \.env files/);
  assert.match(notice ?? "", /\.env \(OPENAI_API_KEY\)/, "only ask settings that are still unset");
  assert.match(notice ?? "", /\{env:OPENAI_API_KEY\}/);
  assert.ok(notice?.includes(path.join(dir, "xdg", "ask", "ask.json")), notice ?? "");
  assert.doesNotMatch(notice ?? "", /old-key|DATABASE_URL/);
  assert.equal(env["OPENAI_API_KEY"], undefined);
  assert.equal(await legacyEnvNotice([file], { ...env, OPENAI_API_KEY: "set" }), null);
});
