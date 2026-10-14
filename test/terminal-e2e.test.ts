// Exercise actual CLI output paths with independently controlled TTY flags.
// Capture the bytes rather than letting a terminal interpret hostile sequences.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { appendTurn, saveSession } from "../src/session.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = path.join(ROOT, "dist", "src", "cli.js");
const ESC = "\u001b";
const ANSWER = `## Review\n\nbefore${ESC}]52;c;dGVzdA==\u0007after${ESC}[2J\n\u009b31mC1text\u009b0m\nbidi\u202eend`;
const RAW_SAFE = "## Review\n\nbeforeafter\nC1text\nbidi\\u202eend\n";
const MODEL = `model${ESC}[2J\nFORGED`;

function assertSafeDisplay(text: string, spinner = false) {
  let plain = text.replace(/\u001b\[(?:1|2|22|31|33|36|39)m/g, "");
  if (spinner) plain = plain.replace(/\r\u001b\[K/g, "");
  assert.doesNotMatch(plain, /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/);
}

async function workspace(t: TestContext) {
  const cwd = await mkdtemp(path.join(tmpdir(), "ask-terminal-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(ASK_|OPENAI_|GIT_)/.test(key) || ["NO_COLOR", "FORCE_COLOR", "CI"].includes(key)) delete env[key];
  }
  Object.assign(env, {
    ASK_SESSION: "0", ASK_STATE_DIR: path.join(cwd, "state"), ASK_SPINNER: "0",
    ASK_MODEL: "stub", OPENAI_API_KEY: "test-key", OPENAI_BASE_URL: "http://127.0.0.1:1/v1",
    TERM: "xterm-256color", HOME: path.join(cwd, "home"), XDG_CONFIG_HOME: path.join(cwd, "config"),
  });
  return { cwd, env };
}

async function endpoint(t: TestContext, text = ANSWER, error = false) {
  let count = 0;
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      count += 1;
      res.writeHead(error ? 400 : 200, { "content-type": "application/json" });
      res.end(JSON.stringify(error ? { error: { message: text, type: "test_error" } } : {
        model: MODEL,
        choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 10 },
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { url: `http://127.0.0.1:${address.port}/v1`, count: () => count };
}

function runCli(
  args: string[], cwd: string, env: NodeJS.ProcessEnv, tty = true, stderrTTY = tty,
) {
  const bootstrap = `
    import { pathToFileURL } from 'node:url';
    Object.defineProperty(process.stdout, 'isTTY', { value: ${tty} });
    Object.defineProperty(process.stderr, 'isTTY', { value: ${stderrTTY} });
    await import(pathToFileURL(process.argv[1]).href);
  `;
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = execFile(process.execPath,
      ["--input-type=module", "-e", bootstrap, CLI, ...args], { cwd, env, timeout: 10_000 },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== "number") return reject(error);
        resolve({ code: error ? Number(error.code) : 0, stdout, stderr });
      });
    child.stdin?.end();
  });
}

test("TTY answers are safe in rendered, raw, no-colour and dumb-terminal modes", async (t) => {
  const { cwd, env } = await workspace(t);
  const server = await endpoint(t);
  env["OPENAI_BASE_URL"] = server.url;
  const modes = [
    { args: [], env: {}, rendered: true },
    { args: ["--raw"], env: {}, rendered: false },
    { args: ["--no-color"], env: {}, rendered: false },
    { args: [], env: { NO_COLOR: "1" }, rendered: false },
    { args: [], env: { TERM: "dumb" }, rendered: false },
  ];
  for (const mode of modes) {
    const result = await runCli([...mode.args, "--no-next", "hello"], cwd, { ...env, ...mode.env });
    assert.equal(result.code, 0, result.stderr);
    assertSafeDisplay(result.stdout);
    assertSafeDisplay(result.stderr);
    assert.match(result.stdout, /beforeafter/);
    assert.match(result.stderr, /model\\u001b\[2J\\nFORGED/);
    if (mode.rendered) assert.match(result.stdout, /\u001b\[1mReview/);
    else assert.equal(result.stdout, RAW_SAFE);
  }
});

test("redirected answers preserve bytes even with FORCE_COLOR and a TTY stderr", async (t) => {
  const { cwd, env } = await workspace(t);
  const server = await endpoint(t);
  env["OPENAI_BASE_URL"] = server.url;
  for (const extra of [{}, { FORCE_COLOR: "1" }]) {
    const result = await runCli(["--no-next", "hello"], cwd, { ...env, ...extra }, false, true);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, `${ANSWER}\n`);
    assertSafeDisplay(result.stderr);
  }
});

test("compaction sanitises display only and session listings escape stored fields", async (t) => {
  const { cwd, env } = await workspace(t);
  const server = await endpoint(t);
  env["OPENAI_BASE_URL"] = server.url;
  const name = `thread${ESC}[2J\nNAME`;
  const session = appendTurn(null, {
    scope: cwd, name, question: `question${ESC}[2J\nQUESTION`,
    answer: ANSWER, refs: [`file${ESC}[2J\nREF.ts`],
  });
  for (const tty of [true, false]) {
    const file = await saveSession(session, env);
    const shown = await runCli(["--session", name, "/session"], cwd, env, tty);
    assert.equal(shown.code, 0, shown.stderr);
    assertSafeDisplay(shown.stdout);
    assert.match(shown.stdout, /thread\\u001b\[2J\\nNAME/);
    assert.match(shown.stdout, /question\\u001b\[2J\\nQUESTION/);
    assert.match(shown.stdout, /file\\u001b\[2J\\nREF\.ts/);
    const listed = await runCli(["--session", name, "/sessions"], cwd, env, tty);
    assert.equal(listed.code, 0, listed.stderr);
    assertSafeDisplay(listed.stdout);
    assert.match(listed.stdout, /thread\\u001b\[2J\\nNAME/);

    const compacted = await runCli(["--session", name, "/compact"], cwd, env, tty);
    assert.equal(compacted.code, 0, compacted.stderr);
    assertSafeDisplay(compacted.stderr);
    if (tty) assert.equal(compacted.stdout, RAW_SAFE);
    else assert.equal(compacted.stdout, `${ANSWER}\n`);
    const saved = JSON.parse(await readFile(file, "utf8"));
    assert.equal(saved.turns[0].answer, ANSWER, "stored summary remains unchanged");
  }
});

test("JSON and dry-run output preserve values while escaping terminal controls", async (t) => {
  const { cwd, env } = await workspace(t);
  const server = await endpoint(t);
  env["OPENAI_BASE_URL"] = server.url;
  const result = await runCli(["--json", "--quiet", "hello"], cwd, env);
  assert.equal(result.code, 0, result.stderr);
  assertSafeDisplay(result.stdout);
  assert.equal(JSON.parse(result.stdout).text, ANSWER);
  assert.equal(JSON.parse(result.stdout).model, MODEL);
  const question = `hello${ESC}[2J\u009b31m\u202eend`;
  const dry = await runCli(["--dry-run", question], cwd, env);
  assert.equal(dry.code, 0, dry.stderr);
  assertSafeDisplay(dry.stdout);
  assert.equal(JSON.parse(dry.stdout).messages.at(-1).content, question);
  await saveSession(appendTurn(null, { scope: cwd, name: "review", question, answer: ANSWER, refs: [] }), env);
  const compact = await runCli(["--session", "review", "/compact", "--dry-run"], cwd, env);
  assert.equal(compact.code, 0, compact.stderr);
  assertSafeDisplay(compact.stdout);
  assert.ok(JSON.parse(compact.stdout).messages.at(-1).content.includes(ANSWER));
  assert.equal(server.count(), 1, "dry runs issue no requests");
});

test("context and skill listings render hostile paths and front matter as single-line fields", async (t) => {
  const { cwd, env } = await workspace(t);
  const file = `file${ESC}[2J\nFORGED.ts`;
  await writeFile(path.join(cwd, file), "export const x = 1;\n");
  const root = path.join(cwd, `skills${ESC}[2J\nROOT`);
  const skill = `terminal-skill${ESC}[2J`;
  await mkdir(path.join(root, "sample"), { recursive: true });
  await writeFile(path.join(root, "sample", "SKILL.md"),
    `---\nname: ${skill}\ndescription: desc${ESC}]52;c;payload\u0007\n---\ninstructions\n`);
  env["ASK_SKILLS_DIR"] = root;
  const context = await runCli(["--show-context", "--file", file, "--skill", skill, "review"], cwd, env);
  assert.equal(context.code, 0, context.stderr);
  assertSafeDisplay(context.stdout);
  assertSafeDisplay(context.stderr);
  assert.match(context.stdout, /file\\u001b\[2J\\nFORGED\.ts/);
  assert.match(context.stdout, /terminal-skill\\u001b\[2J/);
  const listed = await runCli(["/skills", skill], cwd, env);
  assert.equal(listed.code, 0, listed.stderr);
  assertSafeDisplay(listed.stdout);
  assert.match(listed.stdout, /desc\\u001b\]52;c;payload\\u0007/);
  assert.match(listed.stdout, /skills\\u001b\[2J\\nROOT/);
  const absent = await runCli(["/skills", `no-match${ESC}[2J\nFAKE`], cwd, env);
  assert.equal(absent.code, 0, absent.stderr);
  assertSafeDisplay(absent.stdout);
  assert.match(absent.stdout, /no-match\\u001b\[2J\\nFAKE/);
});

test("spinner, API errors and filesystem/configuration errors cannot inject controls", async (t) => {
  const { cwd, env } = await workspace(t);
  const server = await endpoint(t, `error${ESC}]52;c;payload\u0007\nFORGED\u009b2J`, true);
  env["OPENAI_BASE_URL"] = server.url;
  env["ASK_SPINNER"] = "1";
  env["ASK_MODEL"] = MODEL;
  const failed = await runCli(["hello"], cwd, env);
  assert.equal(failed.code, 1);
  assertSafeDisplay(failed.stderr, true);
  assert.match(failed.stderr, /model\\u001b\[2J\\nFORGED/);
  assert.match(failed.stderr, /\\nFORGED/);
  const missing = `missing${ESC}Xbad\nFORGED.ts`;
  const ref = await runCli(["--file", missing, "hello"], cwd, env);
  assert.equal(ref.code, 2, ref.stderr);
  assertSafeDisplay(ref.stderr);
  assert.match(ref.stderr, /\\nFORGED/);
  const config = await runCli(["/write", missing, "hello"], cwd, env);
  assert.equal(config.code, 2, config.stderr);
  assertSafeDisplay(config.stderr);
  assert.match(config.stderr, /cannot write:\n  - /, "trusted error layout survives");
  assert.match(config.stderr, /\\nFORGED/);
});

test("diff previews sanitise both original and proposed content before adding colour", async (t) => {
  const { cwd, env } = await workspace(t);
  const original = `old${ESC}]52;c;old-payload\u0007\n`;
  const proposed = `new${ESC}[2J${ESC}]52;c;new-payload\u0007\n`;
  await writeFile(path.join(cwd, "widget.ts"), original);
  const server = await endpoint(t, proposed);
  env["OPENAI_BASE_URL"] = server.url;
  for (const flags of [[], ["--no-color"]]) {
    const result = await runCli([...flags, "/diff", "widget.ts", "update it"], cwd, env);
    assert.equal(result.code, 0, result.stderr);
    assertSafeDisplay(result.stdout);
    assertSafeDisplay(result.stderr);
    assert.match(result.stdout, /-old/);
    assert.match(result.stdout, /\+new/);
    assert.doesNotMatch(result.stdout, /old-payload|new-payload/);
    if (flags.length === 0) assert.match(result.stdout, /\u001b\[31m-old/);
    else assert.doesNotMatch(result.stdout, /\u001b/);
  }
  const redirected = await runCli(["/diff", "widget.ts", "update it"], cwd, { ...env, FORCE_COLOR: "1" }, false, true);
  assert.equal(redirected.code, 0, redirected.stderr);
  assert.ok(redirected.stdout.includes(`${ESC}]52;c;old-payload`));
  assert.ok(redirected.stdout.includes(`${ESC}]52;c;new-payload`));
  assert.equal(await readFile(path.join(cwd, "widget.ts"), "utf8"), original);
});
