import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import type { InstructionEntry } from "../src/config.ts";
import { INSTRUCTION_LIMITS, loadInstructions, renderInstructions } from "../src/instructions.ts";

async function project(t: TestContext) {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "ask-instructions-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, "project");
  await mkdir(path.join(root, "rules"), { recursive: true });
  return { base, root };
}

const entry = (pattern: string, overrides: Partial<InstructionEntry> = {}): InstructionEntry =>
  ({ pattern, source: "test", within: null, implicit: false, ...overrides });

test("files and globs are read in order, once each, and rendered with their source", async (t) => {
  const { root } = await project(t);
  await writeFile(path.join(root, "AGENTS.md"), "Be concise.");
  await writeFile(path.join(root, "rules", "b.md"), "Rule B.");
  await writeFile(path.join(root, "rules", "a.md"), "Rule A.");
  const loaded = await loadInstructions([
    entry(path.join(root, "AGENTS.md"), { implicit: true }),
    entry(path.join(root, "rules", "*.md")),
    entry(path.join(root, "rules", "a.md")),
  ], root);
  assert.deepEqual(loaded.files.map((file) => [file.display, file.text]), [
    ["AGENTS.md", "Be concise."], [path.join("rules", "a.md"), "Rule A."], [path.join("rules", "b.md"), "Rule B."],
  ]);
  assert.deepEqual(loaded.notes, []);
  assert.equal(renderInstructions(loaded.files.slice(0, 1)), '<instructions source="AGENTS.md">\nBe concise.\n</instructions>');
});

test("a missing listed file is reported, a missing AGENTS.md is not, and nothing is guessed", async (t) => {
  const { root } = await project(t);
  await writeFile(path.join(root, "rules", "style.md"), "Similar name.");
  const loaded = await loadInstructions([
    entry(path.join(root, "AGENTS.md"), { implicit: true }),
    entry(path.join(root, "style.md")),
    entry(path.join(root, "nothing", "*.md")),
  ], root);
  assert.deepEqual(loaded.files, [], "no ranked search: rules/style.md is not substituted");
  assert.ok(loaded.notes.some((note) => /instruction file style\.md not found/.test(note)));
  assert.ok(loaded.notes.some((note) => /no instruction files match/.test(note)));
  assert.ok(!loaded.notes.some((note) => /AGENTS\.md/.test(note)));
});

test("an untrusted project's files cannot lead outside it; secrets and binaries are skipped", async (t) => {
  const { base, root } = await project(t);
  await writeFile(path.join(base, "private.md"), "PRIVATE");
  await symlink(path.join(base, "private.md"), path.join(root, "AGENTS.md"));
  await writeFile(path.join(root, ".env"), "OPENAI_API_KEY=secret");
  await writeFile(path.join(root, "rules", "blob.md"), Buffer.from([0, 1, 2]));
  const loaded = await loadInstructions([
    entry(path.join(root, "AGENTS.md"), { implicit: true, within: root }),
    entry(path.join(root, ".env"), { within: root }),
    entry(path.join(root, "rules", "blob.md"), { within: root }),
  ], root);
  assert.deepEqual(loaded.files, []);
  assert.ok(loaded.notes.some((note) => /AGENTS\.md: it leads outside the project/.test(note)));
  assert.ok(loaded.notes.some((note) => /\.env: looks like a credentials file/.test(note)));
  assert.ok(loaded.notes.some((note) => /blob\.md: not text/.test(note)));
  // The same link is fine for the user's own (trusted) files.
  const trusted = await loadInstructions([entry(path.join(root, "AGENTS.md"))], root);
  assert.equal(trusted.files[0]?.text, "PRIVATE");
});

test("large files are truncated and the total is capped", async (t) => {
  const { root } = await project(t);
  await writeFile(path.join(root, "big.md"), "x".repeat(INSTRUCTION_LIMITS.maxFileBytes + 10));
  const loaded = await loadInstructions([entry(path.join(root, "big.md"))], root);
  assert.equal(loaded.files[0]?.truncated, true);
  assert.equal(loaded.files[0]?.text.length, INSTRUCTION_LIMITS.maxFileBytes);
  assert.match(renderInstructions(loaded.files), /truncated="true"/);
  assert.ok(loaded.notes.some((note) => /big\.md truncated to 64 KB/.test(note)));
});

test("instruction aliases cannot bypass secret directories or credential configuration", async (t) => {
  const { root } = await project(t);
  await mkdir(path.join(root, ".env.production"));
  await writeFile(path.join(root, ".env.production", "private.md"), "PRIVATE_INSTRUCTIONS");
  await symlink(".env.production/private.md", path.join(root, "AGENTS.md"));
  await writeFile(path.join(root, "ask.jsonc"), '{"endpoint":{"apiKey":"PRIVATE_KEY"}}');
  await symlink("ask.jsonc", path.join(root, "rules.md"));
  for (const within of [root, null]) {
    const loaded = await loadInstructions([
      entry(path.join(root, "AGENTS.md"), { implicit: true, within }),
      entry(path.join(root, "rules.md"), { within }),
    ], root);
    assert.deepEqual(loaded.files, []);
    assert.equal(loaded.notes.length, 2);
    assert.ok(loaded.notes.every((note) => note.includes("looks like a credentials file")));
    assert.doesNotMatch(JSON.stringify(loaded), /PRIVATE_/);
  }
});
