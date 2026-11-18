// Layered config from both supported entrypoint layouts: global and project files
// apply, untrusted projects cannot choose the endpoint, and .env is never read.
// Dry runs inspect the request without sending credentials or calling an API.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";


const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

async function runCli(entry: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const result = run(process.execPath, [entry, ...args], { cwd, env, timeout: 10_000 });
  // The CLI consumes piped stdin until EOF, even for a dry run.
  result.child.stdin?.end();
  return result;
}

for (const layout of ["src", "dist/src"]) {
  test(`layered config, project trust and .env from the CLI (${layout})`, async (t) => {
    const sandbox = await mkdtemp(path.join(tmpdir(), "ask-config-e2e-"));
    t.after(() => rm(sandbox, { recursive: true, force: true }));
    const install = path.join(sandbox, "install");
    const cwd = path.join(sandbox, "workspace");
    const entryDir = path.join(install, layout);
    await mkdir(entryDir, { recursive: true });
    await mkdir(cwd);
    await cp(path.join(ROOT, "dist", "src"), entryDir, { recursive: true });
    await writeFile(path.join(install, "package.json"), '{"type":"module"}\n');
    await symlink(path.join(ROOT, "node_modules"), path.join(install, "node_modules"), "junction");
    const entry = path.join(entryDir, "cli.js");

    // .env files that earlier versions read, all ignored now.
    for (const file of new Set([path.join(cwd, ".env"), path.resolve(entryDir, "..", "..", ".env"), path.resolve(entryDir, "..", ".env")])) {
      await writeFile(file, "ASK_MODEL=repository-model\nOPENAI_API_KEY=private-repository-key\n");
    }
    const xdg = path.join(sandbox, "config");
    const global = path.join(xdg, "ask", "ask.json");
    await mkdir(path.dirname(global), { recursive: true });
    await writeFile(global, '{ "model": "config-model", "system": "config-system" }');
    await chmod(global, 0o600);
    await writeFile(path.join(cwd, "ask.json"),
      '{ "system": "project-system", "endpoint": { "url": "https://project.invalid/v1", "apiKey": "private-project-key" } }');

    const env: NodeJS.ProcessEnv = { ...process.env, ASK_SESSION: "0", NO_COLOR: "1", XDG_CONFIG_HOME: xdg, ASK_STATE_DIR: path.join(sandbox, "state") };
    for (const key of Object.keys(env)) {
      if (key.startsWith("GIT_") || key.startsWith("OPENAI_") || (key.startsWith("ASK_") && !["ASK_SESSION", "ASK_STATE_DIR"].includes(key))) delete env[key];
    }
    const { stdout, stderr } = await runCli(entry, ["--dry-run", "hello"], cwd, env);
    const request = JSON.parse(stdout) as { model: string; messages: { content: string }[] };
    assert.equal(request.model, "config-model");
    assert.equal(request.messages[0]?.content, "project-system");
    assert.match(stderr, /ignored endpoint .*ask \/trust/);
    assert.doesNotMatch(`${stdout}${stderr}`, /private-|repository-/);
    assert.equal((await runCli(entry, ["--quiet", "--dry-run", "hello"], cwd, env)).stderr, "");

    await writeFile(path.join(cwd, "sample.ts"), "const safe = true;");
    await symlink("ask.json", path.join(cwd, "config-alias.txt"));
    const folder = await runCli(entry, ["--dry-run", "@. review this project"], cwd, env);
    assert.match(folder.stdout, /const safe = true/);
    assert.doesNotMatch(folder.stdout, /private-project-key|private-repository-key/);

    // AGENTS.md from the config directory, then the project root, after the system prompt.
    await writeFile(path.join(xdg, "ask", "AGENTS.md"), "personal-rules");
    await writeFile(path.join(cwd, "AGENTS.md"), "project-rules");
    const withInstructions = await runCli(entry, ["--dry-run", "hello"], cwd, env);
    assert.match(JSON.parse(withInstructions.stdout).messages[0].content,
      /^project-system\n\n<instructions source="[^"]*AGENTS\.md">\npersonal-rules\n<\/instructions>\n\n<instructions source="AGENTS\.md">\nproject-rules\n<\/instructions>$/);
    assert.match(withInstructions.stderr, /-- instructions: .*AGENTS\.md, AGENTS\.md/);
    const without = await runCli(entry, ["--no-instructions", "--dry-run", "hello"], cwd, env);
    assert.equal(JSON.parse(without.stdout).messages[0].content, "project-system");

    const shown = (await runCli(entry, ["--show-config"], cwd, env)).stdout;
    assert.match(shown, /model = "config-model"  \(global ask\.json\)/);
    assert.match(shown, /system = "project-system"  \(project ask\.json\)/);
    assert.match(shown, /project ask\.json \(untrusted: endpoint and \{env:\} ignored\)/);

    // No key anywhere: the error explains what is no longer read and where to look.
    await assert.rejects(runCli(entry, ["hello"], cwd, env), (error: unknown) => {
      const message = (error as { stderr: string }).stderr;
      assert.match(message, /no API key/);
      assert.match(message, /no longer reads \.env files[\s\S]*\.env \([^)]*OPENAI_API_KEY/);
      assert.match(message, /--show-config/);
      assert.doesNotMatch(message, /private-/);
      return true;
    });

    const trusted = await runCli(entry, ["/trust"], cwd, env);
    assert.match(trusted.stdout, /Trusted .*workspace[\s\S]*ask\.json[\s\S]*Now allowed:[\s\S]*endpoint/);
    const afterTrust = (await runCli(entry, ["--show-config"], cwd, env)).stdout;
    assert.match(afterTrust, /endpoint\.url = "https:\/\/project\.invalid\/v1"  \(project ask\.json\)/);
    assert.match(afterTrust, /endpoint\.apiKey = \(set\)/);
    assert.doesNotMatch(afterTrust, /private-project-key/);
    assert.match((await runCli(entry, ["/untrust"], cwd, env)).stdout, /No longer trusting/);

    // A config file any user can write is refused, and that is never silenced.
    if (process.platform !== "win32") {
      await chmod(global, 0o666);
      const refused = await runCli(entry, ["--quiet", "--dry-run", "hello"], cwd, env);
      assert.match(refused.stderr, /not reading .*writable by every user/);
      assert.notEqual(JSON.parse(refused.stdout).model, "config-model");
    }
  });
}
