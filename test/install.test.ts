import assert from "node:assert/strict";
import test from "node:test";

import { applyToRc, completionSnippet, installInstructions } from "../src/install.ts";

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

test("instructions name the rc file and the fzf requirement", () => {
  const text = installInstructions(SCRIPT, "/home/node/.bashrc");
  assert.match(text, /Add this to \/home\/node\/\.bashrc/);
  assert.match(text, /--install-completion --apply/);
  assert.match(text, /bashcompinit/, "zsh users need the bridge");
  assert.match(text, /needs fzf/);
});
