// End-to-end: run the built CLI against a local stub endpoint and inspect what
// it actually sent. This is where the session rules are proven — that a second
// invocation carries the first answer, that piped runs stay one-shot, and that
// /new clears the thread.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = path.join(REPO_ROOT, "dist", "src", "cli.js");

interface Received {
  readonly model: string;
  readonly messages: { role: string; content: string }[];
}

/** Stub OpenAI-compatible endpoint that records every request body. */
async function stubEndpoint(): Promise<{
  url: string;
  requests: Received[];
  close: () => Promise<void>;
}> {
  const requests: Received[] = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}") as Received;
      requests.push(parsed);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          model: parsed.model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: `answer ${requests.length}` },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 2 },
        }),
      );
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");

  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function workspace(): Promise<{ cwd: string; state: string }> {
  const cwd = await mkdtemp(path.join(tmpdir(), "ask-e2e-"));
  const state = await mkdtemp(path.join(tmpdir(), "ask-e2e-state-"));
  await writeFile(path.join(cwd, "widget.ts"), "export const widget = 1;\n");
  return { cwd, state };
}

/**
 * Run the CLI and return stdout. stdin is closed immediately: like `cat`, `ask`
 * reads piped input until EOF, so an open-but-silent stdin would hang.
 * `--session` opts in explicitly, since stdout here is a pipe, not a terminal.
 */
async function runCli(
  args: string[],
  options: { cwd: string; state: string; url: string; env?: NodeJS.ProcessEnv },
): Promise<string> {
  const child = spawn(process.execPath, [CLI, ...args], {
    cwd: options.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      ASK_STATE_DIR: options.state,
      OPENAI_BASE_URL: options.url,
      OPENAI_API_KEY: "test-key",
      ASK_MODEL: "stub-model",
      ...options.env,
    },
  });
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
  if (code !== 0) throw new Error(`ask exited ${code}: ${stderr}`);
  return stdout;
}

function userMessages(request: Received): string[] {
  return request.messages.filter((message) => message.role === "user").map((m) => m.content);
}

test("a named session carries prior turns into the next request", async () => {
  const endpoint = await stubEndpoint();
  const { cwd, state } = await workspace();
  const base = { cwd, state, url: endpoint.url };

  try {
    await runCli(["--session", "t1", "@widget.ts what is this?"], base);
    await runCli(["--session", "t1", "and now explain it again"], base);

    assert.equal(endpoint.requests.length, 2);

    // Turn 1: just the system prompt and one user message.
    assert.equal(endpoint.requests[0]!.messages.length, 2);

    // Turn 2: history is present, and the prior answer came back as assistant.
    const second = endpoint.requests[1]!;
    assert.deepEqual(
      second.messages.map((message) => message.role),
      ["system", "user", "assistant", "user"],
    );
    assert.equal(second.messages[2]!.content, "answer 1");
    assert.equal(second.messages[1]!.content, "what is this?", "history is question text only");

    // The file rides along with the current turn, re-read from disk.
    const current = second.messages[3]!.content;
    assert.match(current, /<file path="widget\.ts">/);
    assert.match(current, /and now explain it again$/);
  } finally {
    await endpoint.close();
  }
});

test("files stay attached without repeating @refs, and reflect edits", async () => {
  const endpoint = await stubEndpoint();
  const { cwd, state } = await workspace();
  const base = { cwd, state, url: endpoint.url };

  try {
    await runCli(["--session", "t2", "@widget.ts first look"], base);
    await writeFile(path.join(cwd, "widget.ts"), "export const widget = 2; // edited\n");
    await runCli(["--session", "t2", "did it change?"], base);

    const second = userMessages(endpoint.requests[1]!).at(-1) ?? "";
    assert.match(second, /<file path="widget\.ts">/, "carried over with no @ref typed");
    assert.match(second, /edited/, "re-read from disk, not the stale copy");
    assert.doesNotMatch(second, /widget = 1/);
  } finally {
    await endpoint.close();
  }
});

test("piped runs are one-shot: no history read, nothing written", async () => {
  const endpoint = await stubEndpoint();
  const { cwd, state } = await workspace();
  const base = { cwd, state, url: endpoint.url };

  try {
    // Seed a thread under the default name.
    await runCli(["--session", "default", "@widget.ts first"], base);
    // stdout is a pipe here and no --session is given, so this must ignore it.
    await runCli(["@widget.ts second"], base);

    const second = endpoint.requests[1]!;
    assert.deepEqual(
      second.messages.map((message) => message.role),
      ["system", "user"],
      "no history in a non-interactive run",
    );

    // And it did not append either: a third explicit run still sees one turn.
    await runCli(["--session", "default", "third"], base);
    const third = endpoint.requests[2]!;
    assert.equal(
      third.messages.filter((message) => message.role === "assistant").length,
      1,
      "the piped run was not recorded",
    );
  } finally {
    await endpoint.close();
  }
});

test("/new clears the thread", async () => {
  const endpoint = await stubEndpoint();
  const { cwd, state } = await workspace();
  const base = { cwd, state, url: endpoint.url };

  try {
    await runCli(["--session", "t3", "@widget.ts first"], base);
    await runCli(["/new", "--session", "t3", "fresh start"], base);

    const second = endpoint.requests[1]!;
    assert.deepEqual(
      second.messages.map((message) => message.role),
      ["system", "user"],
      "no carried history after /new",
    );
    assert.doesNotMatch(second.messages[1]!.content, /<file/, "carried refs cleared too");
  } finally {
    await endpoint.close();
  }
});

test("/session reports the thread without calling the API", async () => {
  const endpoint = await stubEndpoint();
  const { cwd, state } = await workspace();
  const base = { cwd, state, url: endpoint.url };

  try {
    await runCli(["--session", "t4", "@widget.ts what is this?"], base);
    const before = endpoint.requests.length;

    const output = await runCli(["/session", "--session", "t4"], base);
    assert.equal(endpoint.requests.length, before, "no request issued");
    assert.match(output, /thread t4\s+1 turn\(s\)/);
    assert.match(output, /what is this\?/);
    assert.match(output, /\[@widget\.ts\]/);
    assert.match(output, /answer 1/);
  } finally {
    await endpoint.close();
  }
});

test("--no-session and ASK_SESSION=0 opt out entirely", async () => {
  const endpoint = await stubEndpoint();
  const { cwd, state } = await workspace();
  const base = { cwd, state, url: endpoint.url };

  try {
    await runCli(["--session", "t5", "@widget.ts first"], base);
    await runCli(["--session", "t5", "--no-session", "second"], base);
    assert.deepEqual(
      endpoint.requests[1]!.messages.map((message) => message.role),
      ["system", "user"],
    );

    await runCli(["--session", "t5", "third"], { ...base, env: { ASK_SESSION: "0" } });
    assert.deepEqual(
      endpoint.requests[2]!.messages.map((message) => message.role),
      ["system", "user"],
    );
  } finally {
    await endpoint.close();
  }
});

test("--show-context breaks down the next request and calls nothing", async () => {
  const endpoint = await stubEndpoint();
  const { cwd, state } = await workspace();
  const base = { cwd, state, url: endpoint.url };

  try {
    await runCli(["--session", "tok", "@widget.ts first"], base);
    const before = endpoint.requests.length;

    const output = await runCli(["--session", "tok", "--show-context", "follow up"], base);
    assert.equal(endpoint.requests.length, before, "no request issued");

    assert.match(output, /estimated tokens for the next request/);
    assert.match(output, /files\s+~\d+/);
    assert.match(output, /history\s+~\d+/, "session history is included in the estimate");
    assert.match(output, /question\s+~\d+/);
    assert.match(output, /total\s+~\d+/);
    // The carried file is listed even though no @ref was typed.
    assert.match(output, /attach\s+widget\.ts/);
  } finally {
    await endpoint.close();
  }
});

test("/session reports history size and cumulative spend", async () => {
  const endpoint = await stubEndpoint();
  const { cwd, state } = await workspace();
  const base = { cwd, state, url: endpoint.url };

  try {
    await runCli(["--session", "spend", "@widget.ts first"], base);
    await runCli(["--session", "spend", "second"], base);

    const output = await runCli(["/session", "--session", "spend"], base);
    // The stub reports 10 in / 2 out per turn.
    assert.match(output, /spent\s+20 in \/ 4 out/);
    assert.match(output, /history\s+~\d+ tokens, resent every turn/);
  } finally {
    await endpoint.close();
  }
});

test("/compact makes exactly one request and replaces the history with it", async () => {
  const endpoint = await stubEndpoint();
  const { cwd, state } = await workspace();
  const base = { cwd, state, url: endpoint.url };

  try {
    await runCli(["--session", "c1", "@widget.ts what is this?"], base);
    await runCli(["--session", "c1", "anything risky?"], base);
    assert.equal(endpoint.requests.length, 2);

    const output = await runCli(["/compact", "--session", "c1"], base);

    // One request for the compaction itself, no more.
    assert.equal(endpoint.requests.length, 3, "compaction is a single request");
    const compaction = endpoint.requests[2]!;
    assert.match(compaction.messages[0]!.content, /compact a developer's question/i);
    assert.match(compaction.messages[1]!.content, /what is this\?/);
    assert.match(compaction.messages[1]!.content, /files: widget\.ts/);
    assert.match(output, /answer 3/, "the summary is printed for inspection");

    // The next question carries the summary, not the original turns.
    await runCli(["--session", "c1", "carry on"], base);
    const next = endpoint.requests[3]!;
    const contents = next.messages.map((message) => message.content);
    assert.equal(
      contents.some((content) => content.includes("<conversation-summary>")),
      true,
    );
    assert.equal(
      contents.some((content) => content.includes("anything risky?")),
      false,
      "original turns are gone",
    );
    // Files stay attached across compaction.
    assert.match(contents.at(-1) ?? "", /<file path="widget\.ts">/);
  } finally {
    await endpoint.close();
  }
});

test("/compact with nothing to do issues no request", async () => {
  const endpoint = await stubEndpoint();
  const { cwd, state } = await workspace();
  const base = { cwd, state, url: endpoint.url };

  try {
    const empty = await runCli(["/compact", "--session", "c2"], base);
    assert.match(empty, /no thread to compact/);
    assert.equal(endpoint.requests.length, 0);

    // A thread that is already a single summary is left alone.
    await runCli(["--session", "c3", "@widget.ts first"], base);
    await runCli(["/compact", "--session", "c3"], base);
    const before = endpoint.requests.length;
    const again = await runCli(["/compact", "--session", "c3"], base);
    assert.match(again, /already a single summary/);
    assert.equal(endpoint.requests.length, before, "no second compaction");
  } finally {
    await endpoint.close();
  }
});

test("/compact --dry-run shows the summarisation request without sending it", async () => {
  const endpoint = await stubEndpoint();
  const { cwd, state } = await workspace();
  const base = { cwd, state, url: endpoint.url };

  try {
    await runCli(["--session", "c4", "@widget.ts first"], base);
    const before = endpoint.requests.length;

    const output = await runCli(["/compact", "--session", "c4", "--dry-run"], base);
    assert.equal(endpoint.requests.length, before, "nothing sent");

    const request = JSON.parse(output) as Received;
    assert.equal(request.messages[0]!.role, "system");
    assert.match(request.messages[0]!.content, /Invent nothing/);
    assert.equal("tools" in request, false);
  } finally {
    await endpoint.close();
  }
});

test("/switch makes a thread stick across invocations", async () => {
  const endpoint = await stubEndpoint();
  const { cwd, state } = await workspace();
  const base = { cwd, state, url: endpoint.url };

  try {
    // Without --session, a piped run is one-shot; --session forces sessions on,
    // so these runs exercise the pointer rather than the TTY rule.
    await runCli(["/switch", "review"], base);
    await runCli(["--session", "review", "@widget.ts first"], base);

    // A later run with no name at all resolves to the switched thread.
    const output = await runCli(["/session"], base);
    assert.match(output, /thread review\s+1 turn\(s\)/);

    // Switching again isolates the threads.
    await runCli(["/switch", "docs"], base);
    assert.match(await runCli(["/session"], base), /no active thread/);
    await runCli(["/switch", "review"], base);
    assert.match(await runCli(["/session"], base), /thread review\s+1 turn\(s\)/);
  } finally {
    await endpoint.close();
  }
});

test("/sessions lists the threads and marks the active one", async () => {
  const endpoint = await stubEndpoint();
  const { cwd, state } = await workspace();
  const base = { cwd, state, url: endpoint.url };

  try {
    assert.match(await runCli(["/sessions"], base), /no threads yet/);

    await runCli(["--session", "alpha", "@widget.ts first"], base);
    await runCli(["--session", "beta", "second"], base);
    await runCli(["/switch", "beta"], base);

    const listing = await runCli(["/sessions"], base);
    assert.match(listing, /alpha\s+1 turn/);
    assert.match(listing, /beta\s+1 turn/);
    // The active thread is starred; alpha is not.
    assert.match(listing, /\*\s+beta/);
    assert.doesNotMatch(listing, /\*\s+alpha/);
    // Listing calls nothing.
    const before = endpoint.requests.length;
    await runCli(["/sessions"], base);
    assert.equal(endpoint.requests.length, before);
  } finally {
    await endpoint.close();
  }
});

test("ASK_SESSION names a thread, and /switch is rejected without a name", async () => {
  const endpoint = await stubEndpoint();
  const { cwd, state } = await workspace();
  const base = { cwd, state, url: endpoint.url };

  try {
    await runCli(["--session", "envthread", "@widget.ts first"], base);
    const output = await runCli(["/session"], { ...base, env: { ASK_SESSION: "envthread" } });
    assert.match(output, /thread envthread\s+1 turn\(s\)/);

    await assert.rejects(() => runCli(["/switch"], base), /needs a name/);
    await assert.rejects(() => runCli(["/switch", "bad name"], base), /invalid thread name|needs a name/);
  } finally {
    await endpoint.close();
  }
});

test("an expired thread starts fresh", async () => {
  const endpoint = await stubEndpoint();
  const { cwd, state } = await workspace();
  const base = { cwd, state, url: endpoint.url };

  try {
    await runCli(["--session", "t6", "@widget.ts first"], base);
    // ASK_SESSION_TTL is in minutes; 0 would mean "never expire", so use a
    // tiny positive value that any stored turn is already older than.
    await runCli(["--session", "t6", "second"], {
      ...base,
      env: { ASK_SESSION_TTL: "0.0001" },
    });

    assert.deepEqual(
      endpoint.requests[1]!.messages.map((message) => message.role),
      ["system", "user"],
      "idle beyond the TTL, so no history",
    );
  } finally {
    await endpoint.close();
  }
});
