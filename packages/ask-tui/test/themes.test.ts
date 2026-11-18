import assert from "node:assert/strict";
import test from "node:test";
import { ASK_PALETTE, THEME_NAMES, themeModes, themePalette } from "../src/themes.ts";
import { draculaTheme } from "../src/themes/dracula.ts";
import { materialTheme } from "../src/themes/material.ts";

test("all 40 termcn themes resolve using only their actual palettes", () => {
  assert.equal(THEME_NAMES.length, 41);
  for (const name of THEME_NAMES) {
    for (const mode of themeModes(name)) {
      const palette = themePalette(name, mode);
      for (const role of Object.keys(ASK_PALETTE)) assert.ok(Object.hasOwn(palette, role));
      for (const color of Object.values(palette)) assert.match(color, /^(?:#[\da-f]{6}(?:[\da-f]{2})?|transparent)$/i, `${name} ${mode}`);
    }
  }
});

test("termcn tokens are adapted directly without fabricating mode variants", () => {
  assert.equal(themePalette("dracula").text, draculaTheme.colors.foreground);
  assert.equal(themePalette("dracula").panel, draculaTheme.colors.muted);
  assert.equal(themePalette("dracula").selectionBg, draculaTheme.colors.selection);
  assert.equal(themePalette("material").accent, materialTheme.colors.primary);
  assert.deepEqual(themeModes("high-contrast-light"), ["light"]);
  assert.throws(() => themePalette("dracula", "light"), /does not provide a light variant/);
  assert.throws(() => themePalette("tokyonight"), /Unknown theme/);
  assert.ok(THEME_NAMES.includes("tokyo-night"));
  assert.deepEqual(themePalette("ask"), ASK_PALETTE);
  assert.throws(() => themePalette("missing"), /Unknown theme/);
  assert.throws(() => themePalette("toString"), /Unknown theme/);
});
