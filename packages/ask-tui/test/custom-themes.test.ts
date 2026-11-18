import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { loadCustomThemes } from "../src/custom-themes.ts";
import { ASK_PALETTE, THEME_NAMES, themeDescription, themeModes, themePalette } from "../src/themes.ts";

test("custom themes extend, override and validate, lowest-precedence directory first", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "ask-tui-themes-"));
  try {
    const global = path.join(base, "global");
    const project = path.join(base, "project");
    for (const dir of [global, project]) await mkdir(path.join(dir, "themes"), { recursive: true });
    const theme = (dir: string, file: string, contents: string) => writeFile(path.join(dir, "themes", file), contents);
    await theme(global, "midnight.jsonc", '{ "extends": "high-contrast-light", "accent": "#123456", /* comment */ }');
    await theme(global, "plain.json", '{ "panel": "#000000", "sparkle": "#ffffff" }');
    await theme(global, "dracula.json", '{ "extends": "nord", "accent": "#aabbcc" }');
    await theme(global, "layered.json", '{ "accent": "#111111" }');
    await theme(project, "layered.json", '{ "accent": "#222222" }');
    await theme(global, "escape.json", '{ "accent": "\\u001b]0;pwned\\u0007" }');
    await theme(global, "unknown-base.json", '{ "extends": "no-such-theme" }');
    await theme(global, "bad name.json", "{}");
    await theme(global, "twice.json", "{}");
    await theme(global, "twice.jsonc", "{}");
    const { names, notes } = await loadCustomThemes([global, path.join(base, "missing"), project]);

    assert.deepEqual(names.sort(), ["dracula", "layered", "layered", "midnight", "plain"].sort());
    assert.deepEqual(themeModes("midnight"), ["light"], "mode follows the extended theme");
    assert.equal(themePalette("midnight").accent, "#123456");
    assert.equal(themePalette("midnight").background, themePalette("high-contrast-light").background);
    assert.equal(themePalette("plain").panel, "#000000");
    assert.equal(themePalette("plain").text, ASK_PALETTE.text, "unset roles come from the ask palette");
    assert.equal(themePalette("dracula").accent, "#aabbcc", "a custom theme replaces a built-in of the same name");
    assert.equal(themePalette("layered").accent, "#222222", "a later directory wins");
    assert.match(themeDescription("layered"), /^Custom: .*project/);

    for (const name of ["escape", "unknown-base", "bad name", "twice"]) assert.ok(!THEME_NAMES.includes(name), name);
    assert.ok(notes.some((note) => /escape\.json: accent must be a hex colour/.test(note)));
    assert.ok(notes.some((note) => /Unknown theme: no-such-theme \(theme unknown-base skipped\)/.test(note)));
    assert.ok(notes.some((note) => /unknown colour role sparkle/.test(note)));
    assert.ok(notes.some((note) => /theme names use letters/.test(note)));
    assert.ok(notes.some((note) => /both twice\.json and twice\.jsonc exist/.test(note)));
    assert.equal(THEME_NAMES[0], "ask");
    assert.deepEqual(THEME_NAMES.slice(1), [...THEME_NAMES.slice(1)].sort());
  } finally { await rm(base, { recursive: true, force: true }); }
});
