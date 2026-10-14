// Filesystem guards for /write and /diff. Pure response validation is in write.ts.
// These checks detect replacements; portable Node path APIs are not an atomic
// compare-and-swap or a sandbox against hostile concurrent parent-directory swaps.

import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, realpath, rename, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";

import { terminalField } from "./terminal.ts";
import { checkWriteTargetPath } from "./write.ts";

export class WriteSafetyError extends Error {}

export interface WriteSnapshot {
  readonly target: string;
  readonly absolute: string;
  readonly canonical: string;
  readonly info: Stats;
  readonly parents: readonly { path: string; info: Stats }[];
}

function refuse(target: string, detail: string): never {
  throw new WriteSafetyError(`refusing to write ${terminalField(target)}: ${detail}`);
}

function sameIdentity(before: Stats, after: Stats): boolean {
  return before.dev === after.dev && before.ino === after.ino;
}

function sameVersion(before: Stats, after: Stats): boolean {
  return sameIdentity(before, after) && before.size === after.size &&
    before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs &&
    before.mode === after.mode && before.uid === after.uid && before.gid === after.gid;
}

function isInside(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Snapshot a regular target, rejecting links below the shared cwd/path anchor. */
export async function inspectWriteTarget(target: string, cwd = process.cwd()): Promise<WriteSnapshot> {
  const root = path.resolve(cwd);
  const absolute = path.resolve(root, target);
  const info = await lstat(absolute).catch(() => null);
  const problems = checkWriteTargetPath({
    target, exists: info !== null, isFile: info?.isFile() ?? false,
    isSymlink: info?.isSymbolicLink() ?? false,
  });
  if (problems.length > 0) {
    throw new WriteSafetyError(`cannot write:\n${problems.map((line) => `  - ${terminalField(line)}`).join("\n")}`);
  }
  if (info === null) refuse(target, "the target could not be inspected");

  // Permit cwd itself (and shared ambient ancestors such as macOS /tmp) to be
  // reached via a link. Links on the target's own branch are not permitted.
  let anchor = root;
  while (!isInside(anchor, absolute)) {
    const parent = path.dirname(anchor);
    if (parent === anchor) { anchor = path.parse(absolute).root; break; }
    anchor = parent;
  }
  const realAnchor = await realpath(anchor);
  const canonical = await realpath(absolute);
  if (canonical !== path.resolve(realAnchor, path.relative(anchor, absolute))) {
    refuse(target, "a parent directory is a symbolic link; name the real path instead");
  }

  const parents: { path: string; info: Stats }[] = [];
  for (let dir = path.dirname(canonical);;) {
    const parentInfo = await lstat(dir);
    if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) {
      refuse(target, "a parent directory changed or is a symbolic link");
    }
    parents.push({ path: dir, info: parentInfo });
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const snapshot = { target, absolute, canonical, info, parents };
  await checkPaths(snapshot);
  return snapshot;
}

async function checkParents(snapshot: WriteSnapshot): Promise<void> {
  for (const parent of snapshot.parents) {
    const info = await lstat(parent.path).catch(() => null);
    if (!info?.isDirectory() || info.isSymbolicLink() || !sameIdentity(parent.info, info)) {
      refuse(snapshot.target, "a parent directory changed since the target was inspected; retry the request");
    }
  }
}

async function checkPaths(snapshot: WriteSnapshot): Promise<void> {
  await checkParents(snapshot);
  const info = await lstat(snapshot.absolute).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink() || !sameVersion(snapshot.info, info) ||
      (await realpath(snapshot.absolute).catch(() => null)) !== snapshot.canonical ||
      (await realpath(snapshot.canonical).catch(() => null)) !== snapshot.canonical) {
    refuse(snapshot.target, "the target changed since it was inspected; retry the request");
  }
}

/** Check the exact bytes sent to the model, including after a forced write request. */
export async function assertWriteTargetUnchanged(
  snapshot: WriteSnapshot, original: string, writable = false,
): Promise<void> {
  await checkPaths(snapshot);
  const handle = await open(snapshot.canonical,
    (writable ? constants.O_RDWR : constants.O_RDONLY) |
      (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  ).catch(() => null);
  if (handle === null) refuse(snapshot.target, "the target cannot be safely opened");
  try {
    const info = await handle.stat();
    if (!info.isFile() || !sameVersion(snapshot.info, info)) {
      refuse(snapshot.target, "the target changed before it could be opened; retry the request");
    }
    await checkPaths(snapshot);
    const bytes = await handle.readFile();
    if (!bytes.equals(Buffer.from(original, "utf8")) || !sameVersion(snapshot.info, await handle.stat())) {
      refuse(snapshot.target, "the current contents no longer match the context sent to the model; retry the request");
    }
    await checkPaths(snapshot);
  } finally {
    await handle.close();
  }
}

/**
 * Stage beside the target, then replace its directory entry with rename(). A
 * final-component link appearing after validation is replaced, never followed.
 * No failure while writing the staged file can truncate the original target.
 */
export async function replaceWriteTarget(
  snapshot: WriteSnapshot, original: string, proposed: string,
): Promise<void> {
  await assertWriteTargetUnchanged(snapshot, original, true);
  const temporary = path.join(path.dirname(snapshot.canonical), `.ask-write-${randomUUID()}.tmp`);
  let handle: FileHandle | null = null;
  let created: Stats | null = null;
  try {
    handle = await open(temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    created = await handle.stat();
    await checkParents(snapshot);
    if ((await realpath(temporary)) !== temporary) refuse(snapshot.target, "the staging directory changed");
    await handle.writeFile(proposed);
    if (created.uid !== snapshot.info.uid || created.gid !== snapshot.info.gid) {
      await handle.chown(snapshot.info.uid, snapshot.info.gid);
    }
    // Preserve ordinary/executable permissions, without reintroducing set-ID bits.
    await handle.chmod(snapshot.info.mode & 0o777);
    await handle.sync();
    await handle.close();
    handle = null;

    await assertWriteTargetUnchanged(snapshot, original, true);
    const staged = await lstat(temporary);
    if (!staged.isFile() || !sameIdentity(created, staged) || (await realpath(temporary)) !== temporary) {
      refuse(snapshot.target, "the staged file changed before replacement");
    }
    await rename(temporary, snapshot.canonical);
  } finally {
    await handle?.close();
    // Remove only the file we created, not a replacement planted at that name.
    const remaining = await lstat(temporary).catch(() => null);
    if (created && remaining?.isFile() && sameIdentity(created, remaining) &&
        (await realpath(temporary).catch(() => null)) === temporary) {
      await unlink(temporary);
    }
  }
}
