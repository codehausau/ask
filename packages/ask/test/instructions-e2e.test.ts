import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));

test("one-shot CLI sends project instructions only with per-invocation consent and previews selected files", async (t) => {
  const base = await mkdtemp(path.join(tmpdir(), "ask-instruction-consent-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const cwd = path.join(base, "project");
  const xdg = path.join(base, "config");
  const custom = path.join(base, "custom");
  await mkdir(path.join(cwd, ".ask"), { recursive: true });
  await mkdir(path.join(xdg, "ask"), { recursive: true });
  await mkdir(custom);
  await writeFile(path.join(xdg, "ask", "AGENTS.md"), "PERSONAL_RULES");
  await writeFile(path.join(custom, "AGENTS.md"), "CUSTOM_RULES");
  await writeFile(path.join(cwd, "AGENTS.md"), "PROJECT_RULES");
  await writeFile(path.join(cwd, ".ask", "AGENTS.md"), "DOT_ASK_RULES");
  await writeFile(path.join(cwd, "rules.md"), "CONFIGURED_PROJECT_RULES");
  await writeFile(path.join(cwd, "example.ts"), "const explicit = true;\n");
  await writeFile(path.join(cwd, "ask.json"), JSON.stringify({ instructions: ["rules.md"] }), { mode: 0o600 });
  const bodies: string[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      bodies.push(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ model: "stub", choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/v1`;
  const env = { PATH: process.env["PATH"], XDG_CONFIG_HOME: xdg, ASK_STATE_DIR: path.join(base, "state") };
  async function cli(args: string[]) {
    const result = run(process.execPath, [CLI, "--base-url", url, "--config", custom, ...args], { cwd, env, timeout: 10_000 });
    result.child.stdin?.end();
    return result;
  }
  for (const trusted of [false, true]) {
    if (trusted) await cli(["/trust"]);
    for (const flags of [[], ["--no-session"], ["--session", "named"], ["--no-session", "@example.ts"]]) {
      await cli([...flags, "--quiet", "hello"]);
      const body = bodies.at(-1)!;
      assert.match(body, /PERSONAL_RULES/);
      assert.match(body, /CUSTOM_RULES/);
      assert.doesNotMatch(body, /PROJECT_RULES|DOT_ASK_RULES|CONFIGURED_PROJECT_RULES/);
    }
    const selected = await cli(["--no-session", "--quiet", "--project-instructions", "hello"]);
    assert.match(bodies.at(-1)!, /PROJECT_RULES/);
    assert.match(bodies.at(-1)!, /DOT_ASK_RULES/);
    assert.match(bodies.at(-1)!, /CONFIGURED_PROJECT_RULES/);
    assert.match(selected.stderr, /-- instructions: .*AGENTS\.md.*rules\.md.*\.ask/);
    assert.doesNotMatch(selected.stderr, /PROJECT_RULES/, "preview lists paths, not prompt contents");
    await cli(["--no-session", "--project-instructions", "--no-instructions", "hello"]);
    assert.doesNotMatch(bodies.at(-1)!, /PERSONAL_RULES|CUSTOM_RULES|PROJECT_RULES|DOT_ASK_RULES|CONFIGURED_PROJECT_RULES/);
  }
  const count = bodies.length;
  const preview = await cli(["--project-instructions", "--show-context", "hello"]);
  assert.match(preview.stdout, /instruction\s+AGENTS\.md\s+\(project AGENTS\.md\)/);
  assert.match(preview.stdout, /instruction\s+rules\.md\s+\(project ask\.json\)/);
  assert.match(preview.stdout, /instruction\s+\.ask\/AGENTS\.md/);
  const defaults = await cli(["--show-context", "hello"]);
  assert.doesNotMatch(defaults.stdout, /project AGENTS\.md|project ask\.json|project \.ask/);
  assert.equal(bodies.length, count, "--show-context must never send");
});
