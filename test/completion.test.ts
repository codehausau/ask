import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { flagSpellings } from "../src/options.ts";

const run = promisify(execFile);

// Resolves the same whether this test runs from source or from dist/test.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const COMPLETION = path.join(REPO_ROOT, "completions", "ask.bash");
const HARNESS = path.join(REPO_ROOT, "test", "completion-harness.sh");

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "ask-comp-"));
  await mkdir(path.join(root, "src", "deep"), { recursive: true });
  await writeFile(path.join(root, "src", "a.ts"), "");
  await writeFile(path.join(root, "src", "b.ts"), "");
  await writeFile(path.join(root, "src", "deep", "buried.ts"), "");
  await writeFile(path.join(root, "notes.md"), "");
  return root;
}

/** Complete `words[cword]` with the cursor on it, from directory `cwd`. */
async function complete(cwd: string, cword: number, ...words: string[]): Promise<string[]> {
  const { stdout } = await run("bash", [HARNESS, COMPLETION, String(cword), ...words], { cwd });
  return stdout.split("\n").filter((line) => line.length > 0);
}

test("@ completes paths and keeps the @ prefix", async () => {
  const cwd = await fixture();
  assert.deepEqual(await complete(cwd, 1, "ask", "@sr"), ["@src/"]);
  assert.deepEqual(await complete(cwd, 1, "ask", "@n"), ["@notes.md"]);
});

test("@ completes inside a directory", async () => {
  const cwd = await fixture();
  assert.deepEqual(await complete(cwd, 1, "ask", "@src/"), [
    "@src/a.ts",
    "@src/b.ts",
    "@src/deep/",
  ]);
  assert.deepEqual(await complete(cwd, 1, "ask", "@src/a"), ["@src/a.ts"]);
});

test("a bare @ offers everything in the current directory", async () => {
  const cwd = await fixture();
  assert.deepEqual(await complete(cwd, 1, "ask", "@"), ["@notes.md", "@src/"]);
});

test("a name that is not a prefix falls back to a tree search", async () => {
  const cwd = await fixture();
  // "buried" matches nothing in the current directory, so search takes over —
  // the same fallback `ask @buried` performs.
  assert.deepEqual(await complete(cwd, 1, "ask", "@buried"), ["@src/deep/buried.ts"]);
});

test("a partial path is not searched, only prefix-completed", async () => {
  const cwd = await fixture();
  assert.deepEqual(await complete(cwd, 1, "ask", "@src/deep/"), ["@src/deep/buried.ts"]);
  assert.deepEqual(await complete(cwd, 1, "ask", "@src/nothinghere"), []);
});

test("flags complete on a leading dash", async () => {
  const cwd = await fixture();
  assert.deepEqual(await complete(cwd, 1, "ask", "--sh"), ["--show-context"]);
  assert.deepEqual(await complete(cwd, 1, "ask", "--max-t"), ["--max-tokens", "--max-total-bytes"]);
  assert.deepEqual(await complete(cwd, 1, "ask", "--dr"), ["--dry-run"]);
});

test("--token-field offers only the two valid values", async () => {
  const cwd = await fixture();
  assert.deepEqual(await complete(cwd, 2, "ask", "--token-field", ""), [
    "max_tokens",
    "max_completion_tokens",
  ]);
});

test("-f and --system-file complete plain paths, without the @", async () => {
  const cwd = await fixture();
  assert.deepEqual(await complete(cwd, 2, "ask", "-f", "sr"), ["src/"]);
  assert.deepEqual(await complete(cwd, 2, "ask", "--system-file", "n"), ["notes.md"]);
});

test("-m offers models from ASK_MODELS only when it is set", async () => {
  const cwd = await fixture();
  assert.deepEqual(await complete(cwd, 2, "ask", "-m", ""), []);

  const { stdout } = await run("bash", [HARNESS, COMPLETION, "2", "ask", "-m", "gpt"], {
    cwd,
    env: { ...process.env, ASK_MODELS: "gpt-4o-mini gpt-4o local-llama" },
  });
  assert.deepEqual(
    stdout.split("\n").filter((line) => line.length > 0),
    ["gpt-4o-mini", "gpt-4o"],
  );
});

test("free-text words and free-form flag values are left alone", async () => {
  const cwd = await fixture();
  assert.deepEqual(await complete(cwd, 2, "ask", "@src", "review"), []);
  assert.deepEqual(await complete(cwd, 2, "ask", "--base-url", "http"), []);
  assert.deepEqual(await complete(cwd, 2, "ask", "--temperature", "0"), []);
});

test("the completion script lists exactly the flags the CLI accepts", async () => {
  const script = await readFile(COMPLETION, "utf8");
  const match = /^_ASK_FLAGS="([\s\S]*?)"$/m.exec(script);
  assert.ok(match?.[1], "_ASK_FLAGS not found in completions/ask.bash");

  const declared = match[1]
    .replace(/\\\n/g, " ")
    .split(/\s+/)
    .filter((flag) => flag.length > 0)
    .sort();

  assert.deepEqual(
    declared,
    flagSpellings(),
    "completions/ask.bash is out of sync with src/options.ts",
  );
});
