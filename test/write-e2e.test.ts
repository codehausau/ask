// End-to-end write tests against a real git repository, since the safety net is
// git: a write is only allowed where `git checkout --` could undo it.

import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = path.join(REPO_ROOT, "dist", "src", "cli.js");

const ORIGINAL = "export const value = 1;\n\n// keep this comment\n";

/** Endpoint that replies with whatever `reply` computes from the sent file. */
async function stub(
  reply: (file: string) => { content: string; finishReason?: string } | Promise<{ content: string; finishReason?: string }>,
): Promise<{ url: string; count: () => number; close: () => Promise<void> }> {
  let count = 0;
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        count += 1;
        const parsed = JSON.parse(body || "{}") as { model: string; messages: { content: string }[] };
        const user = parsed.messages.at(-1)?.content ?? "";
        const file = /<file path="[^"]*">\n([\s\S]*?)\n<\/file>/.exec(user)?.[1] ?? "";
        const { content, finishReason = "stop" } = await reply(file);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            model: parsed.model,
            choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: finishReason }],
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          }),
        );
      } catch (error) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: String(error) } }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    count: () => count,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** A git repo with one committed file. */
async function repo(): Promise<{ cwd: string; state: string }> {
  const cwd = await mkdtemp(path.join(tmpdir(), "ask-write-"));
  const state = await mkdtemp(path.join(tmpdir(), "ask-write-state-"));
  await writeFile(path.join(cwd, "widget.ts"), ORIGINAL);
  await writeFile(path.join(cwd, "other.ts"), "other\n");

  await execFileAsync("git", ["-C", cwd, "init", "-q"]);
  await execFileAsync("git", ["-C", cwd, "config", "user.email", "t@example.com"]);
  await execFileAsync("git", ["-C", cwd, "config", "user.name", "Test"]);
  await execFileAsync("git", ["-C", cwd, "add", "-A"]);
  await execFileAsync("git", ["-C", cwd, "commit", "-q", "-m", "init"]);
  return { cwd, state };
}

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function runCli(
  args: string[],
  options: { cwd: string; state: string; url: string; stdin?: string },
): Promise<Run> {
  const child = spawn(process.execPath, [CLI, ...args], {
    cwd: options.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      ASK_STATE_DIR: options.state,
      OPENAI_BASE_URL: options.url,
      OPENAI_API_KEY: "test-key",
      ASK_MODEL: "stub",
      ASK_SESSION: "0",
      NO_COLOR: "1",
    },
  });
  if (options.stdin !== undefined) child.stdin.write(options.stdin);
  child.stdin.end();

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => (stdout += chunk));
  child.stderr.on("data", (chunk: string) => (stderr += chunk));

  const code = await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (exitCode) => resolve(exitCode ?? -1));
  });
  return { code, stdout, stderr };
}

test("--write replaces a clean tracked file", async () => {
  const endpoint = await stub((file) => ({ content: file.replace("value = 1", "value = 2") }));
  const { cwd, state } = await repo();
  try {
    const run = await runCli(["/write", "widget.ts", "bump it"], { cwd, state, url: endpoint.url });

    assert.equal(run.code, 0, run.stderr);
    const written = await readFile(path.join(cwd, "widget.ts"), "utf8");
    assert.equal(written, "export const value = 2;\n\n// keep this comment\n");
    assert.match(run.stderr, /wrote widget\.ts/);
    // The file is on disk, not echoed to stdout.
    assert.equal(run.stdout.includes("keep this comment"), false);
  } finally {
    await endpoint.close();
  }
});

test("/write and /diff work as verbs", async () => {
  const endpoint = await stub((file) => ({ content: file.replace("value = 1", "value = 2") }));
  const { cwd, state } = await repo();
  try {
    const preview = await runCli(["/diff", "widget.ts", "bump it"], { cwd, state, url: endpoint.url });
    assert.equal(preview.code, 0, preview.stderr);
    assert.match(preview.stdout, /^diff --git/m);
    assert.equal(await readFile(path.join(cwd, "widget.ts"), "utf8"), ORIGINAL, "untouched");

    const applied = await runCli(["/write", "widget.ts", "bump it"], { cwd, state, url: endpoint.url });
    assert.equal(applied.code, 0, applied.stderr);
    assert.match(await readFile(path.join(cwd, "widget.ts"), "utf8"), /value = 2/);
  } finally {
    await endpoint.close();
  }
});

test("--diff previews and writes nothing", async () => {
  const endpoint = await stub((file) => ({ content: file.replace("value = 1", "value = 2") }));
  const { cwd, state } = await repo();
  try {
    const run = await runCli(["/diff", "widget.ts", "bump it"], { cwd, state, url: endpoint.url });

    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout, /^diff --git/m);
    assert.match(run.stdout, /-export const value = 1;/);
    assert.match(run.stdout, /\+export const value = 2;/);
    assert.equal(await readFile(path.join(cwd, "widget.ts"), "utf8"), ORIGINAL, "untouched");
  } finally {
    await endpoint.close();
  }
});

test("a response truncated by the token cap is never written", async () => {
  const endpoint = await stub((file) => ({
    content: file.slice(0, 20),
    finishReason: "length",
  }));
  const { cwd, state } = await repo();
  try {
    const run = await runCli(["/write", "widget.ts", "bump it"], { cwd, state, url: endpoint.url });

    assert.equal(run.code, 2);
    assert.match(run.stderr, /hit the token cap and is incomplete/);
    assert.equal(await readFile(path.join(cwd, "widget.ts"), "utf8"), ORIGINAL, "intact");
  } finally {
    await endpoint.close();
  }
});

test("a dirty or untracked file is refused without --force", async () => {
  const endpoint = await stub((file) => ({ content: file.replace("value = 1", "value = 2") }));
  const { cwd, state } = await repo();
  try {
    await writeFile(path.join(cwd, "widget.ts"), `${ORIGINAL}// local edit\n`);
    const dirty = await runCli(["/write", "widget.ts", "bump"], { cwd, state, url: endpoint.url });
    assert.equal(dirty.code, 2);
    assert.match(dirty.stderr, /uncommitted changes/);
    assert.match(await readFile(path.join(cwd, "widget.ts"), "utf8"), /local edit/, "kept");

    const forced = await runCli(["--force", "/write", "widget.ts", "bump"], {
      cwd,
      state,
      url: endpoint.url,
    });
    assert.equal(forced.code, 0, forced.stderr);
    assert.match(await readFile(path.join(cwd, "widget.ts"), "utf8"), /value = 2/);

    await writeFile(path.join(cwd, "fresh.ts"), ORIGINAL);
    const untracked = await runCli(["/write", "fresh.ts", "bump"], { cwd, state, url: endpoint.url });
    assert.equal(untracked.code, 2);
    assert.match(untracked.stderr, /not tracked by git/);
  } finally {
    await endpoint.close();
  }
});

test("write and diff refuse tracked symlinks and parent aliases before requesting, even with force", async (t) => {
  const { cwd, state } = await repo();
  t.after(() => Promise.all([rm(cwd, { recursive: true, force: true }), rm(state, { recursive: true, force: true })]));
  const outside = path.join(state, "outside.ts");
  await writeFile(outside, "outside contents\n");
  await symlink(path.join(cwd, "widget.ts"), path.join(cwd, "alias.ts"));
  await symlink(outside, path.join(cwd, "external.ts"));
  await symlink(path.join(state, "absent.ts"), path.join(cwd, "dangling.ts"));
  await symlink(cwd, path.join(cwd, "dir-link"), "junction");
  await symlink(state, path.join(cwd, "external-dir"), "junction");
  await execFileAsync("git", ["-C", cwd, "add", "-A"]);
  await execFileAsync("git", ["-C", cwd, "commit", "-q", "-m", "links"]);
  const endpoint = await stub(() => ({ content: ORIGINAL }));
  t.after(() => endpoint.close());

  for (const mode of ["/write", "/diff"]) {
    for (const flags of [[], ["--force"]]) {
      for (const target of ["alias.ts", "external.ts", "dangling.ts", "dir-link/widget.ts", "external-dir/outside.ts"]) {
        const result = await runCli([...flags, mode, target, "bump it"], { cwd, state, url: endpoint.url });
        assert.equal(result.code, 2, result.stderr);
        assert.match(result.stderr, /symbolic link/);
        assert.doesNotMatch(result.stderr, /use \/create/);
      }
    }
  }
  assert.equal(endpoint.count(), 0);
  assert.equal(await readFile(outside, "utf8"), "outside contents\n");
  assert.equal(await readFile(path.join(cwd, "widget.ts"), "utf8"), ORIGINAL);
  assert.equal((await lstat(path.join(cwd, "dangling.ts"))).isSymbolicLink(), true);
});

test("in-flight target changes cannot be overwritten by force or reported as unchanged", async (t) => {
  for (const change of ["contents", "same-bytes", "symlink", "no-op", "committed"]) {
    const { cwd, state } = await repo();
    t.after(() => Promise.all([rm(cwd, { recursive: true, force: true }), rm(state, { recursive: true, force: true })]));
    const target = path.join(cwd, "widget.ts");
    const outside = path.join(state, "outside.ts");
    await writeFile(outside, "outside contents\n");
    const latest = `${ORIGINAL}// newer local work\n`;
    const endpoint = await stub(async (sent) => {
      assert.equal(sent, ORIGINAL);
      if (change === "symlink") {
        await rm(target);
        await symlink(outside, target);
      } else if (change === "same-bytes") {
        await rename(target, path.join(cwd, "original.ts"));
        await writeFile(target, ORIGINAL);
      } else {
        await writeFile(target, latest);
        if (change === "committed") {
          await execFileAsync("git", ["-C", cwd, "add", "--", "widget.ts"]);
          await execFileAsync("git", ["-C", cwd, "commit", "-q", "-m", "newer work"]);
        }
      }
      return { content: change === "no-op" ? sent : sent.replace("value = 1", "value = 2") };
    });
    t.after(() => endpoint.close());
    const flags = change === "committed" ? [] : ["--force"];
    const result = await runCli([...flags, "/write", "widget.ts", "bump it"], { cwd, state, url: endpoint.url });
    assert.equal(result.code, 2, `${change}: ${result.stderr}`);
    assert.match(result.stderr, /target changed|no longer match/);
    assert.doesNotMatch(result.stderr, /widget\.ts unchanged/);
    assert.equal(endpoint.count(), 1);
    assert.equal(await readFile(outside, "utf8"), "outside contents\n");
    if (change === "symlink") assert.equal((await lstat(target)).isSymbolicLink(), true);
    else assert.equal(await readFile(target, "utf8"), change === "same-bytes" ? ORIGINAL : latest);
    if (change === "committed") {
      const status = await execFileAsync("git", ["-C", cwd, "status", "--porcelain", "--", "widget.ts"]);
      assert.equal(status.stdout, "", "even a newly clean Git state must not bypass the snapshot check");
    }
  }
});

test("an in-flight parent-directory link swap cannot redirect write or diff", async (t) => {
  for (const mode of ["/write", "/diff"]) {
    const { cwd, state } = await repo();
    t.after(() => Promise.all([rm(cwd, { recursive: true, force: true }), rm(state, { recursive: true, force: true })]));
    await mkdir(path.join(cwd, "src"));
    await rename(path.join(cwd, "widget.ts"), path.join(cwd, "src", "widget.ts"));
    await writeFile(path.join(state, "widget.ts"), "outside contents\n");
    await execFileAsync("git", ["-C", cwd, "add", "-A"]);
    await execFileAsync("git", ["-C", cwd, "commit", "-q", "-m", "move source"]);
    const endpoint = await stub(async (sent) => {
      await rename(path.join(cwd, "src"), path.join(cwd, "original-src"));
      await symlink(state, path.join(cwd, "src"), "junction");
      return { content: sent.replace("value = 1", "value = 2") };
    });
    t.after(() => endpoint.close());
    const result = await runCli(["--force", mode, "src/widget.ts", "bump it"], { cwd, state, url: endpoint.url });
    assert.equal(result.code, 2, result.stderr);
    assert.match(result.stderr, /parent directory changed/);
    assert.equal(result.stdout, "");
    assert.equal(await readFile(path.join(state, "widget.ts"), "utf8"), "outside contents\n");
    assert.equal(await readFile(path.join(cwd, "original-src", "widget.ts"), "utf8"), ORIGINAL);
  }
});

test("extra attached files are references, and a missing target is refused", async () => {
  // Fixed reply: with two files attached, a stub that echoes "the file" cannot
  // know which one is the target — that is the CLI's job, and what is tested.
  const endpoint = await stub(() => ({
    content: "export const value = 2;\n\n// keep this comment\n",
  }));
  const { cwd, state } = await repo();
  try {
    // Two files in context is now fine: the target is named, the other is a
    // reference the model can read.
    const run = await runCli(["/write", "widget.ts", "@other.ts bump, matching other.ts"], {
      cwd,
      state,
      url: endpoint.url,
    });
    assert.equal(run.code, 0, run.stderr);
    assert.match(await readFile(path.join(cwd, "widget.ts"), "utf8"), /value = 2/);
    assert.equal(await readFile(path.join(cwd, "other.ts"), "utf8"), "other\n", "reference untouched");

    // A target that does not exist points at /create instead.
    const missing = await runCli(["/write", "nope.ts", "bump"], { cwd, state, url: endpoint.url });
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /does not exist; use \/create/);

    // A target the skip rules exclude cannot be written.
    await writeFile(path.join(cwd, ".env"), "SECRET=1\n");
    const secret = await runCli(["/write", ".env", "bump"], { cwd, state, url: endpoint.url });
    assert.equal(secret.code, 2);
    assert.match(secret.stderr, /was not attached/);

    assert.equal(endpoint.count(), 1, "only the successful write spent tokens");
  } finally {
    await endpoint.close();
  }
});

test("a code fence around the whole answer is stripped", async () => {
  const endpoint = await stub((file) => ({
    content: `\`\`\`ts\n${file.replace("value = 1", "value = 2")}\n\`\`\``,
  }));
  const { cwd, state } = await repo();
  try {
    const run = await runCli(["/write", "widget.ts", "bump"], { cwd, state, url: endpoint.url });

    assert.equal(run.code, 0, run.stderr);
    const written = await readFile(path.join(cwd, "widget.ts"), "utf8");
    assert.equal(written.includes("```"), false, "no fence in the file");
    assert.equal(written, "export const value = 2;\n\n// keep this comment\n");
    assert.match(run.stderr, /stripped a markdown code fence/);
  } finally {
    await endpoint.close();
  }
});

test("an unchanged answer neither writes nor claims to", async () => {
  const endpoint = await stub((file) => ({ content: file }));
  const { cwd, state } = await repo();
  try {
    const before = await readFile(path.join(cwd, "widget.ts"), "utf8");
    const run = await runCli(["/write", "widget.ts", "bump"], { cwd, state, url: endpoint.url });

    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stderr, /widget\.ts unchanged/);
    assert.equal(await readFile(path.join(cwd, "widget.ts"), "utf8"), before);
  } finally {
    await endpoint.close();
  }
});

test("the thread records what was written, never the file contents", async () => {
  const endpoint = await stub((file) => ({ content: file.replace("value = 1", "value = 2") }));
  const { cwd, state } = await repo();
  try {
    // ASK_SESSION is 0 in runCli, so opt in explicitly for this one.
    const child = await runCli(["--session", "w", "/write", "widget.ts", "bump"], {
      cwd,
      state,
      url: endpoint.url,
    });
    assert.equal(child.code, 0, child.stderr);

    const shown = await runCli(["/session", "--session", "w"], { cwd, state, url: endpoint.url });
    assert.match(shown.stdout, /wrote widget\.ts/);
    assert.equal(
      shown.stdout.includes("keep this comment"),
      false,
      "history must not accumulate file contents",
    );
  } finally {
    await endpoint.close();
  }
});

test("/create writes a new file and leaves it untracked", async () => {
  const endpoint = await stub(() => ({ content: "export const created = true;\n" }));
  const { cwd, state } = await repo();
  try {
    const run = await runCli(["/create", "fresh.ts", "@widget.ts make something like this"], {
      cwd,
      state,
      url: endpoint.url,
    });

    assert.equal(run.code, 0, run.stderr);
    assert.equal(await readFile(path.join(cwd, "fresh.ts"), "utf8"), "export const created = true;\n");
    assert.match(run.stderr, /created fresh\.ts: 1 lines/);
    assert.match(run.stderr, /git --literal-pathspecs add -- 'fresh\.ts'/);
    // The content went to the file, not stdout.
    assert.equal(run.stdout.includes("created = true"), false);
  } finally {
    await endpoint.close();
  }
});

test("the pandoc hint preserves hostile filenames as local file operands", async (t) => {
  const endpoint = await stub(() => ({ content: "unused" }));
  t.after(() => endpoint.close());
  const { cwd, state } = await repo();
  t.after(() => Promise.all([
    rm(cwd, { recursive: true, force: true }),
    rm(state, { recursive: true, force: true }),
  ]));
  const names = [
    "name with spaces.docx",
    "quote'; printf INJECTED; #.docx",
    "$(printf INJECTED).docx",
    "`printf INJECTED`.docx",
    "pipe|printf INJECTED.docx",
    "*.docx",
    "control\u001b[2J\u009b31m\nfile.docx",
    "--output=report.txt",
    "-",
  ];
  const script = [
    'pandoc() { printf "%s\\0" "$@"; }',
    'ask() { local arg; while IFS= read -r -d "" arg; do printf "%s\\0" "$arg"; done; printf "%s\\0" ASK "$@"; }',
    // Evaluate only these fixed, harmless test filenames; fake commands expose
    // the actual Bash-parsed arguments without needing pandoc or an API call.
    'eval "$1"',
  ].join("\n");
  for (const name of names) {
    await writeFile(path.join(cwd, name), Buffer.from([0, 1, 2]));
    const result = await runCli(["--dry-run", `--file=${name}`, "explain this"], {
      cwd, state, url: endpoint.url,
    });
    assert.equal(result.code, 0, result.stderr);
    const command = /^--   (pandoc .+)$/m.exec(result.stderr)?.[1];
    assert.ok(command, result.stderr);
    const executed = await execFileAsync("bash", ["-c", script, "_", command], { cwd });
    assert.equal(executed.stderr, "", name);
    assert.deepEqual(executed.stdout.split("\0"), [
      "-t", "plain", "--", `./${name}`, "ASK", "what is this document?", "",
    ], name);
  }
  assert.equal(endpoint.count(), 0, "dry-run hints require no network request");
});

test("the git-add hint stages only the named file despite shell and pathspec syntax", async (t) => {
  const endpoint = await stub(() => ({ content: "export const created = true;\n" }));
  t.after(() => endpoint.close());
  const { cwd, state } = await repo();
  t.after(() => Promise.all([
    rm(cwd, { recursive: true, force: true }),
    rm(state, { recursive: true, force: true }),
  ]));
  await writeFile(path.join(cwd, "decoy.ts"), "must not be staged\n");
  const names = [
    "name with spaces.ts",
    "quote'; printf INJECTED; #.ts",
    "$(printf INJECTED).ts",
    "`printf INJECTED`.ts",
    "*.ts",
    ":(glob)*.ts",
    "control\u001b[2J\u202e\nfile.ts",
    "-A",
    "-",
  ];
  const expected: string[] = [];
  for (const name of names) {
    const result = await runCli([`--create=${name}`, "create a file"], { cwd, state, url: endpoint.url });
    assert.equal(result.code, 0, result.stderr);
    const command = /^-- untracked; review it, then: (.+)$/m.exec(result.stderr)?.[1];
    assert.ok(command, result.stderr);
    // Run the actual suggested Git command, but only in this disposable repo.
    const executed = await execFileAsync("bash", ["-c", command], { cwd });
    assert.equal(executed.stdout, "", name);
    assert.equal(executed.stderr, "", name);
    expected.push(name);
    const staged = await execFileAsync("git", ["-C", cwd, "diff", "--cached", "--name-only", "-z"]);
    assert.deepEqual(staged.stdout.split("\0").filter(Boolean).sort(), [...expected].sort(), name);
  }
});

test("/create refuses to clobber, and accepts several context files", async () => {
  const endpoint = await stub(() => ({ content: "new\n" }));
  const { cwd, state } = await repo();
  try {
    const clobber = await runCli(["/create", "widget.ts", "rewrite it"], {
      cwd,
      state,
      url: endpoint.url,
    });
    assert.equal(clobber.code, 2);
    assert.match(clobber.stderr, /already exists; use \/write/);
    assert.equal(await readFile(path.join(cwd, "widget.ts"), "utf8"), ORIGINAL, "untouched");

    const missingDir = await runCli(["/create", "nope/deep.ts", "something"], {
      cwd,
      state,
      url: endpoint.url,
    });
    assert.equal(missingDir.code, 2);
    assert.match(missingDir.stderr, /does not exist/);

    // Neither wasted a request.
    assert.equal(endpoint.count(), 0);

    // Unlike /write, several context files are fine.
    const many = await runCli(["/create", "both.ts", "@widget.ts @other.ts combine these"], {
      cwd,
      state,
      url: endpoint.url,
    });
    assert.equal(many.code, 0, many.stderr);
    assert.equal(endpoint.count(), 1);
  } finally {
    await endpoint.close();
  }
});

test("/create refuses a response truncated by the token cap", async () => {
  const endpoint = await stub(() => ({ content: "half a fi", finishReason: "length" }));
  const { cwd, state } = await repo();
  try {
    const run = await runCli(["/create", "fresh.ts", "write it"], { cwd, state, url: endpoint.url });

    assert.equal(run.code, 2);
    assert.match(run.stderr, /hit the token cap/);
    await assert.rejects(() => readFile(path.join(cwd, "fresh.ts"), "utf8"), /ENOENT/);
  } finally {
    await endpoint.close();
  }
});

test("an edit instruction answered with code suggests /write, and writes nothing", async () => {
  // One fenced block: there is something concrete to apply.
  const endpoint = await stub(() => ({
    content: "```ts\nexport const value = 2;\n```\n",
  }));
  const { cwd, state } = await repo();
  try {
    const run = await runCli(["@widget.ts add another constant"], {
      cwd,
      state,
      url: endpoint.url,
    });

    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stderr, /-- next: ask \/write 'widget\.ts' 'add another constant'/);
    assert.match(run.stderr, /nothing was written; \/diff previews it first/);
    // The suggestion is a suggestion: the file is untouched.
    assert.equal(await readFile(path.join(cwd, "widget.ts"), "utf8"), ORIGINAL);
    // And the answer still goes to stdout as normal.
    assert.match(run.stdout, /export const value = 2;/);
  } finally {
    await endpoint.close();
  }
});

test("prose with no code to apply suggests nothing", async () => {
  // The refinement over the old nudge: an explanation is not an edit.
  const endpoint = await stub(() => ({ content: "You should change the catch clause." }));
  const { cwd, state } = await repo();
  try {
    const run = await runCli(["@widget.ts add another constant"], {
      cwd,
      state,
      url: endpoint.url,
    });
    assert.equal(run.code, 0, run.stderr);
    assert.equal(run.stderr.includes("/write"), false, "nothing concrete to write");
  } finally {
    await endpoint.close();
  }
});

test("a question about a file gets no write suggestion", async () => {
  const endpoint = await stub(() => ({ content: "It exports one constant." }));
  const { cwd, state } = await repo();
  try {
    const run = await runCli(["@widget.ts what does this do?"], {
      cwd,
      state,
      url: endpoint.url,
    });
    assert.equal(run.code, 0, run.stderr);
    assert.equal(run.stderr.includes("nothing was written"), false);
  } finally {
    await endpoint.close();
  }
});

test("a path may be written with the @ sigil, as everywhere else", async () => {
  const endpoint = await stub((file) => ({ content: file.replace("value = 1", "value = 2") }));
  const { cwd, state } = await repo();
  try {
    // `@` is how files are named in every other position, so /write @path must
    // not be a syntax error.
    const run = await runCli(["/write", "@widget.ts", "bump it"], {
      cwd,
      state,
      url: endpoint.url,
    });
    assert.equal(run.code, 0, run.stderr);
    assert.match(await readFile(path.join(cwd, "widget.ts"), "utf8"), /value = 2/);
  } finally {
    await endpoint.close();
  }
});

test("a missing verb value names what it wanted", async () => {
  const endpoint = await stub(() => ({ content: "unused" }));
  const { cwd, state } = await repo();
  try {
    // Each verb explains its own value rather than borrowing another's wording.
    // runCli here reports the exit code rather than throwing.
    const write = await runCli(["/write"], { cwd, state, url: endpoint.url });
    assert.equal(write.code, 2);
    assert.match(write.stderr, /\/write needs a path, e\.g\. ask \/write src\/chat\.ts/);

    const diff = await runCli(["/diff"], { cwd, state, url: endpoint.url });
    assert.equal(diff.code, 2);
    assert.match(diff.stderr, /\/diff needs a path/);

    const create = await runCli(["/create"], { cwd, state, url: endpoint.url });
    assert.equal(create.code, 2);
    assert.match(create.stderr, /\/create needs a path/);

    assert.equal(endpoint.count(), 0, "no tokens spent on a usage error");
  } finally {
    await endpoint.close();
  }
});
