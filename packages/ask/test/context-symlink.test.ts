import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs, { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";

import { collectContext, renderPrompt } from "../src/context.ts";

const git = promisify(execFile);
const OUTSIDE = "outside-private-marker\n";
const SECRET = "inside-secret-marker\n";

async function fixture(t: TestContext) {
  const base = await fs.realpath(await mkdtemp(path.join(tmpdir(), "ask-context-links-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const cwd = path.join(base, "repo");
  const outside = path.join(base, "repo-other");
  await mkdir(path.join(cwd, "src"), { recursive: true });
  await mkdir(outside);
  await writeFile(path.join(cwd, "src", "safe.ts"), "export const safe = true;\n");
  await writeFile(path.join(cwd, ".env"), SECRET);
  await writeFile(path.join(outside, "notes.ts"), OUTSIDE);
  return { base, cwd, outside };
}

test("exact, Git search and glob refs cannot attach an outside symlink target", async (t) => {
  const { cwd, outside } = await fixture(t);
  const alias = path.join(cwd, "src", "alias.ts");
  await symlink(path.join(outside, "notes.ts"), alias);
  await git("git", ["-C", cwd, "init", "-q"]);
  await git("git", ["-C", cwd, "add", "--", "src/alias.ts"]);
  for (const includeSecrets of [false, true]) {
    for (const ref of ["src/alias.ts", "alias", "src/*.ts"]) {
      const result = await collectContext([ref], { cwd, includeSecrets });
      assert.ok(result.skipped.some((entry) => entry.path === "src/alias.ts" && entry.reason === "symlink-outside-tree"), ref);
      assert.doesNotMatch(renderPrompt("review", result), /outside-private-marker/);
      assert.ok(result.blocks.every((block) => block.path !== "src/alias.ts"));
    }
  }
});

test("directory aliases and symlinked parent components are checked before walking", async (t) => {
  const { cwd, outside } = await fixture(t);
  await symlink(outside, path.join(cwd, "docs"), "junction");
  await symlink(path.join(cwd, "docs"), path.join(cwd, "docs-chain"), "junction");
  for (const ref of ["docs", "docs-chain", "docs/notes.ts"]) {
    for (const includeSecrets of [false, true]) {
      const result = await collectContext([ref], { cwd, includeSecrets });
      assert.deepEqual(result.blocks, []);
      assert.deepEqual(result.directories, [], "an outside directory must not be expanded");
      assert.deepEqual(result.skipped, [{ path: ref, reason: "symlink-outside-tree" }]);
    }
  }
});

test("internal symlinks retain their names, and both alias and real secret names are filtered", async (t) => {
  const { cwd } = await fixture(t);
  await symlink(path.join(cwd, "src", "safe.ts"), path.join(cwd, "src", "alias.ts"));
  await symlink(path.join(cwd, ".env"), path.join(cwd, "src", "config.ts"));
  await symlink(path.join(cwd, "src", "safe.ts"), path.join(cwd, "src", "private.key"));
  const refs = ["src/alias.ts", "src/config.ts", "src/private.key"];
  const guarded = await collectContext(refs, { cwd });
  assert.deepEqual(guarded.blocks.map((block) => block.path), ["src/alias.ts"]);
  assert.equal(guarded.blocks[0]?.text, "export const safe = true;\n");
  assert.deepEqual(guarded.skipped, [
    { path: "src/config.ts", reason: "looks-like-secret" },
    { path: "src/private.key", reason: "looks-like-secret" },
  ]);
  assert.doesNotMatch(renderPrompt("review", guarded), /inside-secret-marker/);
  const allowed = await collectContext(refs, { cwd, includeSecrets: true });
  assert.deepEqual(allowed.blocks.map((block) => block.path), refs);
  assert.equal(allowed.blocks[1]?.text, SECRET);

  await git("git", ["-C", cwd, "init", "-q"]);
  await git("git", ["-C", cwd, "add", "--", "src/config.ts"]);
  for (const ref of ["config", "src/*.ts"]) {
    const result = await collectContext([ref], { cwd });
    assert.ok(result.skipped.some((entry) => entry.path === "src/config.ts" && entry.reason === "looks-like-secret"));
    assert.doesNotMatch(renderPrompt("review", result), /inside-secret-marker/);
  }
});

test("internal directory aliases filter canonical secret paths and keep nested links skipped", async (t) => {
  const { cwd, outside } = await fixture(t);
  await mkdir(path.join(cwd, "..notes"));
  await writeFile(path.join(cwd, "..notes", "normal.ts"), "notes\n");
  await writeFile(path.join(cwd, "..notes", ".env"), SECRET);
  await symlink(outside, path.join(cwd, "..notes", "external-dir"), "junction");
  await symlink(path.join(outside, "notes.ts"), path.join(cwd, "..notes", "external.ts"));
  await symlink(path.join(cwd, "..notes"), path.join(cwd, "notes"), "junction");
  const result = await collectContext(["notes"], { cwd });
  assert.deepEqual(result.blocks.map((block) => block.path), ["notes/normal.ts"]);
  assert.ok(result.skipped.some((entry) => entry.path === "notes/.env" && entry.reason === "looks-like-secret"));
  assert.doesNotMatch(renderPrompt("review", result), /inside-secret-marker|outside-private-marker/);
  assert.deepEqual((await collectContext(["..notes/normal.ts"], { cwd })).blocks.map((block) => block.path), ["..notes/normal.ts"]);

  // A benign alias must not turn a secret-named directory into an allowed walk.
  await mkdir(path.join(cwd, ".env.d"));
  await writeFile(path.join(cwd, ".env.d", "config.ts"), SECRET);
  await symlink(path.join(cwd, ".env.d"), path.join(cwd, "settings"), "junction");
  const hidden = await collectContext(["settings"], { cwd });
  assert.deepEqual(hidden.blocks, []);
  assert.deepEqual(hidden.skipped, [{ path: "settings", reason: "looks-like-secret" }]);
});

test("direct outside files and directories remain explicit choices, but nested aliases do not", async (t) => {
  const { base, cwd, outside } = await fixture(t);
  const further = path.join(base, "another.ts");
  await writeFile(further, "further-private-marker\n");
  await symlink(further, path.join(outside, "alias.ts"));
  for (const ref of ["../repo-other/notes.ts", path.join(outside, "notes.ts"), "../repo-other"]) {
    const result = await collectContext([ref], { cwd });
    assert.equal(result.blocks.length, 1, ref);
    assert.equal(result.blocks[0]?.text, OUTSIDE);
    assert.equal(result.blocks[0]?.path, "../repo-other/notes.ts");
  }
  const aliased = await collectContext(["../repo-other/alias.ts"], { cwd });
  assert.deepEqual(aliased.blocks, []);
  assert.equal(aliased.skipped[0]?.reason, "symlink-outside-tree");
});

test("a symlinked cwd supports inside refs and explicitly named outside siblings", async (t) => {
  const { base, cwd } = await fixture(t);
  const alias = path.join(base, "working");
  await symlink(cwd, alias, "junction");
  const result = await collectContext(["src/safe.ts", "../repo-other/notes.ts"], { cwd: alias });
  assert.deepEqual(result.blocks.map((block) => block.path), ["src/safe.ts", "../repo-other/notes.ts"]);
  assert.deepEqual(result.skipped, []);
});

test("canonicalisation failures never fall back to reading the lexical path", async (t) => {
  const { cwd } = await fixture(t);
  await symlink(path.join(cwd, "missing"), path.join(cwd, "src", "broken.ts"));
  await symlink("loop.ts", path.join(cwd, "src", "loop.ts"));
  await git("git", ["-C", cwd, "init", "-q"]);
  await git("git", ["-C", cwd, "add", "--", "src/broken.ts", "src/loop.ts"]);
  const result = await collectContext(["src/*.ts"], { cwd });
  assert.deepEqual(result.blocks.map((block) => block.path), ["src/safe.ts"]);
  assert.deepEqual(result.skipped.map((entry) => entry.reason), ["unresolvable-path", "unresolvable-path"]);
  await assert.rejects(collectContext(["src/safe.ts"], { cwd: path.join(cwd, "absent") }), /ENOENT/);
});

test("a canonical file replaced with an outside symlink before open is not read", async (t) => {
  const { cwd, outside } = await fixture(t);
  const file = path.join(cwd, "src", "safe.ts");
  const originalOpen = fs.open;
  let swapped = false;
  const hooked = t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    if (args[0] === file && !swapped) {
      swapped = true;
      await rm(file);
      await symlink(path.join(outside, "notes.ts"), file);
    }
    return originalOpen(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { hooked.mock.restore(); syncBuiltinESMExports(); });
  const result = await collectContext(["src/safe.ts"], { cwd });
  assert.equal(swapped, true);
  assert.deepEqual(result.blocks, []);
  assert.equal(result.skipped.length, 1);
  assert.equal(await readFile(path.join(outside, "notes.ts"), "utf8"), OUTSIDE);
});

test("a parent swapped to an outside directory before open fails the handle identity check", async (t) => {
  const { cwd, outside } = await fixture(t);
  const file = path.join(cwd, "src", "safe.ts");
  await writeFile(path.join(outside, "safe.ts"), OUTSIDE);
  const originalOpen = fs.open;
  let swapped = false;
  let readCalls = () => 0;
  const hooked = t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    if (args[0] === file && !swapped) {
      swapped = true;
      await rename(path.join(cwd, "src"), path.join(cwd, "original-src"));
      await symlink(outside, path.join(cwd, "src"), "junction");
      const handle = await originalOpen(...args);
      const reader = t.mock.method(handle, "readFile");
      readCalls = () => reader.mock.callCount();
      return handle;
    }
    return originalOpen(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { hooked.mock.restore(); syncBuiltinESMExports(); });
  const result = await collectContext(["src/safe.ts"], { cwd });
  assert.equal(swapped, true);
  assert.equal(readCalls(), 0, "do not consume data from a substituted file handle");
  assert.deepEqual(result.blocks, []);
  assert.deepEqual(result.skipped, [{ path: "src/safe.ts", reason: "path-changed" }]);
});
