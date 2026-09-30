import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

import { collectContext } from "../src/context.ts";
import {
  globToRegExp,
  hasGlobMagic,
  rankMatch,
  RefResolutionError,
  repairSpacedRefs,
  resolveRef,
} from "../src/refs.ts";

/**
 *   src/chat.ts          src/deep/nested/chat-helper.ts
 *   src/context.ts       test/chat.test.ts
 *   src/cli.ts           notes.md
 *   node_modules/junk/chat.ts   (never searched)
 */
async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "ask-refs-"));
  await mkdir(path.join(root, "src", "deep", "nested"), { recursive: true });
  await mkdir(path.join(root, "test"));
  await mkdir(path.join(root, "node_modules", "junk"), { recursive: true });

  await writeFile(path.join(root, "src", "chat.ts"), "export const chat = 1;\n");
  await writeFile(path.join(root, "src", "context.ts"), "export const context = 1;\n");
  await writeFile(path.join(root, "src", "cli.ts"), "export const cli = 1;\n");
  await writeFile(path.join(root, "src", "deep", "nested", "chat-helper.ts"), "helper\n");
  await writeFile(path.join(root, "test", "chat.test.ts"), "test\n");
  await writeFile(path.join(root, "notes.md"), "notes\n");
  await writeFile(path.join(root, "node_modules", "junk", "chat.ts"), "junk\n");
  return root;
}

test("hasGlobMagic spots the patterns it should", () => {
  assert.equal(hasGlobMagic("src/*.ts"), true);
  assert.equal(hasGlobMagic("src/**/*.ts"), true);
  assert.equal(hasGlobMagic("file?.ts"), true);
  assert.equal(hasGlobMagic("src/[ab].ts"), true);
  assert.equal(hasGlobMagic("src/chat.ts"), false);
  assert.equal(hasGlobMagic("chat"), false);
});

test("globToRegExp: * stays within a path segment, ** crosses", () => {
  assert.match("src/chat.ts", globToRegExp("src/*.ts"));
  assert.doesNotMatch("src/deep/chat.ts", globToRegExp("src/*.ts"));
  assert.match("src/deep/nested/chat.ts", globToRegExp("src/**/*.ts"));
  assert.match("chat.ts", globToRegExp("**/chat.ts"), "**/ also matches top level");
  assert.match("a.ts", globToRegExp("?.ts"));
  assert.doesNotMatch("ab.ts", globToRegExp("?.ts"));
  assert.match("b.ts", globToRegExp("[ab].ts"));
  assert.doesNotMatch("c.ts", globToRegExp("[ab].ts"));
  assert.doesNotMatch("c.ts", globToRegExp("[!c].ts"));
  assert.match("a.b.ts", globToRegExp("a.b.ts"), "dots are literal");
  assert.doesNotMatch("axbxts", globToRegExp("a.b.ts"));
});

test("rankMatch prefers exact basenames over path substrings", () => {
  assert.equal(rankMatch("src/chat.ts", "chat.ts"), 0);
  assert.equal(rankMatch("src/chat.ts", "chat"), 1);
  assert.equal(rankMatch("src/chatty.ts", "chat"), 2);
  assert.equal(rankMatch("src/mychat.ts", "chat"), 3);
  assert.equal(rankMatch("src/chat/index.ts", "chat"), 4);
  assert.equal(rankMatch("src/cli.ts", "chat"), null);
  assert.equal(rankMatch("src/CHAT.ts", "chat.ts"), 0, "case-insensitive");
  assert.equal(rankMatch("src/CHAT.ts", "chat"), 1, "case-insensitive");
});

test("an existing path is used verbatim, never searched", async () => {
  const cwd = await fixture();
  const resolution = await resolveRef("src/chat.ts", { cwd });
  assert.equal(resolution.kind, "path");
  assert.deepEqual(resolution.paths, [path.join(cwd, "src", "chat.ts")]);
});

test("a directory resolves as a path too", async () => {
  const cwd = await fixture();
  const resolution = await resolveRef("src", { cwd });
  assert.equal(resolution.kind, "path");
  assert.deepEqual(resolution.paths, [path.join(cwd, "src")]);
});

test("search finds a file by bare name and picks the best rank", async () => {
  const cwd = await fixture();
  const resolution = await resolveRef("chat", { cwd });
  assert.equal(resolution.kind, "search");
  assert.deepEqual(
    resolution.paths.map((absolute) => path.relative(cwd, absolute)),
    [path.join("src", "chat.ts")],
    "src/chat.ts (basename without extension) beats chat.test.ts and chat-helper.ts",
  );
});

test("search reaches nested directories", async () => {
  const cwd = await fixture();
  const resolution = await resolveRef("chat-helper", { cwd });
  assert.deepEqual(
    resolution.paths.map((absolute) => path.relative(cwd, absolute)),
    [path.join("src", "deep", "nested", "chat-helper.ts")],
  );
});

test("search never offers a skipped directory", async () => {
  const cwd = await fixture();
  const resolution = await resolveRef("junk", { cwd }).catch((error: unknown) => error);
  assert.ok(resolution instanceof RefResolutionError, "node_modules is not searched");
});

test("an ambiguous search lists candidates instead of guessing", async () => {
  const cwd = await fixture();
  await writeFile(path.join(cwd, "src", "dup.ts"), "one\n");
  await writeFile(path.join(cwd, "test", "dup.ts"), "two\n");

  const error = await resolveRef("dup", { cwd }).catch((caught: unknown) => caught);
  assert.ok(error instanceof RefResolutionError);
  assert.match(error.message, /matches 2 paths equally well/);
  assert.deepEqual(error.candidates, ["src/dup.ts", "test/dup.ts"]);
});

test("an existing path beats an ambiguous search", async () => {
  const cwd = await fixture();
  await writeFile(path.join(cwd, "src", "notes.md"), "dup\n");

  // notes.md exists at the root, so it is used verbatim rather than searched.
  const resolution = await resolveRef("notes.md", { cwd });
  assert.equal(resolution.kind, "path");
  assert.deepEqual(resolution.paths, [path.join(cwd, "notes.md")]);
});

test("--all-matches returns every ranked match", async () => {
  const cwd = await fixture();
  const resolution = await resolveRef("chat", { cwd, allMatches: true });
  assert.deepEqual(
    resolution.paths.map((absolute) => path.relative(cwd, absolute)),
    [
      path.join("src", "chat.ts"),
      path.join("test", "chat.test.ts"),
      path.join("src", "deep", "nested", "chat-helper.ts"),
    ],
    "ranked, then shortest path first",
  );
});

test("a glob expands to every match, sorted", async () => {
  const cwd = await fixture();
  const resolution = await resolveRef("src/*.ts", { cwd });
  assert.equal(resolution.kind, "glob");
  assert.deepEqual(
    resolution.paths.map((absolute) => path.relative(cwd, absolute)),
    [path.join("src", "chat.ts"), path.join("src", "cli.ts"), path.join("src", "context.ts")],
  );
});

test("a recursive glob crosses directories but skips node_modules", async () => {
  const cwd = await fixture();
  const resolution = await resolveRef("**/*.ts", { cwd });
  const relative = resolution.paths.map((absolute) => path.relative(cwd, absolute));
  assert.equal(relative.includes(path.join("src", "deep", "nested", "chat-helper.ts")), true);
  assert.equal(
    relative.some((file) => file.includes("node_modules")),
    false,
  );
});

test("a glob matching nothing is an error", async () => {
  const cwd = await fixture();
  await assert.rejects(() => resolveRef("*.rs", { cwd }), /no file matches @\*\.rs/);
});

test("an unmatched name explains itself", async () => {
  const cwd = await fixture();
  await assert.rejects(
    () => resolveRef("nowhere", { cwd }),
    /no such path, and nothing in the tree matched @nowhere/,
  );
});

test("git enumeration respects .gitignore", async () => {
  const cwd = await fixture();
  await mkdir(path.join(cwd, "junkcache"));
  await writeFile(path.join(cwd, "junkcache", "widget.ts"), "ignored copy\n");
  await writeFile(path.join(cwd, "src", "widget.ts"), "real one\n");
  await writeFile(path.join(cwd, ".gitignore"), "junkcache/\n");
  await execFileAsync("git", ["-C", cwd, "init", "-q"]);

  // Both files rank identically, so without .gitignore this would be ambiguous.
  const resolution = await resolveRef("widget", { cwd });
  assert.deepEqual(
    resolution.paths.map((absolute) => path.relative(cwd, absolute)),
    [path.join("src", "widget.ts")],
  );

  // The filesystem fallback sees the ignored copy and reports the ambiguity.
  const error = await resolveRef("widget", { cwd, noGit: true }).catch((caught: unknown) => caught);
  assert.ok(error instanceof RefResolutionError);
  // Shortest path first, per the documented tie-break.
  assert.deepEqual(error.candidates, ["src/widget.ts", "junkcache/widget.ts"]);
});

test("a truncated listing says so instead of claiming no match", async () => {
  const cwd = await fixture();

  // maxEntries stands in for a tree too large to walk; the honest answer is
  // "I stopped looking", not "it does not exist".
  const error = await resolveRef("chat-helper", { cwd, noGit: true, maxEntries: 2 }).catch(
    (caught: unknown) => caught,
  );
  assert.ok(error instanceof RefResolutionError);
  assert.match(error.message, /search stopped after 2 entries/);

  // Same cap, but the file is found before the cap bites: no complaint.
  const found = await resolveRef("notes", { cwd, noGit: true, maxEntries: 500 });
  assert.equal(path.basename(found.paths[0] ?? ""), "notes.md");
});

test("directories are searchable under git enumeration too", async () => {
  const cwd = await fixture();
  await execFileAsync("git", ["-C", cwd, "init", "-q"]);

  const resolution = await resolveRef("nested", { cwd });
  assert.equal(resolution.kind, "search");
  assert.deepEqual(
    resolution.paths.map((absolute) => path.relative(cwd, absolute)),
    [path.join("src", "deep", "nested")],
  );
});

test("collectContext reports how each reference resolved", async () => {
  const cwd = await fixture();
  const context = await collectContext(["src/cli.ts", "chat", "src/*.ts"], { cwd });

  assert.deepEqual(
    context.resolutions.map((resolution) => [resolution.ref, resolution.kind]),
    [
      ["src/cli.ts", "path"],
      ["chat", "search"],
      ["src/*.ts", "glob"],
    ],
  );
  // Deduplicated across references.
  assert.deepEqual(
    context.blocks.map((block) => block.path),
    [path.join("src", "cli.ts"), path.join("src", "chat.ts"), path.join("src", "context.ts")],
  );
});

test("a reference split by a filename's spaces is rejoined", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "ask-spaces-"));
  await mkdir(path.join(cwd, "tender_docs"), { recursive: true });
  await writeFile(path.join(cwd, "tender_docs", "101521 Quotation.txt"), "quote\n");
  await writeFile(
    path.join(cwd, "tender_docs", "101521 RFQTS Joint Data Networks (JDN).txt"),
    "rfq\n",
  );

  // The reported case: the space ended the reference, leaving it ambiguous.
  const fixed = await repairSpacedRefs(
    ["tender_docs/101521"],
    "Quotation.txt what is this doc",
    cwd,
  );
  assert.deepEqual(fixed.refs, ["tender_docs/101521 Quotation.txt"]);
  assert.equal(fixed.question, "what is this doc");
  assert.deepEqual(fixed.repaired, ["tender_docs/101521 Quotation.txt"]);

  // Several spaces in one name.
  const longer = await repairSpacedRefs(
    ["tender_docs/101521"],
    "RFQTS Joint Data Networks (JDN).txt summarise",
    cwd,
  );
  assert.deepEqual(longer.refs, ["tender_docs/101521 RFQTS Joint Data Networks (JDN).txt"]);
  assert.equal(longer.question, "summarise");
});

test("rejoining never eats question text that is not part of a path", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "ask-spaces-"));
  await writeFile(path.join(cwd, "notes.md"), "n\n");

  // A reference that already resolves is untouched.
  const exact = await repairSpacedRefs(["notes.md"], "notes.md is not a path word", cwd);
  assert.deepEqual(exact.refs, ["notes.md"]);
  assert.equal(exact.question, "notes.md is not a path word", "question preserved");

  // A reference that resolves to nothing and cannot grow is left as it was, for
  // the resolver to report properly.
  const hopeless = await repairSpacedRefs(["nothing"], "like this at all", cwd);
  assert.deepEqual(hopeless.refs, ["nothing"]);
  assert.equal(hopeless.question, "like this at all");
  assert.deepEqual(hopeless.repaired, []);
});

test("the longest existing path wins when names share a prefix", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "ask-spaces-"));
  await writeFile(path.join(cwd, "report final.md"), "a\n");
  await writeFile(path.join(cwd, "report final draft.md"), "b\n");

  const fixed = await repairSpacedRefs(["report"], "final draft.md review this", cwd);
  assert.deepEqual(fixed.refs, ["report final draft.md"], "greedy, not first-match");
  assert.equal(fixed.question, "review this");
});

test("a directory with spaces can be rejoined too", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "ask-spaces-"));
  await mkdir(path.join(cwd, "my docs"), { recursive: true });
  await writeFile(path.join(cwd, "my docs", "a.md"), "a\n");

  const fixed = await repairSpacedRefs(["my"], "docs summarise these", cwd);
  assert.deepEqual(fixed.refs, ["my docs"]);
  assert.equal(fixed.question, "summarise these");
});
