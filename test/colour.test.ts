import assert from "node:assert/strict";
import test from "node:test";

import { createPalette, NO_COLOUR, supportsColour } from "../src/colour.ts";

const TTY = { isTTY: true };
const PIPE = { isTTY: false };
const TERM = { TERM: "xterm-256color" };

test("colours only a terminal", () => {
  assert.equal(supportsColour(TTY, TERM), true);
  assert.equal(supportsColour(PIPE, TERM), false, "piped output stays plain");
  assert.equal(supportsColour(undefined, TERM), false);
  assert.equal(supportsColour(TTY, { TERM: "dumb" }), false);
  assert.equal(supportsColour(TTY, {}), false, "no TERM at all");
});

test("NO_COLOR wins over FORCE_COLOR", () => {
  // A global opt-out should not be overridden by a variable some other tool set.
  assert.equal(supportsColour(TTY, { ...TERM, NO_COLOR: "1" }), false);
  assert.equal(supportsColour(TTY, { ...TERM, NO_COLOR: "1", FORCE_COLOR: "1" }), false);
  // Per no-color.org, an empty value does not count as opting out.
  assert.equal(supportsColour(TTY, { ...TERM, NO_COLOR: "" }), true);
});

test("FORCE_COLOR enables colour for a pipe, and 0 disables it", () => {
  assert.equal(supportsColour(PIPE, { ...TERM, FORCE_COLOR: "1" }), true);
  assert.equal(supportsColour(PIPE, { FORCE_COLOR: "1" }), true, "no TERM needed when forced");
  assert.equal(supportsColour(TTY, { ...TERM, FORCE_COLOR: "0" }), false);
  assert.equal(supportsColour(TTY, { ...TERM, FORCE_COLOR: "" }), false);
});

test("an enabled palette wraps and resets", () => {
  const palette = createPalette(true);
  assert.equal(palette.enabled, true);
  assert.equal(palette.dim("status"), "\u001b[2mstatus\u001b[0m");
  assert.equal(palette.red("boom"), "\u001b[31mboom\u001b[0m");
  assert.equal(palette.yellow("careful"), "\u001b[33mcareful\u001b[0m");
  assert.equal(palette.bold("title"), "\u001b[1mtitle\u001b[0m");
  assert.equal(palette.cyan("label"), "\u001b[36mlabel\u001b[0m");
});

test("a disabled palette is the identity, so callers never branch", () => {
  for (const palette of [createPalette(false), NO_COLOUR]) {
    assert.equal(palette.enabled, false);
    assert.equal(palette.dim("status"), "status");
    assert.equal(palette.red("boom"), "boom");
    assert.equal(palette.yellow("careful"), "careful");
    assert.equal(palette.bold("title"), "title");
    assert.equal(palette.cyan("label"), "label");
  }
});
