import assert from "node:assert/strict";
import test from "node:test";
import { filterPopupItems, isFileCandidateVisible, SLASH_COMMANDS, type PopupItem } from "../src/picker.ts";
import { commandPaths } from "../src/commands.ts";
import { chatRefs, serializeMention } from "../src/mentions.ts";

test("picker mentions round-trip parser delimiters and cannot introduce extra attachments", () => {
  for (const name of ["src/routes/(group)/page.ts", "notes).ts", "report,", "report;", "report:",
    "name with spaces.ts", "a'b.ts", 'a"b.ts', "😀/notes).ts", "file @other.ts", "a\\b.ts"]) {
    const mention = serializeMention(name);
    assert.notEqual(mention, null, name);
    assert.deepEqual(chatRefs(`Explain ${mention} please`), [name]);
  }
  for (const name of ["", "line\nbreak", "line\rbreak", `both ' and " quotes`]) assert.equal(serializeMention(name), null);
});

const commands: PopupItem[] = SLASH_COMMANDS.map((entry) => ({ kind: "command", value: entry.value, label: entry.value, description: entry.description }));

test("command completion searches names and descriptions, case-insensitively", () => {
  assert.equal(filterPopupItems(commands, "").length, commands.length);
  assert.equal(filterPopupItems(commands, "review")[0]?.value, "/review");
  assert.equal(filterPopupItems(commands, "skil")[0]?.value, "/skill");
  assert.equal(filterPopupItems(commands, "skill")[0]?.value, "/skill");
  assert.equal(filterPopupItems(commands, "skills")[0]?.value, "/skills");
  assert.deepEqual(filterPopupItems(commands, "REMOVE SKILL").map((item) => item.value), ["/unskill"]);
  assert.deepEqual(filterPopupItems(commands, "clipboard").map((item) => item.value), ["/copy"]);
  assert.deepEqual(filterPopupItems(commands, "definitely-not-a-command"), []);
  assert.equal(new Set(SLASH_COMMANDS.map((entry) => entry.value)).size, SLASH_COMMANDS.length);
});

test("hidden file/folder candidates require an explicit dot-prefixed filename component", () => {
  assert.equal(isFileCandidateVisible("normal.ts", ""), true);
  assert.equal(isFileCandidateVisible("src/normal.ts", "normal.ts"), true);
  for (const candidate of [".prettierrc", ".config/", ".config/settings.ts", "src/.hidden.ts"]) {
    assert.equal(isFileCandidateVisible(candidate, ""), false);
    assert.equal(isFileCandidateVisible(candidate, "hidden"), false);
    assert.equal(isFileCandidateVisible(candidate, "normal.ts"), false);
    assert.equal(isFileCandidateVisible(candidate, "./"), false);
    assert.equal(isFileCandidateVisible(candidate, "."), true);
  }
  assert.equal(isFileCandidateVisible("src/.hidden.ts", "src/."), true);
  assert.equal(isFileCandidateVisible("src/.hidden.ts", "src/.hid"), true);
  assert.equal(isFileCandidateVisible("src/.hidden.ts", "src/hidden"), false);
  assert.equal(isFileCandidateVisible(".config/settings.ts", ".config/set"), true);
  assert.equal(isFileCandidateVisible(".config/.nested/file.ts", ".config/"), false);
  assert.equal(isFileCandidateVisible(".config/.nested/file.ts", ".config/."), true);
});

test("explicitly escaped mentions stay literal; review commands accept quoted paths", () => {
  assert.deepEqual(chatRefs("\\@dataclass\nclass A:\n  \\@property\n  def x(self): pass  # me@host stays\n(\\@Inject)"), []);
  assert.deepEqual(commandPaths(` a.ts "name with spaces.ts" 'b c.ts' @d.ts`), ["a.ts", "name with spaces.ts", "b c.ts", "@d.ts"]);
});
