import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import {
  COMPACT_THRESHOLD_TOKENS,
  countCodeBlocks,
  extractPathCandidates,
  mentionedButMissing,
  suggestNext,
  type NextFacts,
} from "../src/next.ts";

const BASE: NextFacts = {
  question: "why does this swallow a malformed URL?",
  answer: "Because the catch returns early.",
  attached: ["src/chat.ts"],
  mentioned: [],
  hitTokenCap: false,
  contextTruncated: false,
  sessionTokens: 0,
  wrote: false,
  editRequested: false,
  outputTokens: 120,
};

test("path candidates are found in the shapes answers actually use", () => {
  const found = extractPathCandidates(
    "See `src/refs.ts` and src/skip.ts, plus \"test/chat.test.ts\" and (docs/cot.md).",
  );
  assert.deepEqual(found, ["src/refs.ts", "src/skip.ts", "test/chat.test.ts", "docs/cot.md"]);
});

test("things that look like paths but are not are ignored", () => {
  // Asserting the whole result, rather than probing it for substrings: a URL
  // must contribute nothing at all, and neither must a bare version number.
  assert.deepEqual(
    extractPathCandidates(
      "Visit https://example.com/docs/x.html or http://a.b/c.ts — version 1.2.3 — and 4.5.",
    ),
    [],
  );
  // A real path alongside a URL still comes through.
  assert.deepEqual(
    extractPathCandidates("See src/refs.ts, not https://example.com/src/refs.ts"),
    ["src/refs.ts"],
  );
});

test("sentence punctuation is trimmed from a path", () => {
  assert.deepEqual(extractPathCandidates("It lives in src/chat.ts."), ["src/chat.ts"]);
  assert.deepEqual(extractPathCandidates("Check src/a.ts, src/b.ts;"), ["src/a.ts", "src/b.ts"]);
});

test("duplicates are reported once", () => {
  assert.deepEqual(extractPathCandidates("src/a.ts and src/a.ts again"), ["src/a.ts"]);
});

async function workspace(t: TestContext) {
  const base = await mkdtemp(path.join(tmpdir(), "ask-next-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const cwd = path.join(base, "repo");
  const sibling = path.join(base, "repo-other");
  await mkdir(path.join(cwd, "src"), { recursive: true });
  await mkdir(sibling);
  await writeFile(path.join(cwd, "src", "a.ts"), "inside\n");
  await writeFile(path.join(sibling, "outside.ts"), "outside\n");
  await writeFile(path.join(base, "parent.ts"), "parent\n");
  return { base, cwd, sibling };
}

test("follow-up paths reject parent traversal and sibling-prefix escapes", async (t) => {
  const { cwd } = await workspace(t);
  const answer = "See ../repo-other/outside.ts, ../parent.ts, src/../../repo-other/outside.ts and src/a.ts.";
  const mentioned = await mentionedButMissing(answer, [], cwd);
  assert.deepEqual(mentioned, ["src/a.ts"]);
  const suggestions = suggestNext({ ...BASE, attached: [], mentioned });
  assert.match(suggestions[0]?.command ?? "", /@src\/a\.ts/);
  assert.doesNotMatch(suggestions[0]?.command ?? "", /outside|parent/);
});

test("follow-up paths accept legitimate children whose names start with two dots", async (t) => {
  const { cwd } = await workspace(t);
  await mkdir(path.join(cwd, "..notes"));
  await writeFile(path.join(cwd, "..notes", "file.ts"), "notes\n");
  assert.deepEqual(
    await mentionedButMissing("See ..notes/file.ts and src/a.ts", [], cwd),
    ["..notes/file.ts", "src/a.ts"],
  );
});

test("follow-up paths reject symlink escapes through files, chains, and directories", async (t) => {
  const { cwd, sibling } = await workspace(t);
  await symlink(path.join(sibling, "outside.ts"), path.join(cwd, "alias.ts"));
  await symlink(path.join(cwd, "alias.ts"), path.join(cwd, "chain.ts"));
  await symlink(sibling, path.join(cwd, "linked"), "junction");
  await symlink(path.join(cwd, "src", "a.ts"), path.join(cwd, "internal.ts"));
  await symlink(path.join(cwd, "src"), path.join(cwd, "internal-dir"), "junction");
  assert.deepEqual(
    await mentionedButMissing("alias.ts chain.ts linked/outside.ts internal.ts internal-dir/a.ts", [], cwd),
    ["internal.ts", "internal-dir/a.ts"],
  );
});

test("follow-up containment works when cwd itself is reached through a symlink", async (t) => {
  const { base, cwd, sibling } = await workspace(t);
  const alias = path.join(base, "work-link");
  await symlink(cwd, alias, "junction");
  await symlink(path.join(sibling, "outside.ts"), path.join(cwd, "escape.ts"));
  assert.deepEqual(await mentionedButMissing("src/a.ts escape.ts", [], alias), ["src/a.ts"]);
});

test("follow-up discovery skips unresolved paths, directories and attachments, and stays capped", async (t) => {
  const { cwd } = await workspace(t);
  await mkdir(path.join(cwd, "folder.ts"));
  await symlink(path.join(cwd, "missing.ts"), path.join(cwd, "broken.ts"));
  for (const name of ["b", "c", "d", "e"]) {
    await writeFile(path.join(cwd, "src", `${name}.ts`), "inside\n");
  }
  assert.deepEqual(
    await mentionedButMissing(
      "missing.ts broken.ts folder.ts src/a.ts src/b.ts src/b.ts src/c.ts src/d.ts src/e.ts",
      ["src/a.ts"], cwd,
    ),
    ["src/b.ts", "src/c.ts", "src/d.ts"],
  );
  assert.deepEqual(await mentionedButMissing("src/a.ts", [], path.join(cwd, "missing-dir")), []);
});

test("code blocks are counted in pairs", () => {
  assert.equal(countCodeBlocks("no fences here"), 0);
  assert.equal(countCodeBlocks("```ts\nx\n```"), 1);
  assert.equal(countCodeBlocks("```ts\nx\n```\n\n```sh\ny\n```"), 2);
  // An unclosed fence must not count as a block.
  assert.equal(countCodeBlocks("```ts\nx"), 0);
});

test("nothing is suggested when there is nothing to suggest", () => {
  assert.deepEqual(suggestNext(BASE), []);
});

test("a file the answer named but could not see is offered, with the question intact", () => {
  const suggestions = suggestNext({ ...BASE, mentioned: ["src/refs.ts"] });
  assert.equal(suggestions.length, 1);
  assert.equal(
    suggestions[0]?.command,
    "ask '@src/chat.ts @src/refs.ts why does this swallow a malformed URL?'",
  );
  assert.match(suggestions[0]?.why ?? "", /src\/refs\.ts was mentioned but not attached/);
});

test("several mentioned files read naturally", () => {
  const suggestions = suggestNext({ ...BASE, mentioned: ["src/refs.ts", "src/skip.ts"] });
  assert.match(suggestions[0]?.command ?? "", /@src\/chat\.ts @src\/refs\.ts @src\/skip\.ts/);
  assert.match(suggestions[0]?.why ?? "", /were mentioned/);
});

test("a truncated answer is the first thing suggested", () => {
  const suggestions = suggestNext({
    ...BASE,
    hitTokenCap: true,
    outputTokens: 1500,
    mentioned: ["src/refs.ts"],
  });
  assert.match(suggestions[0]?.command ?? "", /--max-tokens 3000/, "double what it used");
  assert.match(suggestions[0]?.why ?? "", /cut off by the token cap/);
});

test("the token cap suggestion has a sensible floor", () => {
  const suggestions = suggestNext({ ...BASE, hitTokenCap: true, outputTokens: null });
  assert.match(suggestions[0]?.command ?? "", /--max-tokens 2000/);
});

test("truncated context suggests raising the file cap", () => {
  const suggestions = suggestNext({ ...BASE, contextTruncated: true });
  assert.match(suggestions[0]?.command ?? "", /--max-file-bytes 524288/);
});

test("/write is offered only for an edit answered with exactly one code block", () => {
  const answered = { ...BASE, editRequested: true, answer: "```ts\nconst a = 1;\n```" };
  assert.match(suggestNext(answered)[0]?.command ?? "", /ask \/write 'src\/chat\.ts'/);

  // A question, not an instruction.
  assert.deepEqual(suggestNext({ ...answered, editRequested: false }), []);
  // Already applied.
  assert.deepEqual(suggestNext({ ...answered, wrote: true }), []);
  // Prose with no code to apply.
  assert.deepEqual(suggestNext({ ...answered, answer: "You should change the catch." }), []);
  // Two blocks: which one would be written?
  assert.deepEqual(
    suggestNext({ ...answered, answer: "```ts\na\n```\n```ts\nb\n```" }),
    [],
  );
  // Two files attached: no unambiguous target.
  assert.deepEqual(suggestNext({ ...answered, attached: ["a.ts", "b.ts"] }), []);
});

test("a heavy thread suggests compacting", () => {
  assert.deepEqual(suggestNext({ ...BASE, sessionTokens: COMPACT_THRESHOLD_TOKENS }), []);
  const suggestions = suggestNext({ ...BASE, sessionTokens: COMPACT_THRESHOLD_TOKENS + 1 });
  assert.equal(suggestions[0]?.command, "ask /compact");
});

test("a question containing a quote stays pasteable", () => {
  const suggestions = suggestNext({
    ...BASE,
    question: "why doesn't this fail?",
    mentioned: ["src/refs.ts"],
  });
  // The shell-quoted form escapes the apostrophe rather than ending the string.
  assert.match(suggestions[0]?.command ?? "", /why doesn'\\''t this fail\?/);
});
