import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  applyToRc,
  completionSnippet,
  findExecutable,
  installInstructions,
  pickerStatus,
} from "../src/install.ts";

const SCRIPT = "/home/node/ask/completions/ask.bash";

test("the snippet is guarded and absolute", () => {
  const snippet = completionSnippet(SCRIPT);
  assert.match(snippet, /^# >>> ask completion >>>/);
  assert.match(snippet, /# <<< ask completion <<<$/);
  assert.match(snippet, /export ASK_AT_KEY=1/);
  // The guard is the point: a missing file must not error on every new shell.
  assert.match(snippet, /\[ -f "\/home\/node\/ask\/completions\/ask\.bash" \] && source /);
});

test("a fresh rc file gets the block appended once", () => {
  const update = applyToRc("# my bashrc\nexport PATH=$PATH:/opt/bin\n", SCRIPT);

  assert.equal(update.changed, true);
  assert.equal(update.replacedBlock, false);
  assert.equal(update.removedStale, 0);
  assert.match(update.text, /^# my bashrc\nexport PATH=\$PATH:\/opt\/bin\n\n# >>> ask/);
  assert.equal(update.text.match(/# >>> ask completion >>>/g)?.length, 1);
});

test("running it twice changes nothing", () => {
  const once = applyToRc("# rc\n", SCRIPT);
  const twice = applyToRc(once.text, SCRIPT);

  assert.equal(twice.changed, false, "idempotent");
  assert.equal(twice.text, once.text);
  assert.equal(twice.text.match(/# >>> ask completion >>>/g)?.length, 1);
});

test("a managed block pointing at a moved install is refreshed", () => {
  const stale = applyToRc("# rc\n", "/old/path/completions/ask.bash").text;
  const update = applyToRc(stale, SCRIPT);

  assert.equal(update.changed, true);
  assert.equal(update.replacedBlock, true);
  assert.equal(update.text.includes("/old/path"), false, "old path gone");
  assert.match(update.text, /\/home\/node\/ask\/completions\/ask\.bash/);
  assert.equal(update.text.match(/# >>> ask completion >>>/g)?.length, 1);
});

test("a hand-written line with the wrong path is cleared", () => {
  // The exact failure this command exists to prevent: `$PWD` was not the repo,
  // so every new shell printed "No such file or directory".
  const rc = [
    "# my bashrc",
    "export EDITOR=vim",
    "export ASK_AT_KEY=1",
    "source /workspaces/tenders/completions/ask.bash",
    "",
  ].join("\n");

  const update = applyToRc(rc, SCRIPT);

  assert.equal(update.removedStale, 2, "the bad source line and the loose export");
  assert.equal(update.text.includes("/workspaces/tenders"), false);
  assert.match(update.text, /export EDITOR=vim/, "unrelated lines survive");
  assert.match(update.text, /\/home\/node\/ask\/completions\/ask\.bash/);
  assert.equal(update.text.match(/export ASK_AT_KEY=/g)?.length, 1, "no duplicate export");
});

test("the hand-written comment header is cleared with its lines", () => {
  const rc = [
    "# rc",
    "",
    "# ask(1) completion + @ picker. ASK_AT_KEY=1 makes typing `@` open the picker",
    "export ASK_AT_KEY=1",
    '[ -f /old/ask/completions/ask.bash ] && source /old/ask/completions/ask.bash',
    "",
  ].join("\n");

  const update = applyToRc(rc, SCRIPT);
  assert.equal(update.text.includes("/old/ask"), false);
  assert.equal(update.text.includes("# ask(1) completion"), false, "orphan comment removed");
  assert.match(update.text, /^# rc\n/);
});

test("an empty rc file is handled", () => {
  const update = applyToRc("", SCRIPT);
  assert.equal(update.changed, true);
  assert.match(update.text, /^# >>> ask completion >>>/, "no leading blank lines");
});

test("instructions name the rc file and the zsh bridge", () => {
  const text = installInstructions(SCRIPT, "/home/node/.bashrc");
  assert.match(text, /Add this to \/home\/node\/\.bashrc/);
  assert.match(text, /--install-completion --apply/);
  assert.match(text, /bashcompinit/, "zsh users need the bridge");
});

test("the picker status says whether @ will actually do anything", () => {
  // The confusion this exists to prevent: everything loads, ASK_AT_KEY=1, and
  // `@` still does nothing because fzf is missing.
  const missing = pickerStatus(null);
  assert.match(missing, /not found/);
  assert.match(missing, /'@' stays literal/);
  assert.match(missing, /apt-get install fzf/);

  const found = pickerStatus("/usr/bin/fzf");
  assert.match(found, /\/usr\/bin\/fzf/);
  assert.match(found, /opens the picker/);
});

test("findExecutable walks PATH and reports the first hit", async () => {
  const executable = new Set(["/opt/bin/fzf", "/usr/bin/fzf"]);
  const canExecute = async (file: string): Promise<boolean> => executable.has(file);

  assert.equal(
    await findExecutable("fzf", { PATH: "/nope:/opt/bin:/usr/bin" }, canExecute),
    "/opt/bin/fzf",
    "first match on PATH wins",
  );
  assert.equal(await findExecutable("fzf", { PATH: "/nope" }, canExecute), null);
  assert.equal(await findExecutable("fzf", {}, canExecute), null, "empty PATH");
  assert.equal(await findExecutable("fzf", { PATH: "::/usr/bin" }, canExecute), "/usr/bin/fzf");
});

test("findExecutable finds a real executable and rejects a plain file", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ask-exec-"));
  await writeFile(path.join(dir, "runnable"), "#!/bin/sh\n", { mode: 0o755 });
  await writeFile(path.join(dir, "plain"), "data\n", { mode: 0o644 });

  assert.equal(await findExecutable("runnable", { PATH: dir }), path.join(dir, "runnable"));
  assert.equal(await findExecutable("plain", { PATH: dir }), null, "not executable");
  assert.equal(await findExecutable("absent", { PATH: dir }), null);
});
