import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { collectContext } from "@codehaus-au/ask/internal/context";
import {
  applyUpdates, captureEditableFiles, parseUpdates, parseUpdateRegions, prepareUpdates, sensitivePathReason, updateDiff, updateSummary,
  type EditableFile,
} from "../src/updates.ts";

export function update(target: string, search: string, replacement: string): string {
  return `<update path=${JSON.stringify(target)}>\n<<<<<<< SEARCH\n${search}\n=======\n${replacement}\n>>>>>>> REPLACE\n</update>`;
}

test("update parser accepts prose and multiple blocks, preserves exact whitespace", () => {
  assert.deepEqual(parseUpdates(`Explanation.\n${update("a.ts", "  old\nline", "  new\nline")}\n${update("a.ts", "other", "")}`), [
    { path: "a.ts", search: "  old\nline", replacement: "  new\nline" },
    { path: "a.ts", search: "other", replacement: "" },
  ]);
  assert.deepEqual(parseUpdates("An ordinary answer."), []);
  assert.deepEqual(parseUpdates(`\`\`\`text\n${update("a", "old", "new")}\n\`\`\``), []);
  assert.deepEqual(parseUpdates(`~~~~\n${update("a", "old", "new")}\n~~~~`), []);
});

test("malformed, nested, empty and incomplete proposals fail closed", () => {
  for (const text of [
    '<update path="a">', update("a", "", "new"),
    update("a", "old", "new").replace("=======", "------"),
    update("a", "old", "new").replace("</update>", ""),
    update("a", "old", "<update path=\"b\">"),
    '</update>', '<update path="a" extra="yes">',
    update("a\nforged", "old", "new"),
    update("a", "old", "\ud800"),
  ]) assert.throws(() => parseUpdates(text), Error, text);
});

test("display regions use the protocol parser, preserve order and ignore fenced examples", () => {
  const first = update("a.ts", "old", "new");
  const second = update("b.ts", "remove", "");
  const text = `Before\n\n\`\`\`text\n${first}\n\`\`\`\n\n${first}\nBetween\n${second}\nAfter`;
  for (const source of [text, text.replace(/\n/g, "\r\n")]) {
    const lines = source.replace(/\r\n/g, "\n").split("\n");
    const regions = parseUpdateRegions(source);
    assert.deepEqual(regions.map((region) => lines.slice(region.startLine, region.endLine).join("\n")), [first, second]);
    assert.deepEqual(regions.map((region) => region.block), parseUpdates(source));
    assert.equal(lines[regions[0]!.endLine], "Between");
    assert.equal(lines[regions[1]!.endLine], "After");
  }
  assert.throws(() => parseUpdateRegions(`${text}\n<update path="incomplete">`), /missing SEARCH/);
});

test("diff previews make final-newline changes explicit", () => {
  assert.match(updateDiff({ path: "a.ts", original: "one", proposed: "one\n" }), /-one\n\\ No newline at end of file\n\+one$/);
  assert.match(updateDiff({ path: "a.ts", original: "one\n", proposed: "" }), /@@ -1,1 \+0,0 @@\n-one$/);
});

test("updates validate all original matches and do not cascade", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "ask-updates-"));
  try {
    await writeFile(path.join(cwd, "a.ts"), "one\ntwo\nthree\n");
    const files = await captureEditableFiles((await collectContext(["a.ts"], { cwd })).blocks, cwd);
    const edits = prepareUpdates(parseUpdates(update("a.ts", "one", "ONE") + "\n" + update("a.ts", "three", "THREE")), files);
    assert.equal(edits[0]?.proposed, "ONE\ntwo\nTHREE\n");
    // Unchanged lines between edits are context, not removed and re-added.
    assert.match(updateDiff(edits[0]!), /@@ -1,3 \+1,3 @@\n-one\n\+ONE\n two\n-three\n\+THREE$/);
    assert.throws(() => prepareUpdates(parseUpdates(update("a.ts", "ONE", "next")), files), /exactly once/);
    assert.throws(() => prepareUpdates(parseUpdates(update("a.ts", "one\ntwo", "x") + "\n" + update("a.ts", "two", "y")), files), /Overlapping/);
    assert.throws(() => prepareUpdates(parseUpdates(update("other.ts", "one", "x")), files), /not an editable/);
    assert.throws(() => prepareUpdates(parseUpdates(update("./a.ts", "one", "x")), files), /not an editable/);
    assert.equal(await readFile(path.join(cwd, "a.ts"), "utf8"), "one\ntwo\nthree\n");
    await applyUpdates(edits);
    assert.equal(await readFile(path.join(cwd, "a.ts"), "utf8"), "ONE\ntwo\nTHREE\n");
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("non-unique and overlapping substring occurrences are rejected", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "ask-updates-"));
  try {
    await writeFile(path.join(cwd, "a.ts"), "aaa");
    const files = await captureEditableFiles((await collectContext(["a.ts"], { cwd })).blocks, cwd);
    assert.throws(() => prepareUpdates(parseUpdates(update("a.ts", "aa", "b")), files), /exactly once/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("truncated files, symlinks, invalid UTF-8 and outside-tree paths are read-only", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "ask-updates-"));
  const outside = await mkdtemp(path.join(tmpdir(), "ask-outside-"));
  try {
    await writeFile(path.join(cwd, "a.ts"), "original\n");
    await writeFile(path.join(cwd, "bad.ts"), Buffer.from([0xff, 0xfe]));
    await symlink("a.ts", path.join(cwd, "link.ts"));
    await writeFile(path.join(outside, "b.ts"), "outside");
    const context = await collectContext(["a.ts", "bad.ts", "link.ts", path.join(outside, "b.ts")], { cwd });
    const files = await captureEditableFiles(context.blocks.map((block) => block.path === "a.ts" ? { ...block, truncated: true } : block), cwd);
    assert.equal(files.size, 0);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("stale multi-file proposal is refused before any file is written", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "ask-updates-"));
  try {
    await writeFile(path.join(cwd, "a.ts"), "original\n");
    await writeFile(path.join(cwd, "b.ts"), "original\n");
    const files = await captureEditableFiles((await collectContext(["a.ts", "b.ts"], { cwd })).blocks, cwd);
    const edits = prepareUpdates(parseUpdates(update("a.ts", "original", "changed") + "\n" + update("b.ts", "original", "changed")), files);
    await writeFile(path.join(cwd, "b.ts"), "user work\n");
    await assert.rejects(applyUpdates(edits), /changed/);
    assert.equal(await readFile(path.join(cwd, "a.ts"), "utf8"), "original\n");
    assert.equal(await readFile(path.join(cwd, "b.ts"), "utf8"), "user work\n");
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

/** In-memory files: prepareUpdates and the diff never touch the filesystem. */
function memoryFile(original: string): Map<string, EditableFile> {
  return new Map([["a.ts", { original, snapshot: {} as EditableFile["snapshot"] }]]);
}

test("distant edits get separate hunks, so unchanged lines cannot hide a change", () => {
  const original = Array.from({ length: 40 }, (_, i) => `line ${i};\n`).join("");
  const [proposal] = prepareUpdates(parseUpdates(update("a.ts", "line 2;", "LINE 2;") + "\n" + update("a.ts", "line 30;", "LINE 30;")), memoryFile(original));
  const diff = updateDiff(proposal!);
  assert.equal(diff.match(/^@@ /gm)?.length, 2);
  assert.match(diff, /@@ -1,6 \+1,6 @@\n line 0;\n line 1;\n-line 2;\n\+LINE 2;\n line 3;\n line 4;\n line 5;\n@@ -28,7 \+28,7 @@/);
  assert.equal(diff.split("\n").filter((line) => /^[-+](?!--|\+\+)/.test(line)).length, 4, "only the two edited lines change");
  assert.deepEqual(updateSummary(proposal!), { path: "a.ts", added: 2, removed: 2, sensitive: null });
});

test("nearby edits share a hunk with the unchanged lines between them as context", () => {
  const original = "a\nb\nc\nd\ne\n";
  const [proposal] = prepareUpdates(parseUpdates(update("a.ts", "a", "A") + "\n" + update("a.ts", "e", "E")), memoryFile(original));
  assert.equal(updateDiff(proposal!), '--- "a.ts"\n+++ "a.ts"\n@@ -1,5 +1,5 @@\n-a\n+A\n b\n c\n d\n-e\n+E');
});

test("a replacement that removes a line break shows the joined line", () => {
  const [proposal] = prepareUpdates(parseUpdates(update("a.ts", "one\n", "one ")), memoryFile("one\ntwo\nthree\n"));
  assert.equal(proposal!.proposed, "one two\nthree\n");
  assert.match(updateDiff(proposal!), /@@ -1,3 \+1,2 @@\n-one\n-two\n\+one two\n three$/);
});

test("CRLF files take LF proposals and keep CRLF; CRLF responses parse", () => {
  const original = "one\r\ntwo\r\nthree\r\n";
  const response = update("a.ts", "one\ntwo", "ONE\nTWO").replace(/\n/g, "\r\n");
  const [proposal] = prepareUpdates(parseUpdates(response), memoryFile(original));
  assert.equal(proposal!.proposed, "ONE\r\nTWO\r\nthree\r\n");
  // Mixed line endings are not rewritten: the LF search no longer matches exactly once.
  assert.throws(() => prepareUpdates(parseUpdates(update("a.ts", "one\ntwo", "x")), memoryFile("one\r\ntwo\nthree\n")), /exactly once/);
});

test("paths that run code or change automation are flagged for review", () => {
  for (const [file, reason] of [
    [".github/workflows/ci.yml", /CI/], [".gitlab-ci.yml", /CI/], ["package.json", /scripts/],
    ["packages/web/package.json", /scripts/], ["Makefile", /build/], ["Dockerfile.dev", /container/],
    [".husky/pre-commit", /hooks/], ["scripts/release.sh", /script/], [".envrc", /dotfile/], ["config/.npmrc", /dotfile/],
  ] as const) assert.match(sensitivePathReason(file) ?? "", reason, file);
  for (const file of ["src/index.ts", "README.md", "src/package.ts", "docs/makefile-notes.md"]) {
    assert.equal(sensitivePathReason(file), null, file);
  }
});
