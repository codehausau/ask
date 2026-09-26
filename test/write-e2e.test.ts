// End-to-end write tests against a real git repository, since the safety net is
// git: a write is only allowed where `git checkout --` could undo it.

import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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
  reply: (file: string) => { content: string; finishReason?: string },
): Promise<{ url: string; count: () => number; close: () => Promise<void> }> {
  let count = 0;
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      count += 1;
      const parsed = JSON.parse(body || "{}") as { model: string; messages: { content: string }[] };
      const user = parsed.messages.at(-1)?.content ?? "";
      const file = /<file path="[^"]*">\n([\s\S]*?)\n<\/file>/.exec(user)?.[1] ?? "";
      const { content, finishReason = "stop" } = reply(file);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          model: parsed.model,
          choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: finishReason }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
      );
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
    const run = await runCli(["--write", "@widget.ts bump it"], { cwd, state, url: endpoint.url });

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
    const preview = await runCli(["/diff", "@widget.ts bump it"], { cwd, state, url: endpoint.url });
    assert.equal(preview.code, 0, preview.stderr);
    assert.match(preview.stdout, /^diff --git/m);
    assert.equal(await readFile(path.join(cwd, "widget.ts"), "utf8"), ORIGINAL, "untouched");

    const applied = await runCli(["/write", "@widget.ts bump it"], { cwd, state, url: endpoint.url });
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
    const run = await runCli(["--diff", "@widget.ts bump it"], { cwd, state, url: endpoint.url });

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
    const run = await runCli(["--write", "@widget.ts bump it"], { cwd, state, url: endpoint.url });

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
    const dirty = await runCli(["--write", "@widget.ts bump"], { cwd, state, url: endpoint.url });
    assert.equal(dirty.code, 2);
    assert.match(dirty.stderr, /uncommitted changes/);
    assert.match(await readFile(path.join(cwd, "widget.ts"), "utf8"), /local edit/, "kept");

    const forced = await runCli(["--force", "--write", "@widget.ts bump"], {
      cwd,
      state,
      url: endpoint.url,
    });
    assert.equal(forced.code, 0, forced.stderr);
    assert.match(await readFile(path.join(cwd, "widget.ts"), "utf8"), /value = 2/);

    await writeFile(path.join(cwd, "fresh.ts"), ORIGINAL);
    const untracked = await runCli(["--write", "@fresh.ts bump"], { cwd, state, url: endpoint.url });
    assert.equal(untracked.code, 2);
    assert.match(untracked.stderr, /not tracked by git/);
  } finally {
    await endpoint.close();
  }
});

test("--write refuses before sending when the target is ambiguous", async () => {
  const endpoint = await stub(() => ({ content: "unused" }));
  const { cwd, state } = await repo();
  try {
    const two = await runCli(["--write", "@widget.ts @other.ts bump"], {
      cwd,
      state,
      url: endpoint.url,
    });
    assert.equal(two.code, 2);
    assert.match(two.stderr, /exactly one file in context, but 2/);

    const piped = await runCli(["--write", "@widget.ts bump"], {
      cwd,
      state,
      url: endpoint.url,
      stdin: "context from a pipe\n",
    });
    assert.equal(piped.code, 2);
    assert.match(piped.stderr, /does not mix with piped input/);

    const directory = await runCli(["--write", "@. bump"], { cwd, state, url: endpoint.url });
    assert.equal(directory.code, 2);

    // No tokens were spent on any of them.
    assert.equal(endpoint.count(), 0, "refused before the request");
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
    const run = await runCli(["--write", "@widget.ts bump"], { cwd, state, url: endpoint.url });

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
    const run = await runCli(["--write", "@widget.ts bump"], { cwd, state, url: endpoint.url });

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
    const child = await runCli(["--session", "w", "--write", "@widget.ts bump"], {
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
    assert.match(run.stderr, /git add fresh\.ts/);
    // The content went to the file, not stdout.
    assert.equal(run.stdout.includes("created = true"), false);
  } finally {
    await endpoint.close();
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
