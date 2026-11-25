// Verify the published layout, not just a linked source checkout. Packing and
// npm's publish dry-run are offline; dependencies are linked from this install.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// Resolve before replacing HOME: asdf and other version-manager shims may need
// the real home just to locate npm. Run the CLI with this Node, not that shim.
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

interface Packed {
  name: string;
  version: string;
  filename: string;
  files: { path: string }[];
}

/** npm versions emit either an array, a single report, or package-keyed reports. */
function packReports(stdout: string): Packed[] {
  const parsed: unknown = JSON.parse(stdout);
  const reports: unknown[] = Array.isArray(parsed) ? parsed
    : parsed && typeof parsed === "object" ? ("name" in parsed ? [parsed] : Object.values(parsed)) : [];
  assert.ok(reports.length > 0, `empty npm pack report: ${stdout}`);
  for (const report of reports) {
    assert.ok(report && typeof report === "object" &&
      "name" in report && typeof report.name === "string" &&
      "version" in report && typeof report.version === "string" &&
      "filename" in report && typeof report.filename === "string" &&
      "files" in report && Array.isArray(report.files), `unexpected npm pack report: ${stdout}`);
  }
  return reports as Packed[];
}

test("npm pack metadata accepts array, single and package-keyed reports", () => {
  const report: Packed = { name: "@codehaus-au/ask", version: "0.2.0", filename: "ask.tgz", files: [{ path: "package.json" }] };
  for (const value of [[report], report, { [report.name]: report }]) {
    assert.deepEqual(packReports(JSON.stringify(value)), [report]);
  }
  for (const value of [null, {}, [], { error: "failed" }]) {
    assert.throws(() => packReports(JSON.stringify(value)), /npm pack report/);
  }
});

test("the npm tarball contains the runnable CLI and completions, without source/test/config leakage", async (t) => {
  const npm = await npmCli();
  const base = await mkdtemp(path.join(tmpdir(), "ask-package-"));
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
    HOME: home, CI: "1", NO_COLOR: "1", ASK_SESSION: "0", XDG_STATE_HOME: path.join(home, "state"),
    npm_config_userconfig: path.join(home, ".npmrc"), npm_config_globalconfig: path.join(home, "global.npmrc"),
    npm_config_cache: path.join(home, "cache"), npm_config_offline: "true", npm_config_update_notifier: "false",
  });
  // pnpm test has already built dist. Avoid rebuilding it concurrently with
  // other suites that execute/copy the compiled CLI.
  const packed = await run(process.execPath, [npm, "pack", "--ignore-scripts", "--json", "--pack-destination", packedDir], {
    cwd: ROOT, env, timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
  });
  const metadata = packReports(packed.stdout);
  assert.equal(metadata.length, 1);
  const archive = metadata[0]!;
  const manifest = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"));
  assert.equal(archive.name, "@codehaus-au/ask");
  assert.equal(archive.version, manifest.version);
  const files = new Set(archive.files.map((file) => file.path));
  for (const required of [
    "package.json", "README.md", "LICENSE", "completions/ask.bash",
    "dist/src/cli.js", "dist/src/safe-write.js", "dist/src/terminal.js",
    "schema/ask.schema.json", "schema/cli.schema.json", "schema/tui.schema.json",
  ]) assert.ok(files.has(required), `missing packaged file: ${required}`);
  // ask-tui is published separately; none of it, nor OpenTUI, belongs here.
  assert.equal(manifest.dependencies["@opentui/core"], undefined);
  assert.equal(manifest.bin["ask-tui"], undefined);
  for (const [subpath, target] of Object.entries(manifest.exports as Record<string, string | { types: string; default: string }>)) {
    if (typeof target === "string") continue;
    assert.ok(files.has(target.default.slice(2)), `missing export ${subpath}: ${target.default}`);
    assert.ok(files.has(target.types.slice(2)), `missing export types ${subpath}: ${target.types}`);
  }
  for (const file of files) {
    assert.ok(file.startsWith("dist/src/") || file.startsWith("completions/") || file.startsWith("schema/") ||
      ["package.json", "README.md", "LICENSE"].includes(file), `unexpected packaged file: ${file}`);
    assert.doesNotMatch(file, /(^|\/)\.env(?:\.|$)|(^|\/)\.npmrc$/);
    assert.doesNotMatch(file, /^dist\/src\/(?:tui(?:[-/.]|$)|themes(?:\/|\.)|updates\.)/, "TUI files ship in @codehaus-au/ask-tui");
  }

  const tarball = path.join(packedDir, archive.filename);
  await run("tar", ["-xzf", tarball, "-C", extracted], { env });
  const installed = path.join(extracted, "package");
  assert.match(await readFile(path.join(installed, "README.md"), "utf8"), /https:\/\/github\.com\/codehausau\/ask\/blob\/main\/SECURITY\.md/);
  await symlink(path.join(ROOT, "node_modules"), path.join(installed, "node_modules"), "junction");
  const cli = path.join(installed, "dist", "src", "cli.js");
  await access(cli, constants.X_OK);
  // The internal subpaths ask-tui imports must resolve through "exports" in the
  // installed layout, not only through the workspace link.
  const probe = path.join(installed, "exports-probe.mjs");
  await writeFile(probe, `
    const { terminalField } = await import("@codehaus-au/ask/internal/terminal");
    const { DEFAULT_RESPONSE_TIMEOUT_MS } = await import("@codehaus-au/ask/internal/timeout");
    console.log(terminalField("a\\nb"), DEFAULT_RESPONSE_TIMEOUT_MS);
  `);
  const exported = await run(process.execPath, [probe], { cwd: base, env });
  assert.equal(exported.stdout.trim(), "a\\nb 120000");
  await rm(probe);
  const version = await run(process.execPath, [cli, "--version"], { cwd: base, env });
  assert.equal(version.stdout.trim(), `ask ${manifest.version}`);
  const completion = await run(process.execPath, [cli, "--install-completion"], { cwd: base, env });
  assert.ok(completion.stdout.includes(path.join(installed, "completions", "ask.bash")));
  await writeFile(path.join(base, "sample.ts"), "export const packaged = true;\n");
  const contextRun = run(process.execPath, [cli, "--no-session", "--show-context", "@sample.ts"], { cwd: base, env });
  contextRun.child.stdin?.end();
  assert.match((await contextRun).stdout, /attach\s+sample\.ts/);

  const dryRun = await run(process.execPath, [npm,
    "publish", tarball, "--dry-run", "--ignore-scripts", "--provenance=false", "--access", "public", "--json",
  ], { cwd: base, env, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
  // npm 10 emits metadata directly; newer npm emits a package-name-keyed report.
  // Node 20/22 and Node 24 ship different npm versions in the CI matrix.
  const report = JSON.parse(dryRun.stdout) as Record<string, unknown>;
  const publish = (report[manifest.name] ?? report) as { name: string; version: string };
  assert.equal(publish.name, manifest.name, `unexpected npm publish report: ${dryRun.stdout}`);
  assert.equal(publish.version, manifest.version);
});
