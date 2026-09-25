import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  collectContext,
  DEFAULT_LIMITS,
  extractRefs,
  renderPrompt,
  resolveLimits,
} from "../src/context.ts";

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "ask-test-"));
  await mkdir(path.join(root, "src"));
  await mkdir(path.join(root, "node_modules", "junk"), { recursive: true });
  await writeFile(path.join(root, "src", "b.ts"), "export const b = 2;\n");
  await writeFile(path.join(root, "src", "a.ts"), "export const a = 1;\n");
  await writeFile(path.join(root, "src", "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await writeFile(path.join(root, ".env"), "SECRET=hunter2\n");
  await writeFile(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
  await writeFile(path.join(root, "node_modules", "junk", "index.js"), "module.exports = 1;\n");
  await writeFile(path.join(root, "blob.txt"), Buffer.from("head\u0000tail"));
  return root;
}

test("extractRefs splits @paths from the question", () => {
  const { refs, question } = extractRefs("@src/a.ts @src/b.ts, review these for me");
  assert.deepEqual(refs, ["src/a.ts", "src/b.ts"]);
  assert.equal(question, "review these for me");
});

test("extractRefs leaves a bare @ in the question", () => {
  const { refs, question } = extractRefs("what does @ mean here?");
  assert.deepEqual(refs, []);
  assert.equal(question, "what does @ mean here?");
});

test("single file reference is attached", async () => {
  const root = await fixture();
  const result = await collectContext(["src/a.ts"], { cwd: root });
  assert.deepEqual(
    result.blocks.map((block) => block.path),
    ["src/a.ts"],
  );
  assert.equal(result.blocks[0]?.text, "export const a = 1;\n");
});

test("directory reference walks deterministically and applies skip rules", async () => {
  const root = await fixture();
  const result = await collectContext(["."], { cwd: root });

  assert.deepEqual(
    result.blocks.map((block) => block.path),
    ["src/a.ts", "src/b.ts"],
    "sorted, no node_modules, no binary, no lockfile, no .env",
  );

  const reasons = Object.fromEntries(result.skipped.map((entry) => [entry.path, entry.reason]));
  assert.equal(reasons[".env"], "looks-like-secret");
  assert.equal(reasons["pnpm-lock.yaml"], "lockfile");
  assert.equal(reasons[path.join("src", "logo.png")], "binary-extension");
  assert.equal(reasons["blob.txt"], "binary-content");
});

test("explicit .env reference is still skipped unless opted in", async () => {
  const root = await fixture();
  const guarded = await collectContext([".env"], { cwd: root });
  assert.equal(guarded.blocks.length, 0);
  assert.equal(guarded.skipped[0]?.reason, "looks-like-secret");

  const allowed = await collectContext([".env"], { cwd: root, includeSecrets: true });
  assert.equal(allowed.blocks.length, 1);
});

test("oversized files are truncated and flagged", async () => {
  const root = await fixture();
  await writeFile(path.join(root, "big.txt"), "x".repeat(5000));
  const result = await collectContext(["big.txt"], { cwd: root, limits: { maxFileBytes: 100 } });
  assert.equal(result.blocks[0]?.text.length, 100);
  assert.equal(result.blocks[0]?.truncated, true);
  assert.equal(result.blocks[0]?.bytes, 5000);
  assert.equal(result.truncated, true);
});

test("total byte cap stops collection", async () => {
  const root = await fixture();
  const result = await collectContext(["src"], { cwd: root, limits: { maxTotalBytes: 10 } });
  assert.equal(result.blocks.length, 1);
  assert.equal(
    result.skipped.some((entry) => entry.reason === "max-total-bytes"),
    true,
  );
});

test("max files cap stops the walk", async () => {
  const root = await fixture();
  const result = await collectContext(["src"], { cwd: root, limits: { maxFiles: 1 } });
  assert.equal(result.blocks.length, 1);
  assert.equal(
    result.skipped.some((entry) => entry.reason === "max-files"),
    true,
  );
});

test("duplicate references are attached once", async () => {
  const root = await fixture();
  const result = await collectContext(["src/a.ts", "src", "./src/a.ts"], { cwd: root });
  assert.deepEqual(
    result.blocks.map((block) => block.path),
    ["src/a.ts", "src/b.ts"],
  );
});

test("unset limits fall back to defaults instead of NaN caps", async () => {
  assert.deepEqual(
    resolveLimits({ maxFileBytes: undefined, maxTotalBytes: undefined, maxFiles: undefined }),
    DEFAULT_LIMITS,
  );
  assert.deepEqual(resolveLimits({ maxFileBytes: 0 }), DEFAULT_LIMITS);
  assert.equal(resolveLimits({ maxFileBytes: 32 }).maxFileBytes, 32);

  const root = await fixture();
  const result = await collectContext(["src/a.ts"], {
    cwd: root,
    limits: { maxFileBytes: undefined, maxTotalBytes: undefined, maxFiles: undefined },
  });
  assert.equal(result.blocks[0]?.text, "export const a = 1;\n");
  assert.equal(result.totalBytes, 20);
});

test("a reference matching nothing at all is a hard error", async () => {
  const root = await fixture();
  await assert.rejects(
    () => collectContext(["nope.ts"], { cwd: root }),
    /no such path, and nothing in the tree matched @nope\.ts/,
  );
});

test("renderPrompt puts context first and the question last", async () => {
  const root = await fixture();
  const context = await collectContext(["src/a.ts"], { cwd: root });
  const prompt = renderPrompt("review this", context, "piped text");
  assert.equal(
    prompt,
    '<file path="src/a.ts">\nexport const a = 1;\n\n</file>\n\n<stdin>\npiped text\n</stdin>\n\nreview this',
  );
});
