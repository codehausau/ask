// Run the README's global-link setup without touching the developer's pnpm home
// or shell rc files. Everything pnpm writes lives in the disposable directory.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = execFile(command, args, { cwd, env, timeout: 30_000 }, (error, stdout, stderr) => {
      if (error && typeof error.code !== "number") return reject(error);
      resolve({ code: error ? Number(error.code) : 0, stdout, stderr });
    });
    child.stdin?.end();
  });
}

test("pnpm setup enables a global link in a clean home, including a checkout with spaces", async (t) => {
  const workspace = JSON.parse(await readFile(path.resolve(ROOT, "..", "..", "package.json"), "utf8")) as { packageManager: string };
  // Reuse the actual CLI running the suite, not a PATH shim that can select a
  // different pnpm after HOME/cwd change. Direct node --test uses Corepack's
  // explicit version selector instead of relying on project auto-detection.
  const cli = process.env["npm_execpath"];
  let command = "corepack";
  let prefix = [workspace.packageManager];
  if (cli && /pnpm/i.test(path.basename(cli))) {
    command = /\.[cm]?js$/.test(cli) ? process.execPath : cli;
    prefix = command === process.execPath ? [cli] : [];
  }
  const version = await run(command, [...prefix, "--version"], ROOT, process.env);
  assert.equal(version.code, 0, `${version.stdout}${version.stderr}`);
  assert.equal(version.stdout.trim(), workspace.packageManager.slice("pnpm@".length), "run tests using the workspace's pinned pnpm");
  const base = await mkdtemp(path.join(tmpdir(), "ask-link-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const home = path.join(base, "home");
  const project = path.join(base, "checkout with spaces");
  const manifest = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8")) as { version: string };
  await mkdir(home);
  await mkdir(project);
  // The package inherits this pin in the workspace, but the disposable checkout
  // is outside it. Without copying the pin, Corepack can silently choose a newer
  // pnpm here than the version used to run the test suite.
  const packageJson = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"));
  await writeFile(path.join(project, "package.json"), JSON.stringify({ ...packageJson, packageManager: workspace.packageManager }));
  await cp(path.join(ROOT, "dist", "src"), path.join(project, "dist", "src"), { recursive: true });
  await symlink(path.join(ROOT, "node_modules"), path.join(project, "node_modules"), "junction");
  await writeFile(path.join(home, ".bashrc"),
    "# isolated pnpm setup test\ncase $- in *i*) ;; *) return ;; esac\n");
  await writeFile(path.join(home, ".npmrc"), "");
  await writeFile(path.join(home, "global.npmrc"), "");
  await writeFile(path.join(project, "sample.ts"), "export const sample = 1;\n");
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Keep version-manager installation locations stable while isolating pnpm's
  // home/config. Otherwise a shim may try to find asdf under the disposable HOME.
  env["ASDF_DATA_DIR"] ??= path.join(homedir(), ".asdf");
  env["COREPACK_HOME"] ??= path.join(process.env["XDG_CACHE_HOME"] ?? path.join(homedir(), ".cache"), "node", "corepack");
  for (const key of Object.keys(env)) {
    if (/^(PNPM_|NPM_CONFIG_|ASK_|OPENAI_|GIT_|BASH_FUNC_|LD_|DYLD_)/i.test(key) ||
        ["BASH_ENV", "ENV", "NODE_OPTIONS"].includes(key)) delete env[key];
  }
  Object.assign(env, {
    HOME: home, XDG_CONFIG_HOME: path.join(home, "config"), XDG_DATA_HOME: path.join(home, "data"),
    XDG_CACHE_HOME: path.join(home, "cache"), XDG_STATE_HOME: path.join(home, "state"),
    SHELL: "/bin/bash", CI: "1", NO_COLOR: "1", ASK_SESSION: "0",
    npm_config_userconfig: path.join(home, ".npmrc"), npm_config_globalconfig: path.join(home, "global.npmrc"),
    npm_config_offline: "true", npm_config_update_notifier: "false",
  });

  const before = await run(command, [...prefix, "link", "--global"], project, env);
  assert.notEqual(before.code, 0, "a fresh home has no configured global bin directory");
  assert.match(`${before.stdout}${before.stderr}`, /ERR_PNPM_NO_GLOBAL_BIN_DIR/);
  const setup = await run(command, [...prefix, "setup"], project, env);
  assert.equal(setup.code, 0, `${setup.stdout}${setup.stderr}`);
  assert.match(await readFile(path.join(home, ".bashrc"), "utf8"), /PNPM_HOME/);
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const linked = await run("bash", ["--noprofile", "--rcfile", path.join(home, ".bashrc"), "-ic", [
    [command, ...prefix, "link", "--global"].map(quote).join(" "),
    "command -v ask",
    "ask --version",
    "ask --show-context --no-session @sample.ts",
  ].join(" && ")], project, env);
  assert.equal(linked.code, 0, `${linked.stdout}${linked.stderr}`);
  assert.ok(linked.stdout.includes(`ask ${manifest.version}`));
  assert.match(linked.stdout, /attach\s+sample\.ts/);
});
