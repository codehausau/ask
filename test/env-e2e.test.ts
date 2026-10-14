// Exercise automatic .env loading from both supported entrypoint layouts.
// Dry runs inspect the request without sending credentials or calling an API.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { DEFAULT_SYSTEM } from "../src/chat.ts";

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

async function runCli(entry: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const result = run(process.execPath, [entry, ...args], { cwd, env, timeout: 10_000 });
  // The CLI consumes piped stdin until EOF, even for a dry run.
  result.child.stdin?.end();
  return result;
}

for (const layout of ["src", "dist/src"]) {
  test(`automatic .env files are restricted and deduplicated (${layout})`, async (t) => {
    const sandbox = await mkdtemp(path.join(tmpdir(), "ask-env-e2e-"));
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
    const forbidden = {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.fsmonitor",
      GIT_CONFIG_VALUE_0: "private-payload",
      LD_PRELOAD: "private-library",
      ASK_STATE_DIR: "private-state",
      ASK_SKILLS_DIR: "private-skills",
      ASK_SYSTEM: "private-injected-system",
    };
    const contents = Object.entries(forbidden).map(([key, value]) => `${key}=${value}`).join("\n");
    // Cover both fallbacks as well as cwd. The install root is also cwd below,
    // reproducing the restricted-then-unrestricted duplicate from the review.
    const files = new Set([
      path.join(cwd, ".env"),
      path.resolve(entryDir, "..", "..", ".env"),
      path.resolve(entryDir, "..", ".env"),
    ]);
    for (const file of files) await writeFile(file, `ASK_MODEL=file-model\n${contents}\n`);

    const env: NodeJS.ProcessEnv = { ...process.env, ASK_SESSION: "0", NO_COLOR: "1" };
    for (const key of Object.keys(env)) {
      if (key.startsWith("GIT_") || key.startsWith("OPENAI_") || key in forbidden || key === "ASK_MODEL") {
        delete env[key];
      }
    }
    for (const working of [cwd, install]) {
      const { stdout, stderr } = await runCli(entry, ["--dry-run", "hello"], working, env);
      const request = JSON.parse(stdout) as { model: string; messages: { content: string }[] };
      assert.equal(request.model, "file-model");
      assert.equal(request.messages[0]?.content, DEFAULT_SYSTEM);
      assert.equal(stderr.split("-- ignored ").length - 1, working === cwd ? 3 : 2);
      for (const key of Object.keys(forbidden)) assert.ok(stderr.includes(key), key);
      assert.doesNotMatch(`${stdout}${stderr}`, /private-/);
    }

    const quiet = await runCli(entry, ["--quiet", "--dry-run", "hello"], cwd, env);
    assert.equal(quiet.stderr, "");
    assert.equal(JSON.parse(quiet.stdout).messages[0].content, DEFAULT_SYSTEM);

    // Install-location fallback endpoints require explicit selection too.
    await writeFile(path.join(install, ".env"),
      "OPENAI_BASE_URL=https://fixture.invalid/v1\nOPENAI_API_KEY=dummy\n");
    await assert.rejects(runCli(entry, ["hello"], cwd, env), /refusing to send credentials or context/);
  });
}
