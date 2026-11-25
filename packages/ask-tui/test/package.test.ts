// Verify the published layout, not just a linked source checkout. Packing and
// npm's publish dry-run are offline; dependencies are linked from this install.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CORE = path.resolve(ROOT, "..", "ask");

// Resolve before replacing HOME: version-manager shims may need the real home
// just to locate npm. Run the CLI with this Node instead of invoking that shim.
async function npmCli(): Promise<string> {
  const candidates = [path.resolve(path.dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js")];
  for (const dir of (process.env["PATH"] ?? "").split(path.delimiter)) {
    const resolved = await realpath(path.join(dir, "npm")).catch(() => null);
    if (resolved && path.basename(resolved) === "npm-cli.js") candidates.push(resolved);
  }
  for (const file of candidates) {
    if (await access(file).then(() => true, () => false)) return file;
  }
  const { stdout } = await run("npm", ["root", "--global"], { timeout: 30_000 });
  const file = path.join(stdout.trim(), "npm", "bin", "npm-cli.js");
  await access(file);
  return file;
}

test("the npm tarball pins the matching core version and ships only the runnable TUI", async (t) => {
  const npm = await npmCli();
  const base = await mkdtemp(path.join(tmpdir(), "ask-tui-package-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const home = path.join(base, "home");
  const packedDir = path.join(base, "packed");
  const extracted = path.join(base, "installed package");
  await mkdir(home);
  await mkdir(packedDir);
  await mkdir(extracted);
  await writeFile(path.join(home, ".npmrc"), "");
  await writeFile(path.join(home, "global.npmrc"), "");
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(ASK_|OPENAI_|GIT_|PNPM_|NPM_CONFIG_|NPM_TOKEN$|NODE_AUTH_TOKEN$)/i.test(key) ||
        ["FORCE_COLOR", "NODE_OPTIONS"].includes(key)) delete env[key];
  }
  Object.assign(env, {
    HOME: home, CI: "1", NO_COLOR: "1",
    npm_config_userconfig: path.join(home, ".npmrc"), npm_config_globalconfig: path.join(home, "global.npmrc"),
    npm_config_cache: path.join(home, "cache"), npm_config_offline: "true", npm_config_update_notifier: "false",
    // pnpm test has already built dist; do not rebuild it under other suites.
    npm_config_ignore_scripts: "true",
  });
  // pnpm, not npm: only pnpm rewrites the workspace:* dependency on pack.
  await run("pnpm", ["pack", "--pack-destination", packedDir], { cwd: ROOT, env, timeout: 30_000 });
  const manifest = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"));
  const core = JSON.parse(await readFile(path.join(CORE, "package.json"), "utf8"));
  const tarball = path.join(packedDir, `codehaus-au-ask-tui-${manifest.version}.tgz`);
  await run("tar", ["-xzf", tarball, "-C", extracted], { env });
  const installed = path.join(extracted, "package");
  const packedManifest = JSON.parse(await readFile(path.join(installed, "package.json"), "utf8"));

  assert.equal(packedManifest.name, "@codehaus-au/ask-tui");
  assert.equal(manifest.version, core.version, "the packages are released in lockstep");
  assert.equal(packedManifest.dependencies["@codehaus-au/ask"], core.version, "core must be pinned exactly");
  assert.equal(packedManifest.bin["ask-tui"], "dist/src/launcher.js");

  const listing = await run("tar", ["-tzf", tarball], { env, maxBuffer: 4 * 1024 * 1024 });
  const files = new Set(listing.stdout.trim().split("\n").map((file) => file.replace(/^package\//, "")));
  for (const required of [
    "package.json", "README.md", "LICENSE", "THIRD_PARTY_NOTICES.md",
    "dist/src/launcher.js", "dist/src/index.js", "dist/src/ui.js", "dist/src/bunfig.toml",
    "dist/src/chat.js", "dist/src/picker.js", "dist/src/updates.js",
    "dist/src/themes.js", "dist/src/theme.js", "dist/src/themes/default.js", "dist/src/themes/dracula.js",
    "schema/theme.schema.json",
  ]) assert.ok(files.has(required), `missing packaged file: ${required}`);
  for (const file of files) {
    assert.ok(file.startsWith("dist/src/") || file.startsWith("schema/") ||
      ["package.json", "README.md", "LICENSE", "THIRD_PARTY_NOTICES.md"].includes(file), `unexpected packaged file: ${file}`);
    assert.doesNotMatch(file, /(^|\/)\.env(?:\.|$)|(^|\/)\.npmrc$/);
  }
  assert.equal([...files].filter((file) => file.startsWith("dist/src/themes/") && file.endsWith(".json")).length, 0, "obsolete OpenCode assets must not ship");
  assert.equal([...files].filter((file) => file.startsWith("dist/src/themes/") && file.endsWith(".js") && !file.endsWith("/types.js")).length, 40);
  assert.match(await readFile(path.join(installed, "README.md"), "utf8"), /https:\/\/github\.com\/codehausau\/ask\/blob\/main\/SECURITY\.md/);

  await symlink(path.join(ROOT, "node_modules"), path.join(installed, "node_modules"), "junction");
  await access(path.join(installed, "dist", "src", "launcher.js"), constants.X_OK);
  const themes = await run(process.execPath, ["--input-type=module", "-e", `
    const { THEME_NAMES, themeModes, themePalette } = await import(${JSON.stringify(pathToFileURL(path.join(installed, "dist/src/themes.js")).href)});
    for (const name of THEME_NAMES) for (const mode of themeModes(name)) themePalette(name, mode);
    console.log(THEME_NAMES.length);
  `], { cwd: base, env });
  assert.equal(themes.stdout.trim(), "41");

  const dryRun = await run(process.execPath, [npm,
    "publish", tarball, "--dry-run", "--ignore-scripts", "--provenance=false", "--access", "public", "--json",
  ], { cwd: base, env, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
  // npm 10 emits metadata directly; newer npm emits a package-name-keyed report.
  const report = JSON.parse(dryRun.stdout) as Record<string, unknown>;
  const publish = (report[manifest.name] ?? report) as { name: string; version: string };
  assert.equal(publish.name, manifest.name, `unexpected npm publish report: ${dryRun.stdout}`);
  assert.equal(publish.version, manifest.version);
});
