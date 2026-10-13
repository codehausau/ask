import assert from "node:assert/strict";
import { constants } from "node:fs";
import fs, { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { assertWriteTargetUnchanged, inspectWriteTarget, replaceWriteTarget } from "../src/safe-write.ts";

const ORIGINAL = "export const value = 1;\n";
const PROPOSED = "export const value = 2;\n";

async function fixture(t: TestContext) {
  const base = await fs.realpath(await mkdtemp(path.join(tmpdir(), "ask-safe-write-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const cwd = path.join(base, "repo");
  await mkdir(path.join(cwd, "src"), { recursive: true });
  const file = path.join(cwd, "src", "widget.ts");
  const outside = path.join(base, "outside.ts");
  await writeFile(file, ORIGINAL);
  await writeFile(outside, "outside must survive\n");
  return { base, cwd, file, outside };
}

test("write snapshots reject file links, dangling links and internal/external parent aliases", async (t) => {
  const { cwd, file, outside } = await fixture(t);
  await symlink(file, path.join(cwd, "alias.ts"));
  await symlink(outside, path.join(cwd, "external.ts"));
  await symlink(path.join(cwd, "missing.ts"), path.join(cwd, "dangling.ts"));
  await symlink(path.dirname(file), path.join(cwd, "src-link"), "junction");
  await symlink(path.dirname(outside), path.join(cwd, "external-dir"), "junction");
  for (const target of ["alias.ts", "external.ts", "dangling.ts", "src-link/widget.ts", "external-dir/outside.ts"]) {
    await assert.rejects(inspectWriteTarget(target, cwd), /symbolic link/, target);
  }
});

test("a symlinked cwd and directly named outside regular files remain usable", async (t) => {
  const { base, cwd, outside } = await fixture(t);
  const alias = path.join(base, "cwd-link");
  await symlink(cwd, alias, "junction");
  const snapshot = await inspectWriteTarget("src/widget.ts", alias);
  await replaceWriteTarget(snapshot, ORIGINAL, PROPOSED);
  assert.equal(await readFile(snapshot.canonical, "utf8"), PROPOSED);
  const external = await inspectWriteTarget("../outside.ts", alias);
  await replaceWriteTarget(external, "outside must survive\n", "explicit outside edit\n");
  assert.equal(await readFile(outside, "utf8"), "explicit outside edit\n");
});

test("staging preserves executable permissions and does not modify hard-linked aliases", async (t) => {
  const { cwd, file, outside } = await fixture(t);
  await chmod(file, 0o755);
  await rm(outside);
  await link(file, outside);
  const snapshot = await inspectWriteTarget("src/widget.ts", cwd);
  await replaceWriteTarget(snapshot, ORIGINAL, PROPOSED);
  assert.equal(await readFile(file, "utf8"), PROPOSED);
  assert.equal(await readFile(outside, "utf8"), ORIGINAL);
  const info = await lstat(file);
  assert.equal(info.mode & 0o777, 0o755);
  assert.equal(info.uid, snapshot.info.uid);
  assert.equal(info.gid, snapshot.info.gid);
  assert.deepEqual(await readdir(path.dirname(file)), ["widget.ts"]);
});

test("changed contents and same-byte regular-file replacements are refused", async (t) => {
  const { cwd, file } = await fixture(t);
  const snapshot = await inspectWriteTarget("src/widget.ts", cwd);
  await rename(file, `${file}.saved`);
  await writeFile(file, ORIGINAL);
  await assert.rejects(replaceWriteTarget(snapshot, ORIGINAL, PROPOSED), /target changed/);
  assert.equal(await readFile(file, "utf8"), ORIGINAL);
  const current = await inspectWriteTarget("src/widget.ts", cwd);
  await writeFile(file, "newer local contents\n");
  await assert.rejects(replaceWriteTarget(current, ORIGINAL, PROPOSED), /target changed|no longer match/);
  assert.equal(await readFile(file, "utf8"), "newer local contents\n");
});

test("context must match exact bytes rather than a lossy UTF-8 decoding", async (t) => {
  const { cwd, file } = await fixture(t);
  await writeFile(file, Buffer.from([0xff, 0x61, 0x0a]));
  const snapshot = await inspectWriteTarget("src/widget.ts", cwd);
  await assert.rejects(assertWriteTargetUnchanged(snapshot, "\ufffda\n"), /no longer match the context/);
  assert.deepEqual(await readFile(file), Buffer.from([0xff, 0x61, 0x0a]));
});

test("staging write failure leaves the original intact and removes the temporary file", async (t) => {
  const { cwd, file } = await fixture(t);
  const snapshot = await inspectWriteTarget("src/widget.ts", cwd);
  const originalOpen = fs.open;
  let staged = false;
  const hooked = t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    assert.equal(Number(args[1]) & constants.O_TRUNC, 0, "never truncate on open");
    if (String(args[0]).includes(".ask-write-")) {
      staged = true;
      t.mock.method(handle, "writeFile", async () => { throw new Error("simulated staging failure"); });
    }
    return handle;
  });
  syncBuiltinESMExports();
  t.after(() => { hooked.mock.restore(); syncBuiltinESMExports(); });
  await assert.rejects(replaceWriteTarget(snapshot, ORIGINAL, PROPOSED), /simulated staging failure/);
  assert.equal(staged, true);
  assert.equal(await readFile(file, "utf8"), ORIGINAL);
  assert.deepEqual(await readdir(path.dirname(file)), ["widget.ts"]);
});

test("a link planted in the final rename gap is replaced rather than followed", async (t) => {
  const { cwd, file, outside } = await fixture(t);
  const snapshot = await inspectWriteTarget("src/widget.ts", cwd);
  const originalRename = fs.rename;
  let swapped = false;
  const hooked = t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
    if (args[1] === file) {
      swapped = true;
      await rm(file);
      await symlink(outside, file);
    }
    return originalRename(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { hooked.mock.restore(); syncBuiltinESMExports(); });
  await replaceWriteTarget(snapshot, ORIGINAL, PROPOSED);
  assert.equal(swapped, true);
  assert.equal((await lstat(file)).isSymbolicLink(), false);
  assert.equal(await readFile(file, "utf8"), PROPOSED);
  assert.equal(await readFile(outside, "utf8"), "outside must survive\n");
  assert.deepEqual(await readdir(path.dirname(file)), ["widget.ts"]);
});

test("a changed parent directory is refused before creating a staged file", async (t) => {
  const { base, cwd, file } = await fixture(t);
  const snapshot = await inspectWriteTarget("src/widget.ts", cwd);
  const outsideDir = path.join(base, "other-dir");
  await mkdir(outsideDir);
  await writeFile(path.join(outsideDir, "widget.ts"), "outside contents\n");
  await rename(path.dirname(file), path.join(cwd, "original-src"));
  await symlink(outsideDir, path.dirname(file), "junction");
  await assert.rejects(replaceWriteTarget(snapshot, ORIGINAL, PROPOSED), /parent directory changed/);
  assert.equal(await readFile(path.join(outsideDir, "widget.ts"), "utf8"), "outside contents\n");
  assert.deepEqual(await readdir(outsideDir), ["widget.ts"]);
});
