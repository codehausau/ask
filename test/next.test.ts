import assert from "node:assert/strict";
import test from "node:test";

import {
  COMPACT_THRESHOLD_TOKENS,
  countCodeBlocks,
  extractPathCandidates,
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
