import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const launcher = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "../src/launcher.ts" : "../src/launcher.js", import.meta.url));

/** A stand-in bun that prints its arguments, or a marker when it should never run. */
async function fakeBun(dir: string, body = "console.log(JSON.stringify(process.argv.slice(2)));") {
  await mkdir(dir, { recursive: true });
  const bun = path.join(dir, "bun");
  await writeFile(bun, `#!${process.execPath}\n${body}\n`);
  await chmod(bun, 0o755);
  return bun;
}

test("TUI launcher disables Bun env autoload and forwards literal arguments without a shell", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "ask-launcher-"));
  const cwd = path.join(base, "repo");
  try {
    await mkdir(cwd);
    const bin = path.join(base, "bin");
    await fakeBun(bin);
    const args = ["--model", "value with spaces; $(touch should-not-exist)"];
    const result = await run(process.execPath, [launcher, ...args], {
      cwd, env: { ...process.env, PATH: bin },
    });
    assert.deepEqual(JSON.parse(result.stdout), [
      "--no-env-file", `--config=${fileURLToPath(new URL("../src/bunfig.toml", import.meta.url))}`,
      fileURLToPath(new URL("../src/index.js", import.meta.url)), ...args,
    ]);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("a bun inside the working directory or on a relative PATH entry is never run", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "ask-launcher-"));
  const cwd = path.join(base, "repo");
  try {
    const marker = path.join(base, "repository-bun-ran");
    const hostile = `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");`;
    await fakeBun(cwd, hostile);
    await fakeBun(path.join(cwd, "node_modules", ".bin"), hostile);
    const bin = path.join(base, "bin");
    await fakeBun(bin);
    const env = { ...process.env, ASK_BUN: "", PATH: [".", "node_modules/.bin", cwd, path.join(cwd, "node_modules", ".bin"), bin].join(path.delimiter) };
    const result = await run(process.execPath, [launcher, "--help"], { cwd, env });
    assert.equal(JSON.parse(result.stdout).at(-1), "--help", "the bun outside the repository runs");
    await assert.rejects(access(marker), { code: "ENOENT" });
    await assert.rejects(run(process.execPath, [launcher, "--help"], {
      cwd, env: { ...env, PATH: [".", cwd].join(path.delimiter) },
    }), (error: unknown) => {
      assert.match((error as { stderr: string }).stderr, /could not find Bun/);
      return true;
    });
    await assert.rejects(access(marker), { code: "ENOENT" });
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("ASK_BUN must be an absolute executable path and takes precedence over PATH", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "ask-launcher-"));
  try {
    const chosen = await fakeBun(path.join(base, "chosen"), 'console.log("chosen");');
    await fakeBun(path.join(base, "bin"), 'console.log("path");');
    const env = { ...process.env, PATH: path.join(base, "bin") };
    const result = await run(process.execPath, [launcher], { cwd: base, env: { ...env, ASK_BUN: chosen } });
    assert.equal(result.stdout.trim(), "chosen");
    for (const value of ["bun", path.join(base, "missing")]) {
      await assert.rejects(run(process.execPath, [launcher], { cwd: base, env: { ...env, ASK_BUN: value } }),
        (error: unknown) => { assert.match((error as { stderr: string }).stderr, /ASK_BUN/); return true; });
    }
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("a signalled Bun process exits with 128 plus the signal number", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "ask-launcher-"));
  try {
    const cwd = path.join(base, "repo");
    await mkdir(cwd);
    const bin = path.join(base, "bin");
    await fakeBun(bin, 'process.kill(process.pid, "SIGTERM");');
    await assert.rejects(run(process.execPath, [launcher], { cwd, env: { ...process.env, ASK_BUN: "", PATH: bin } }),
      (error: unknown) => { assert.equal((error as { code: number }).code, 143); return true; });
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("missing Bun produces an actionable error without importing the native UI", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "ask-launcher-"));
  try {
    await assert.rejects(run(process.execPath, [launcher, "--help"], {
      cwd, env: { ...process.env, ASK_BUN: "", PATH: cwd },
    }), (error: unknown) => {
      assert.match((error as { stderr: string }).stderr, /Install Bun 1\.3\.14\+/);
      return true;
    });
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
