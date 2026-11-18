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

test("an enabled palette uses attribute-specific resets", () => {
  const palette = createPalette(true);
  assert.equal(palette.enabled, true);
  // 22 ends bold/dim, 39 restores the default foreground — a blanket 0 would
  // end everything, so nested styling would lose the outer attribute.
  assert.equal(palette.dim("status"), "\u001b[2mstatus\u001b[22m");
  assert.equal(palette.bold("title"), "\u001b[1mtitle\u001b[22m");
  assert.equal(palette.red("boom"), "\u001b[31mboom\u001b[39m");
  assert.equal(palette.yellow("careful"), "\u001b[33mcareful\u001b[39m");
  assert.equal(palette.cyan("label"), "\u001b[36mlabel\u001b[39m");
});

test("a colour nested in bold leaves the bold intact", () => {
  const palette = createPalette(true);
  const heading = palette.bold(`Review of ${palette.yellow("chat.ts")} now`);
  // The inner span ends with 39, not 0, so "now" is still bold.
  assert.equal(heading, "\u001b[1mReview of \u001b[33mchat.ts\u001b[39m now\u001b[22m");
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
