// Verify the destination guard on the wire, using fake keys and local servers.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after, before, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { appendTurn, saveSession } from "../src/session.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
let install: string;
let CLI: string;
const MODES = [
  { name: "normal", args: ["--no-session", "@widget.ts review this"] },
  { name: "compact", args: ["--session", "review", "/compact"] },
];

// Isolate install-location .env files too: no developer credentials/config may
// leak into the key-provenance scenarios or reach even our local stub servers.
before(async () => {
  install = await mkdtemp(path.join(tmpdir(), "ask-endpoint-install-"));
  const entryDir = path.join(install, "dist", "src");
  await mkdir(entryDir, { recursive: true });
  await cp(path.join(ROOT, "dist", "src"), entryDir, { recursive: true });
  await writeFile(path.join(install, "package.json"), '{"type":"module"}\n');
  await symlink(path.join(ROOT, "node_modules"), path.join(install, "node_modules"), "junction");
  CLI = path.join(entryDir, "cli.js");
});
after(async () => {
  if (install) await rm(install, { recursive: true, force: true });
});

async function endpoint(t: TestContext) {
  const requests: { authorization: string | undefined; body: string }[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      requests.push({ authorization: req.headers.authorization, body });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        model: "stub-model",
        choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { url: `http://127.0.0.1:${address.port}/v1`, requests };
}

async function workspace(t: TestContext, contents: string) {
  const cwd = await mkdtemp(path.join(tmpdir(), "ask-endpoint-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(path.join(cwd, ".env"), contents);
  await writeFile(path.join(cwd, "widget.ts"), "// private-context-marker\n");
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(ASK_|OPENAI_|GIT_)/.test(key)) delete env[key];
  }
  Object.assign(env, { ASK_SESSION: "0", ASK_STATE_DIR: path.join(cwd, "state"), NO_COLOR: "1" });
  const session = await saveSession(appendTurn(null, {
    scope: cwd,
    name: "review",
    question: "private-history-marker",
    refs: [],
    answer: "previous answer",
  }), env);
  return { cwd, env, session };
}

function runCli(args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = execFile(process.execPath, [CLI, ...args], { cwd, env, timeout: 10_000 },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== "number") return reject(error);
        resolve({ code: error ? Number(error.code) : 0, stdout, stderr });
      });
    child.stdin?.end();
  });
}

for (const mode of MODES) {
  test(`${mode.name}: a file-selected endpoint is refused for every key source`, async (t) => {
    const project = await endpoint(t);
    const scenarios = [
      { name: "exported key", fileKey: "", shellKey: "private-shell-key", args: [] },
      { name: "CLI key", fileKey: "", shellKey: undefined, args: ["--api-key", "private-cli-key"] },
      { name: "dummy file key and CLI override", fileKey: "OPENAI_API_KEY=dummy\n", shellKey: undefined, args: ["--api-key", "private-cli-key"] },
      { name: "file key", fileKey: "OPENAI_API_KEY=private-file-key\n", shellKey: undefined, args: [] },
      { name: "key-free local endpoint", fileKey: "", shellKey: undefined, args: [] },
    ];
    for (const scenario of scenarios) {
      const { cwd, env, session } = await workspace(t, `OPENAI_BASE_URL=${project.url}\n${scenario.fileKey}`);
      if (scenario.shellKey !== undefined) env["OPENAI_API_KEY"] = scenario.shellKey;
      const before = await readFile(session, "utf8");
      const result = await runCli([...mode.args, ...scenario.args], cwd, env);
      assert.equal(result.code, 2, `${scenario.name}: ${result.stderr}`);
      assert.match(result.stderr, /refusing to send credentials or context/);
      assert.match(result.stderr, /--base-url/);
      assert.match(result.stderr, /export OPENAI_BASE_URL/);
      assert.doesNotMatch(result.stderr, /private-|dummy|127\.0\.0\.1/);
      assert.equal(project.requests.length, 0, scenario.name);
      assert.equal(await readFile(session, "utf8"), before, "refusal must not compact the thread");
    }
  });

  test(`${mode.name}: an explicit endpoint overrides the file and uses the effective key`, async (t) => {
    const project = await endpoint(t);
    const chosen = await endpoint(t);
    for (const source of ["flag", "shell", "same-url-flag"]) {
      const { cwd, env } = await workspace(t, `OPENAI_BASE_URL=${project.url}\nOPENAI_API_KEY=dummy\n`);
      const url = source === "same-url-flag" ? project.url : chosen.url;
      const args = [...mode.args, "--api-key", "private-cli-key"];
      if (source === "shell") env["OPENAI_BASE_URL"] = url;
      else args.push("--base-url", url);
      const result = await runCli(args, cwd, env);
      assert.equal(result.code, 0, result.stderr);
      const received = (source === "same-url-flag" ? project : chosen).requests.at(-1);
      assert.equal(received?.authorization, "Bearer private-cli-key");
      assert.ok(received?.body.includes(mode.name === "normal" ? "private-context-marker" : "private-history-marker"));
      assert.equal(project.requests.length, source === "same-url-flag" ? 1 : 0);
    }
    assert.equal(chosen.requests.length, 2);
  });

  test(`${mode.name}: offline previews remain available for a file-selected endpoint`, async (t) => {
    const project = await endpoint(t);
    const { cwd, env, session } = await workspace(t, `OPENAI_BASE_URL=${project.url}\n`);
    const before = await readFile(session, "utf8");
    const result = await runCli([...mode.args, "--dry-run"], cwd, env);
    assert.equal(result.code, 0, result.stderr);
    assert.ok(Array.isArray(JSON.parse(result.stdout).messages));
    assert.equal(project.requests.length, 0);
    assert.equal(await readFile(session, "utf8"), before);
    if (mode.name === "normal") {
      const context = await runCli([...mode.args, "--show-context"], cwd, env);
      assert.equal(context.code, 0, context.stderr);
      assert.match(context.stdout, /widget\.ts/);
      assert.equal(project.requests.length, 0);
    }
  });

  test(`${mode.name}: non-loopback HTTP needs an explicit flag before any request`, async (t) => {
    const chosen = await endpoint(t);
    // 0.0.0.0 is not a loopback hostname under the policy, but connects to our
    // local listener on Linux. No external service receives test credentials.
    const httpURL = chosen.url.replace("127.0.0.1", "0.0.0.0");
    for (const source of ["flag", "shell"]) {
      const { cwd, env, session } = await workspace(t, "ASK_ALLOW_INSECURE_HTTP=1\n");
      env["OPENAI_API_KEY"] = "private-http-key";
      env["ASK_ALLOW_INSECURE_HTTP"] = "1"; // Neither an export nor .env opts in.
      const args = [...mode.args];
      if (source === "shell") env["OPENAI_BASE_URL"] = httpURL;
      else args.push("--base-url", httpURL);
      const beforeRequests = chosen.requests.length;
      const beforeSession = await readFile(session, "utf8");

      for (const key of ["private-http-key", ""]) {
        env["OPENAI_API_KEY"] = key;
        const refused = await runCli(args, cwd, env);
        assert.equal(refused.code, 2, refused.stderr);
        assert.match(refused.stderr, /refusing unencrypted HTTP/);
        assert.match(refused.stderr, /--allow-insecure-http/);
        assert.doesNotMatch(refused.stderr, /private-http-key/);
        assert.equal(chosen.requests.length, beforeRequests);
        assert.equal(await readFile(session, "utf8"), beforeSession);
      }
      env["OPENAI_API_KEY"] = "private-http-key";

      const preview = await runCli([...args, "--dry-run"], cwd, env);
      assert.equal(preview.code, 0, preview.stderr);
      assert.ok(Array.isArray(JSON.parse(preview.stdout).messages));
      assert.equal(chosen.requests.length, beforeRequests);
      assert.equal(await readFile(session, "utf8"), beforeSession);
      if (mode.name === "normal") {
        const context = await runCli([...args, "--show-context"], cwd, env);
        assert.equal(context.code, 0, context.stderr);
        assert.match(context.stdout, /widget\.ts/);
        assert.equal(chosen.requests.length, beforeRequests);
      }

      const allowed = await runCli([...args, "--allow-insecure-http"], cwd, env);
      assert.equal(allowed.code, 0, allowed.stderr);
      assert.equal(chosen.requests.length, beforeRequests + 1);
      const received = chosen.requests.at(-1);
      assert.equal(received?.authorization, "Bearer private-http-key");
      assert.ok(received?.body.includes(mode.name === "normal" ? "private-context-marker" : "private-history-marker"));
    }
  });

  test(`${mode.name}: the HTTP override cannot authorize an endpoint from .env`, async (t) => {
    const project = await endpoint(t);
    const httpURL = project.url.replace("127.0.0.1", "0.0.0.0");
    const { cwd, env, session } = await workspace(t, `OPENAI_BASE_URL=${httpURL}\nOPENAI_API_KEY=dummy\n`);
    const beforeSession = await readFile(session, "utf8");
    const refused = await runCli([...mode.args, "--allow-insecure-http"], cwd, env);
    assert.equal(refused.code, 2, refused.stderr);
    assert.match(refused.stderr, /refusing to send credentials or context/);
    assert.equal(project.requests.length, 0);
    assert.equal(await readFile(session, "utf8"), beforeSession);
  });
}

test("an explicitly exported local endpoint still works without an API key", async (t) => {
  const chosen = await endpoint(t);
  const { cwd, env } = await workspace(t, "ASK_MODEL=stub-model\n");
  env["OPENAI_BASE_URL"] = chosen.url;
  const result = await runCli(["--no-session", "hello"], cwd, env);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(chosen.requests.length, 1);
  assert.equal(chosen.requests[0]?.authorization, "Bearer local");
});

test("outside file and directory symlinks never reach the API, even with --include-secrets", async (t) => {
  const chosen = await endpoint(t);
  const { cwd, env } = await workspace(t, "ASK_MODEL=stub-model\n");
  env["OPENAI_BASE_URL"] = chosen.url;
  const outside = await mkdtemp(path.join(tmpdir(), "ask-outside-context-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(outside, "notes.ts"), "outside-private-content-marker\n");
  await symlink(path.join(outside, "notes.ts"), path.join(cwd, "alias.ts"));
  await symlink(outside, path.join(cwd, "docs"), "junction");

  for (const flags of [[], ["--include-secrets"]]) {
    const result = await runCli([
      ...flags, "--no-session", "--json", "@alias.ts @docs @widget.ts review",
    ], cwd, env);
    assert.equal(result.code, 0, result.stderr);
    const context = JSON.parse(result.stdout).context;
    assert.deepEqual(context.files, ["widget.ts"]);
    assert.deepEqual(context.skipped, [
      { path: "alias.ts", reason: "symlink-outside-tree" },
      { path: "docs", reason: "symlink-outside-tree" },
    ]);
    const request = chosen.requests.at(-1)!;
    assert.match(request.body, /private-context-marker/);
    assert.doesNotMatch(request.body, /outside-private-content-marker/);
  }
  assert.equal(chosen.requests.length, 2);
});
