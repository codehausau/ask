import assert from "node:assert/strict";
import test from "node:test";

import {
  checkCreateRequest,
  checkCreateResponse,
  CREATE_SYSTEM,
  checkWriteRequest,
  checkWriteResponse,
  stripCodeFence,
  summariseChange,
  WRITE_SYSTEM,
} from "../src/write.ts";

test("a wholly fenced response is unwrapped", () => {
  assert.deepEqual(stripCodeFence("```ts\nconst a = 1;\n```"), {
    content: "const a = 1;",
    strippedFence: true,
  });
  assert.deepEqual(stripCodeFence("```\nplain\n```"), { content: "plain", strippedFence: true });
  assert.deepEqual(stripCodeFence("\n\n```js\nx\n```\n\n"), { content: "x", strippedFence: true });
});

test("content that merely contains fences is left alone", () => {
  // A README with examples in it must survive untouched.
  const readme = "# Title\n\n```bash\nask --help\n```\n\nmore prose\n";
  assert.deepEqual(stripCodeFence(readme), { content: readme, strippedFence: false });

  // Prose before a block, or two blocks: too ambiguous to guess.
  const prose = "Here you go:\n\n```ts\nconst a = 1;\n```";
  assert.equal(stripCodeFence(prose).strippedFence, false);
  const two = "```ts\na\n```\n\n```ts\nb\n```";
  assert.equal(stripCodeFence(two).strippedFence, false);
});

test("unfenced content passes through byte-identical", () => {
  const source = "export const x = 1;\n\n// trailing comment\n";
  assert.deepEqual(stripCodeFence(source), { content: source, strippedFence: false });
});

test("a write needs exactly one attached file", () => {
  const base = { hadDirectory: false, contextTruncated: false, hadStdin: false };

  assert.deepEqual(checkWriteRequest({ ...base, attachedFiles: ["a.ts"] }), []);

  assert.match(
    checkWriteRequest({ ...base, attachedFiles: [] })[0] ?? "",
    /exactly one file in context, but none/,
  );
  assert.match(
    checkWriteRequest({ ...base, attachedFiles: ["a.ts", "b.ts"] })[0] ?? "",
    /but 2 were attached: a\.ts, b\.ts/,
  );
});

test("a write refuses a directory, a truncated file, or piped input", () => {
  const one = { attachedFiles: ["a.ts"], hadDirectory: false, contextTruncated: false, hadStdin: false };

  // A directory containing a single file would otherwise look like naming it.
  assert.match(checkWriteRequest({ ...one, hadDirectory: true })[0] ?? "", /cannot target a directory/);
  // The model never saw the whole file, so writing its answer would delete code.
  assert.match(checkWriteRequest({ ...one, contextTruncated: true })[0] ?? "", /never saw all of it/);
  assert.match(checkWriteRequest({ ...one, hadStdin: true })[0] ?? "", /does not mix with piped input/);

  // Problems accumulate rather than stopping at the first.
  assert.equal(
    checkWriteRequest({ attachedFiles: [], hadDirectory: true, contextTruncated: true, hadStdin: true })
      .length,
    4,
  );
});

test("a truncated response is never written", () => {
  const original = "a\n".repeat(100);
  const problems = checkWriteResponse({
    original,
    proposed: original,
    finishReason: "length",
  });
  assert.match(problems[0] ?? "", /hit the token cap and is incomplete/);
});

test("an empty response is never written", () => {
  assert.match(
    checkWriteResponse({ original: "x\n", proposed: "   \n", finishReason: "stop" })[0] ?? "",
    /returned nothing to write/,
  );
});

test("a suspiciously small response is refused, unless the floor is lifted", () => {
  const original = "line\n".repeat(100);
  const tiny = "line\n";

  const problems = checkWriteResponse({ original, proposed: tiny, finishReason: "stop" });
  assert.match(problems[0] ?? "", /1% of the original size/);

  // --force sets the floor to 0.
  assert.deepEqual(
    checkWriteResponse({ original, proposed: tiny, finishReason: "stop", shrinkFloor: 0 }),
    [],
  );
  // A normal edit is not flagged.
  assert.deepEqual(
    checkWriteResponse({ original, proposed: "line\n".repeat(95), finishReason: "stop" }),
    [],
  );
});

test("growth is never treated as suspicious", () => {
  assert.deepEqual(
    checkWriteResponse({ original: "a\n", proposed: "a\n".repeat(500), finishReason: "stop" }),
    [],
  );
});

test("the change summary counts bytes and lines", () => {
  const summary = summariseChange("one\ntwo\n", "one\ntwo\nthree\n");
  assert.equal(summary.beforeLines, 3, "trailing newline yields a final empty element");
  assert.equal(summary.afterLines, 4);
  assert.equal(summary.beforeBytes, 8);
  assert.equal(summary.afterBytes, 14);
  assert.deepEqual(summariseChange("", ""), {
    beforeBytes: 0,
    afterBytes: 0,
    beforeLines: 0,
    afterLines: 0,
  });
});

test("the write system prompt forbids commentary and fences", () => {
  assert.match(WRITE_SYSTEM, /complete updated contents/);
  assert.match(WRITE_SYSTEM, /no markdown code\s+fence/);
  assert.match(WRITE_SYSTEM, /byte-identical/);
  assert.match(WRITE_SYSTEM, /output the\s+file unchanged/);
});

test("creating refuses an existing path, a missing parent, or mixed flags", () => {
  const ok = { target: "new.ts", exists: false, parentExists: true, withEditFlags: false };
  assert.deepEqual(checkCreateRequest(ok), []);

  assert.match(
    checkCreateRequest({ ...ok, exists: true })[0] ?? "",
    /already exists; use \/write/,
    "clobbering is /write's job, not /create's",
  );
  assert.match(
    checkCreateRequest({ ...ok, parentExists: false })[0] ?? "",
    /directory for new\.ts does not exist/,
  );
  assert.match(
    checkCreateRequest({ ...ok, withEditFlags: true })[0] ?? "",
    /does not combine with \/write or \/diff/,
  );
  assert.match(checkCreateRequest({ ...ok, target: "  " })[0] ?? "", /needs a path/);
});

test("creating has no shrink check, since there is nothing to compare with", () => {
  // A one-line file is a perfectly good new file.
  assert.deepEqual(checkCreateResponse("export const a = 1;\n", "stop"), []);

  assert.match(
    checkCreateResponse("partial", "length")[0] ?? "",
    /hit the token cap and is incomplete/,
  );
  assert.match(checkCreateResponse("   \n", "stop")[0] ?? "", /returned nothing to write/);
});

test("the create system prompt asks it to match the supplied context", () => {
  assert.match(CREATE_SYSTEM, /one new source file/);
  assert.match(CREATE_SYSTEM, /no markdown code fence/);
  assert.match(CREATE_SYSTEM, /Match\s+the conventions of any files supplied as context/);
});
