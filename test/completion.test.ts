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
  assert.deepEqual(await complete(cwd, 1, "ask", "--sh"), ["--show-context", "--show-session"]);
  assert.deepEqual(await complete(cwd, 1, "ask", "--show-c"), ["--show-context"]);
  assert.deepEqual(await complete(cwd, 1, "ask", "--max-t"), ["--max-tokens", "--max-total-bytes"]);
  assert.deepEqual(await complete(cwd, 1, "ask", "--dr"), ["--dry-run"]);
});

test("/verbs complete as the first word only", async () => {
  const cwd = await fixture();
  assert.deepEqual(await complete(cwd, 1, "ask", "/"), [
    "/compact",
    "/new",
    "/reset",
    "/session",
    "/sessions",
    "/switch",
  ]);
  assert.deepEqual(await complete(cwd, 1, "ask", "/c"), ["/compact"]);
  assert.deepEqual(await complete(cwd, 1, "ask", "/se"), ["/session", "/sessions"]);
  assert.deepEqual(await complete(cwd, 1, "ask", "/sw"), ["/switch"]);
  assert.deepEqual(await complete(cwd, 1, "ask", "/n"), ["/new"]);
  // Later on the line, a slash is more likely an absolute path than a verb.
  assert.deepEqual(await complete(cwd, 2, "ask", "@a.ts", "/nonexistent-xyz"), []);
});

test("an empty first word lists the verbs, so they are discoverable", async () => {
  const cwd = await fixture();
  assert.deepEqual(await complete(cwd, 1, "ask", ""), [
    "/compact",
    "/new",
    "/reset",
    "/session",
    "/sessions",
    "/switch",
  ]);
  // Mid-question, TAB stays silent rather than suggesting verbs.
  assert.deepEqual(await complete(cwd, 2, "ask", "@a.ts", ""), []);
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

test("the fzf picker is opt-out, and needs both fzf and a terminal", async () => {
  const cwd = await fixture();
  const probe = `source ${COMPLETION}; _ask_use_fzf; echo "rc=$?"`;

  // No terminal attached (stderr is a pipe here), so never interactive: this is
  // what keeps the rest of this suite on the plain-completion path.
  const piped = await run("bash", ["-c", probe], { cwd });
  assert.equal(piped.stdout.trim(), "rc=1");

  // Explicit opt-out is honoured regardless.
  const optOut = await run("bash", ["-c", probe], {
    cwd,
    env: { ...process.env, ASK_FZF: "0" },
  });
  assert.equal(optOut.stdout.trim(), "rc=1");
});

test("the picker and the plain fallback draw from the same candidate list", async () => {
  const cwd = await fixture();
  const { stdout } = await run(
    "bash",
    ["-c", `source ${COMPLETION}; _ask_search_paths buried`],
    { cwd },
  );
  assert.deepEqual(
    stdout.split("\n").filter((line) => line.length > 0),
    ["src/deep/buried.ts"],
  );
});

/**
 * Drive the `@` readline widget: returns the line and cursor position after
 * typing `@` at `point`. ASK_FZF=0 keeps it on the non-interactive path.
 */
async function atWidget(
  cwd: string,
  line: string,
  point: number,
): Promise<{ line: string; point: number }> {
  const script = [
    `source ${COMPLETION}`,
    `READLINE_LINE=${JSON.stringify(line)}`,
    `READLINE_POINT=${point}`,
    "_ask_at_widget",
    'printf "%s\\n%s\\n" "$READLINE_LINE" "$READLINE_POINT"',
  ].join("; ");

  const { stdout } = await run("bash", ["-c", script], {
    cwd,
    env: { ...process.env, ASK_FZF: "0" },
  });
  const [text = "", position = "0"] = stdout.split("\n");
  return { line: text, point: Number(position) };
}

test("typing @ elsewhere inserts a literal @, never a picker", async () => {
  const cwd = await fixture();

  // The case that must not break: an ssh host on some unrelated command line.
  assert.deepEqual(await atWidget(cwd, "ssh user", 8), { line: "ssh user@", point: 9 });
  // Mid-line, cursor not at the end.
  assert.deepEqual(await atWidget(cwd, "ssh host", 3), { line: "ssh@ host", point: 4 });
  // An empty line.
  assert.deepEqual(await atWidget(cwd, "", 0), { line: "@", point: 1 });
  // A command that merely starts with the letters "ask".
  assert.deepEqual(await atWidget(cwd, "askew foo", 9), { line: "askew foo@", point: 10 });
});

test("typing @ mid-word on an ask line is still a literal @", async () => {
  const cwd = await fixture();
  assert.deepEqual(await atWidget(cwd, "ask src", 7), { line: "ask src@", point: 8 });
  assert.deepEqual(await atWidget(cwd, "ask name", 8), { line: "ask name@", point: 9 });
});

test("with no picker available, @ on an ask line degrades to a literal @", async () => {
  const cwd = await fixture();
  // ASK_FZF=0 in the helper: TAB completion still works, nothing is lost.
  assert.deepEqual(await atWidget(cwd, "ask ", 4), { line: "ask @", point: 5 });
  assert.deepEqual(await atWidget(cwd, "askf ", 5), { line: "askf @", point: 6 });
  assert.deepEqual(await atWidget(cwd, "ask @a.ts ", 10), { line: "ask @a.ts @", point: 11 });
});

test("the @ binding is opt-in", async () => {
  const cwd = await fixture();
  // Non-interactive shells never bind, and ASK_AT_KEY defaults to off, so
  // sourcing the file cannot silently rebind @ for the whole shell.
  const { stdout } = await run(
    "bash",
    ["-c", `source ${COMPLETION}; bind -X 2>/dev/null | grep -c '"@"' || true`],
    { cwd },
  );
  assert.equal(stdout.trim(), "0");
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
