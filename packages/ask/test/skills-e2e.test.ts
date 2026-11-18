// End-to-end: a skill must reach the system prompt, and must never be chosen by
// the model. These run the built CLI against a stub and inspect what was sent.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
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
            { index: 0, message: { role: "assistant", content: "answered" }, finish_reason: "stop" },
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

async function workspace(): Promise<{ cwd: string; state: string; skills: string; home: string }> {
  const cwd = await mkdtemp(path.join(tmpdir(), "ask-skill-e2e-"));
  const state = await mkdtemp(path.join(tmpdir(), "ask-skill-state-"));
  // An empty HOME, so the real ~/.claude/skills cannot leak into the counts.
  const home = await mkdtemp(path.join(tmpdir(), "ask-skill-home-"));
  const skills = path.join(cwd, "skills");

  await writeFile(path.join(cwd, "widget.ts"), "export const widget = 1;\n");
  await mkdir(path.join(skills, "code-review"), { recursive: true });
  await writeFile(
    path.join(skills, "code-review", "SKILL.md"),
    "---\nname: code-review\ndescription: Review a diff for regressions\n---\n\nCHECK FOR OFF BY ONE ERRORS.\n",
  );
  await mkdir(path.join(skills, "cot-author"), { recursive: true });
  await writeFile(
    path.join(skills, "cot-author", "SKILL.md"),
    "---\nname: cot-author\ndescription: Author Cursor-on-Target XML\n---\n\nALWAYS USE RFC3339 TIMESTAMPS.\n",
  );
  // An asset that must never be sent.
  await mkdir(path.join(skills, "code-review", "assets"), { recursive: true });
  await writeFile(path.join(skills, "code-review", "assets", "big.txt"), "ASSET CONTENT");
  return { cwd, state, skills, home };
}

async function runCli(
  args: string[],
  options: {
    cwd: string;
    state: string;
    skills: string;
    home: string;
    url: string;
    env?: NodeJS.ProcessEnv;
  },
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [CLI, ...args], {
    cwd: options.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      ASK_STATE_DIR: options.state,
      ASK_SKILLS_DIR: options.skills,
      HOME: options.home,
      XDG_CONFIG_HOME: path.join(options.home, ".config"),
      OPENAI_BASE_URL: options.url,
      OPENAI_API_KEY: "test-key",
      ASK_MODEL: "stub",
      ASK_SESSION: "0",
      NO_COLOR: "1",
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
  return { code, stdout, stderr };
}

test("a named skill lands in the system prompt, assets do not", async () => {
  const endpoint = await stubEndpoint();
  const dirs = await workspace();
  try {
    const run = await runCli(["--skill", "code-review", "@widget.ts review this"], {
      ...dirs,
      url: endpoint.url,
    });
    assert.equal(run.code, 0, run.stderr);

    const system = endpoint.requests[0]!.messages[0]!.content;
    assert.equal(endpoint.requests[0]!.messages[0]!.role, "system");
    assert.match(system, /<skill name="code-review">/);
    assert.match(system, /CHECK FOR OFF BY ONE ERRORS/);
    // Front matter is metadata, not instructions.
    assert.equal(system.includes("description: Review a diff"), false);
    // Bundled assets are never loaded.
    assert.equal(JSON.stringify(endpoint.requests[0]).includes("ASSET CONTENT"), false);
    // The file still rides in the user message, not the system prompt.
    assert.match(endpoint.requests[0]!.messages[1]!.content, /<file path="widget\.ts">/);
  } finally {
    await endpoint.close();
  }
});

test("a skill can be searched for, and the match is reported", async () => {
  const endpoint = await stubEndpoint();
  const dirs = await workspace();
  try {
    // "regressions" appears only in a description.
    const run = await runCli(["--skill", "regressions", "review"], { ...dirs, url: endpoint.url });
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stderr, /-- skill code-review \[search\]/);
    assert.match(endpoint.requests[0]!.messages[0]!.content, /OFF BY ONE/);
  } finally {
    await endpoint.close();
  }
});

test("several skills compose, in the order given", async () => {
  const endpoint = await stubEndpoint();
  const dirs = await workspace();
  try {
    const run = await runCli(["--skill", "code-review", "--skill", "cot-author", "review"], {
      ...dirs,
      url: endpoint.url,
    });
    assert.equal(run.code, 0, run.stderr);

    const system = endpoint.requests[0]!.messages[0]!.content;
    assert.ok(
      system.indexOf('name="code-review"') < system.indexOf('name="cot-author"'),
      "order preserved",
    );
    assert.match(system, /RFC3339/);
  } finally {
    await endpoint.close();
  }
});

test("an unknown skill is refused before any request", async () => {
  const endpoint = await stubEndpoint();
  const dirs = await workspace();
  try {
    const run = await runCli(["--skill", "nonexistent", "review"], { ...dirs, url: endpoint.url });
    assert.equal(run.code, 2);
    assert.match(run.stderr, /no skill matches "nonexistent"/);
    assert.match(run.stderr, /ask \/skills/);
    assert.equal(endpoint.requests.length, 0, "no tokens spent");
  } finally {
    await endpoint.close();
  }
});

test("/skills lists and filters without calling the API", async () => {
  const endpoint = await stubEndpoint();
  const dirs = await workspace();
  try {
    const all = await runCli(["/skills"], { ...dirs, url: endpoint.url });
    assert.equal(all.code, 0, all.stderr);
    assert.match(all.stdout, /code-review/);
    assert.match(all.stdout, /cot-author/);
    assert.match(all.stdout, /Review a diff for regressions/);
    assert.match(all.stdout, /2 of 2 skill\(s\)/);

    const filtered = await runCli(["/skills", "Cursor-on-Target"], { ...dirs, url: endpoint.url });
    assert.match(filtered.stdout, /cot-author/);
    assert.equal(filtered.stdout.includes("code-review"), false);

    assert.equal(endpoint.requests.length, 0);
  } finally {
    await endpoint.close();
  }
});

test("a skill carries across a session without repeating --skill", async () => {
  const endpoint = await stubEndpoint();
  const dirs = await workspace();
  try {
    await runCli(["--session", "s", "--skill", "code-review", "@widget.ts review"], {
      ...dirs,
      url: endpoint.url,
    });
    // No --skill this time.
    await runCli(["--session", "s", "and what about naming?"], { ...dirs, url: endpoint.url });

    const second = endpoint.requests[1]!.messages[0]!.content;
    assert.match(second, /OFF BY ONE/, "the skill is still in effect");
  } finally {
    await endpoint.close();
  }
});
