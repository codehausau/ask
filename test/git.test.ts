import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { constants, writeFileSync } from "node:fs";
import fs, { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { gitDiffNoIndex, gitEnv, gitFileState, gitListFiles, gitRoot } from "../src/git.ts";
import { shellQuote } from "../src/write.ts";

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ORIGINAL = "original\n";

function environment(t: TestContext, changes: NodeJS.ProcessEnv) {
  const old: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(changes)) {
    old[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

async function fixture(t: TestContext, format = "sha1") {
  const base = await mkdtemp(path.join(tmpdir(), "ask-git-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const cwd = path.join(base, "repo");
  const home = path.join(base, "home");
  await mkdir(cwd);
  await mkdir(home);
  environment(t, { HOME: home, XDG_CONFIG_HOME: home });
  const env: NodeJS.ProcessEnv = {
    ...gitEnv(process.env), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
  };
  // Raw commands are used only to set up/probe these disposable repositories.
  delete env["GIT_NO_LAZY_FETCH"];
  const raw = (args: string[]) => run("git", ["-C", cwd, ...args], { env, timeout: 5000 });
  await raw(["init", "-q", `--object-format=${format}`]);
  const file = path.join(cwd, "source.txt");
  await writeFile(file, ORIGINAL);
  await raw(["add", "--", "source.txt"]);
  await raw(["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"]);
  const proposed = path.join(cwd, "proposed.txt");
  await writeFile(proposed, "modified\n");
  const marker = path.join(base, "program-ran");
  const script = path.join(base, "program.cjs");
  return { base, cwd, file, proposed, marker, script, raw, env };
}

async function program(script: string, marker: string, body: string) {
  await writeFile(script, `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'ran\\n');\n${body}\n`);
  return `${shellQuote(process.execPath)} ${shellQuote(script)}`;
}

async function didRun(marker: string) {
  return stat(marker).then(() => true, () => false);
}

test("Git receives neither environment configuration overrides nor loader/startup injections", () => {
  const source = {
    PATH: "/usr/bin", HOME: "/home/test", SystemRoot: "C:\\Windows", LANG: "C.UTF-8",
    GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.fsmonitor", GIT_CONFIG_VALUE_0: "payload",
    GIT_CONFIG_PARAMETERS: "payload", GIT_EXTERNAL_DIFF: "payload", GIT_EXEC_PATH: "payload",
    GIT_DIR: "other-repo", GIT_WORK_TREE: "other-tree", GIT_INDEX_FILE: "other-index",
    GIT_TERMINAL_PROMPT: "1", GIT_NO_LAZY_FETCH: "0", Git_Config_Count: "2",
    LD_PRELOAD: "payload", LD_LIBRARY_PATH: "payload", DYLD_INSERT_LIBRARIES: "payload",
    NODE_OPTIONS: "payload", BASH_ENV: "payload", ENV: "payload", SHELLOPTS: "payload",
    BASHOPTS: "payload", IFS: "payload", CDPATH: "payload",
    OPENAI_API_KEY: "private-key", ASK_SYSTEM: "private-system",
  };
  assert.deepEqual(gitEnv(source), {
    PATH: source.PATH, HOME: source.HOME, SystemRoot: source.SystemRoot, LANG: source.LANG,
    GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1", GIT_ATTR_NOSYSTEM: "1",
  });
  assert.equal(source.GIT_CONFIG_COUNT, "1", "the parent environment is not mutated");
});

test("repository fsmonitor cannot run and read-only queries leave the index unchanged", async (t) => {
  const { cwd, file, proposed, marker, script, raw } = await fixture(t);
  const command = await program(script, marker, "process.stdout.write('test-token\\0');");
  await raw(["config", "core.fsmonitor", command]);
  await raw(["ls-files"]);
  assert.equal(await didRun(marker), true, "positive control: ordinary Git invokes the configured hook");
  await rm(marker);
  const index = path.join(cwd, ".git", "index");
  const before = await readFile(index);
  const beforeStat = await stat(index);
  assert.equal(await gitRoot(cwd), cwd);
  assert.ok((await gitListFiles(cwd))?.includes("source.txt"));
  assert.equal(await gitFileState(file), "clean");
  assert.match(await gitDiffNoIndex(file, proposed, false) ?? "", /-original\n\+modified/);
  assert.equal(await didRun(marker), false);
  assert.deepEqual(await readFile(index), before);
  assert.equal((await stat(index)).mtimeMs, beforeStat.mtimeMs);
});

test("exported Git overrides cannot run helpers or redirect the index/worktree", async (t) => {
  const { cwd, file, proposed, marker, script } = await fixture(t);
  const command = await program(script, marker, "process.stdout.write('test-token\\0');");
  environment(t, {
    GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.fsmonitor", GIT_CONFIG_VALUE_0: command,
    GIT_EXTERNAL_DIFF: command, GIT_DIR: "/does-not-exist", GIT_WORK_TREE: "/does-not-exist",
    GIT_INDEX_FILE: "/does-not-exist", GIT_EXEC_PATH: "/does-not-exist", LD_PRELOAD: "/does-not-exist",
  });
  assert.equal(await gitRoot(cwd), cwd);
  assert.ok((await gitListFiles(cwd))?.includes("source.txt"));
  assert.equal(await gitFileState(file), "clean");
  assert.match(await gitDiffNoIndex(file, proposed, false) ?? "", /\+modified/);
  assert.equal(await didRun(marker), false);
});

for (const kind of ["clean", "process"]) {
  test(`file-state checks never invoke ${kind} filters, even when Git status would`, async (t) => {
    const { cwd, file, proposed, marker, script, raw } = await fixture(t);
    const command = await program(script, marker, kind === "clean"
      ? "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('original\\n'));"
      : "process.exit(1);");
    await writeFile(path.join(cwd, ".gitattributes"), "source.txt filter=probe\n");
    await raw(["config", `filter.probe.${kind}`, command]);
    await raw(["config", "filter.probe.required", "true"]);
    // Same size forces status to examine content rather than just the stat size.
    await writeFile(file, "modified\n");
    const ordinary = await raw(["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain", "--", "source.txt"])
      .catch(() => null);
    assert.equal(await didRun(marker), true, "positive control: Dan's status flags alone do not stop filters");
    if (kind === "clean") assert.equal(ordinary?.stdout, "", "the filter can conceal different raw bytes");
    await rm(marker);
    assert.equal(await gitFileState(file), "dirty");
    assert.equal(await didRun(marker), false, "file-state queries must not run filters");
    assert.ok(await gitListFiles(cwd));
    assert.equal(await didRun(marker), false, "file listing must not run filters");
    await gitDiffNoIndex(file, proposed, false);
    assert.equal(await didRun(marker), false, "diff previews must not run filters");
  });
}

test("diff previews disable configured external diff, textconv and environment helpers", async (t) => {
  const { cwd, file, proposed, marker, script, raw } = await fixture(t);
  const command = await program(script, marker, "process.stdout.write('external output');");
  await raw(["config", "diff.external", command]);
  await raw(["config", "diff.probe.textconv", command]);
  await raw(["config", "filter.probe.clean", command]);
  await writeFile(path.join(cwd, ".gitattributes"), "*.txt diff=probe\n");
  await writeFile(path.join(cwd, ".git", "info", "attributes"), "*.txt filter=probe diff=probe\n");
  environment(t, { GIT_EXTERNAL_DIFF: command });
  const diff = await gitDiffNoIndex(file, proposed, false);
  assert.match(diff ?? "", /-original\n\+modified/);
  assert.doesNotMatch(diff ?? "", /external output/);
  assert.equal(await didRun(marker), false);
});

test("diff previews do not execute filters selected by global attributes", async (t) => {
  const { base, cwd, file, proposed, marker, script, raw, env } = await fixture(t);
  const command = await program(script, marker, "process.stdout.write('filtered');");
  const global = path.join(base, "home", ".gitconfig");
  const attributes = path.join(base, "global-attributes");
  await writeFile(attributes, "*.txt filter=probe\n");
  await raw(["config", "--file", global, "core.attributesFile", attributes]);
  await raw(["config", "--file", global, "filter.probe.clean", command]);
  await run("git", ["-C", cwd, "diff", "--no-index", "--", file, proposed], {
    env: { ...env, GIT_CONFIG_GLOBAL: global }, timeout: 5000,
  }).catch(() => null);
  assert.equal(await didRun(marker), true, "positive control: global attributes can select executable filters");
  await rm(marker);
  assert.match(await gitDiffNoIndex(file, proposed, false) ?? "", /-original\n\+modified/);
  assert.equal(await didRun(marker), false);
});

for (const format of ["sha1", "sha256"]) {
  test(`raw cleanliness checks handle index/HEAD changes and ignore cached-clean flags (${format})`, async (t) => {
    const { cwd, file, raw } = await fixture(t, format);
    assert.equal(await gitFileState(file), "clean");
    for (const flag of ["assume-unchanged", "skip-worktree"]) {
      await raw(["update-index", `--${flag}`, "--", "source.txt"]);
      await writeFile(file, "modified\n");
      assert.equal(await gitFileState(file), "dirty", flag);
      await raw(["update-index", `--no-${flag}`, "--", "source.txt"]);
      await writeFile(file, ORIGINAL);
    }
    await writeFile(file, "modified\n");
    await raw(["add", "--", "source.txt"]);
    assert.equal(await gitFileState(file), "dirty", "a staged change does not match HEAD");
    await raw(["reset", "-q", "HEAD", "--", "source.txt"]);
    await writeFile(file, ORIGINAL);
    assert.equal(await gitFileState(file), "clean");
    await chmod(file, 0o755);
    assert.equal(await gitFileState(file), "dirty", "mode changes also need an explicit override");
    const fresh = path.join(cwd, "fresh.txt");
    await writeFile(fresh, "new\n");
    assert.equal(await gitFileState(fresh), "untracked");
    await raw(["add", "--", "fresh.txt"]);
    assert.equal(await gitFileState(fresh), "dirty", "a newly staged path has no HEAD entry");
  });
}

test("literal pathspecs and NUL records preserve odd filenames", async (t) => {
  const { cwd, raw } = await fixture(t);
  for (const name of ["*.txt", ":(glob)*.txt", "-flag", "tab\tline\nfile.txt", "empty.txt"]) {
    const file = path.join(cwd, name);
    await writeFile(file, name === "empty.txt" ? "" : ORIGINAL);
    await raw(["--literal-pathspecs", "add", "--", name]);
    await raw(["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "odd file"]);
    assert.equal(await gitFileState(file), "clean", name);
  }
});

test("an unborn repository has no undo copy even when the file is staged", async (t) => {
  const { base, env } = await fixture(t);
  const cwd = path.join(base, "unborn");
  await mkdir(cwd);
  await run("git", ["-C", cwd, "init", "-q"], { env });
  const file = path.join(cwd, "source.txt");
  await writeFile(file, ORIGINAL);
  await run("git", ["-C", cwd, "add", "--", "source.txt"], { env });
  assert.equal(await gitFileState(file), "dirty");
});

test("CRLF-normalised files conservatively require force instead of running transformations", async (t) => {
  const { file, raw } = await fixture(t);
  await raw(["config", "core.autocrlf", "true"]);
  await writeFile(file, "changed\n");
  await raw(["checkout", "--", "source.txt"]);
  assert.equal(await readFile(file, "utf8"), "original\r\n");
  assert.equal((await raw(["status", "--porcelain", "--", "source.txt"])).stdout, "");
  assert.equal(await gitFileState(file), "dirty");
});

test("missing promisor objects never launch a lazy fetch or remote helper", async (t) => {
  const { cwd, file, marker, script, raw } = await fixture(t);
  await program(script, marker, "process.exit(1);");
  await raw(["config", "remote.origin.promisor", "true"]);
  await raw(["config", "extensions.partialClone", "origin"]);
  await raw(["config", "protocol.ext.allow", "always"]);
  await raw(["config", "remote.origin.url", `ext::${process.execPath} ${script}`]);
  const oid = (await raw(["rev-parse", "HEAD:source.txt"])).stdout.trim();
  await rm(path.join(cwd, ".git", "objects", oid.slice(0, 2), oid.slice(2)));
  assert.equal(await gitFileState(file), "dirty", "there is no local undo copy");
  assert.equal(await didRun(marker), false);
  await raw(["cat-file", "-e", oid]).catch(() => null);
  assert.equal(await didRun(marker), true, "positive control: an ordinary lookup launches the configured helper");
});

test("only a diff exit code of 1 is accepted, and unsupported Git fails closed", async (t) => {
  const { base, cwd, file, proposed } = await fixture(t);
  const bin = path.join(base, "bin");
  await mkdir(bin);
  const executable = path.join(bin, "git");
  await writeFile(executable, "#!/bin/sh\nprintf 'not a valid patch\\n'\nexit 2\n", { mode: 0o755 });
  environment(t, { PATH: `${bin}${path.delimiter}${process.env["PATH"] ?? ""}` });
  assert.equal(await gitDiffNoIndex(file, proposed, false), null);
  await writeFile(executable, "#!/bin/sh\nprintf 'unsupported safety option\\n' >&2\nexit 129\n", { mode: 0o755 });
  assert.equal(await gitRoot(cwd), null);
  assert.equal(await gitListFiles(cwd), null);
  assert.equal(await gitFileState(file), "no-repo");
});

test("Git listing results cannot introduce paths outside the requested search root", async (t) => {
  const { base, cwd } = await fixture(t);
  const bin = path.join(base, "bin");
  await mkdir(bin);
  await writeFile(path.join(bin, "git"),
    "#!/bin/sh\nprintf '%s\\0' 'source.txt' '../outside.txt' '/absolute.txt' '..notes/file.ts' 'src/../../outside.txt'\n",
    { mode: 0o755 });
  environment(t, { PATH: `${bin}${path.delimiter}${process.env["PATH"] ?? ""}` });
  assert.deepEqual(await gitListFiles(cwd), ["source.txt", "..notes/file.ts"]);
});

test("completion Git calls disable fsmonitor and preserve the parent shell environment", async (t) => {
  const { cwd, marker, script, raw, env } = await fixture(t);
  const command = await program(script, marker, "process.stdout.write('test-token\\0');");
  await raw(["config", "core.fsmonitor", command]);
  const completion = path.join(ROOT, "completions", "ask.bash");
  const result = await run("bash", ["-c", [
    'source "$1"', '_ask_all_paths',
    'printf "config-count=%s\\n" "$GIT_CONFIG_COUNT"',
  ].join("\n"), "_", completion], {
    cwd, env: { ...env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.fsmonitor", GIT_CONFIG_VALUE_0: command },
  });
  assert.match(result.stdout, /source\.txt/);
  assert.match(result.stdout, /config-count=1/);
  assert.equal(await didRun(marker), false);
});

test("Git state rejects symlink entries rather than validating their referents", async (t) => {
  const { cwd, file, raw } = await fixture(t);
  await symlink(file, path.join(cwd, "alias.txt"));
  await raw(["add", "--", "alias.txt"]);
  await raw(["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "link"]);
  assert.equal(await gitFileState(path.join(cwd, "alias.txt")), "dirty");
});

test("hashing rejects a name replaced after open without reading the stale descriptor", async (t) => {
  const { file } = await fixture(t);
  const originalOpen = fs.open;
  let swapped = false;
  let readCalls = () => 0;
  const hooked = t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    if (args[0] === file) {
      await rename(file, `${file}.old`);
      await writeFile(file, "new uncommitted contents\n");
      swapped = true;
      const reader = t.mock.method(handle, "createReadStream");
      readCalls = () => reader.mock.callCount();
    }
    return handle;
  });
  syncBuiltinESMExports();
  t.after(() => { hooked.mock.restore(); syncBuiltinESMExports(); });
  assert.equal(await gitFileState(file), "dirty");
  assert.equal(swapped, true);
  assert.equal(readCalls(), 0, "do not hash a descriptor that no longer belongs to the pathname");
  assert.equal(await readFile(file, "utf8"), "new uncommitted contents\n");
});

test("hashing rejects a symlink even when open-time no-follow protection is unavailable", async (t) => {
  const { base, file } = await fixture(t);
  const outside = path.join(base, "outside.txt");
  await writeFile(outside, ORIGINAL); // A content-only check would incorrectly report clean.
  const originalOpen = fs.open;
  let swapped = false;
  let readCalls = () => 0;
  const hooked = t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    if (args[0] === file) {
      await rm(file);
      await symlink(outside, file);
      swapped = true;
      // Simulate a platform without O_NOFOLLOW while retaining the actual
      // descriptor and lstat results for the replacement link.
      const flags = Number(args[1]) & ~(constants.O_NOFOLLOW ?? 0);
      const handle = await originalOpen(file, flags);
      const reader = t.mock.method(handle, "createReadStream");
      readCalls = () => reader.mock.callCount();
      return handle;
    }
    return originalOpen(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { hooked.mock.restore(); syncBuiltinESMExports(); });
  assert.equal(await gitFileState(file), "dirty");
  assert.equal(swapped, true);
  assert.equal(readCalls(), 0, "do not read a symlink referent even if its contents match HEAD");
});

test("hashing rejects a file changed after the stream finishes", async (t) => {
  const { file } = await fixture(t);
  const originalOpen = fs.open;
  let changed = false;
  const hooked = t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    if (args[0] === file) {
      const originalStream = handle.createReadStream.bind(handle);
      t.mock.method(handle, "createReadStream", (...options: Parameters<typeof handle.createReadStream>) => {
        const stream = originalStream(...options);
        stream.once("end", () => {
          writeFileSync(file, "newer work after hashing\n");
          changed = true;
        });
        return stream;
      });
    }
    return handle;
  });
  syncBuiltinESMExports();
  t.after(() => { hooked.mock.restore(); syncBuiltinESMExports(); });
  assert.equal(await gitFileState(file), "dirty");
  assert.equal(changed, true);
  assert.equal(await readFile(file, "utf8"), "newer work after hashing\n");
});
