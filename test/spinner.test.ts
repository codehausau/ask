import assert from "node:assert/strict";
import test from "node:test";

import {
  pickFrames,
  renderFrame,
  shouldAnimate,
  startSpinner,
  type SpinnerStream,
} from "../src/spinner.ts";

function recorder(isTTY = true): SpinnerStream & { written: string[] } {
  const written: string[] = [];
  return {
    isTTY,
    written,
    write(chunk: string) {
      written.push(chunk);
      return true;
    },
  };
}

test("animates only for a human at a terminal", () => {
  const tty = recorder(true);
  const pipe = recorder(false);
  const term = { TERM: "xterm-256color" };

  assert.equal(shouldAnimate(tty, term), true);
  assert.equal(shouldAnimate(pipe, term), false, "piped stderr stays clean");
  assert.equal(shouldAnimate(undefined, term), false);
  assert.equal(shouldAnimate(tty, { ...term, ASK_SPINNER: "0" }), false, "opt-out");
  assert.equal(shouldAnimate(tty, { TERM: "dumb" }), false);
  assert.equal(shouldAnimate(tty, {}), false, "no TERM at all");
  assert.equal(shouldAnimate(tty, { ...term, CI: "true" }), false, "CI logs stay clean");
  assert.equal(shouldAnimate(tty, { ...term, CI: "false" }), true);
  assert.equal(shouldAnimate(tty, { ...term, CI: "" }), true);
});

test("braille needs a UTF-8 locale, otherwise ASCII", () => {
  assert.equal(pickFrames({ LANG: "en_AU.UTF-8" })[0], "⠋");
  assert.equal(pickFrames({ LC_ALL: "C.utf8" })[0], "⠋");
  assert.equal(pickFrames({ LANG: "C" })[0], "-", "no mojibake on a POSIX locale");
  assert.equal(pickFrames({})[0], "-");
  assert.equal(pickFrames({ LANG: "en_AU.UTF-8", ASK_SPINNER: "ascii" })[0], "-", "forced");
});

test("a frame clears the line, names the wait and shows elapsed time", () => {
  const frame = renderFrame("⠙", "asking gpt-4o-mini", 2450);
  assert.equal(frame, "\r\u001b[K⠙ asking gpt-4o-mini… 2.5s");
  // The clear comes first, so a longer previous frame cannot leave debris.
  assert.ok(frame.startsWith("\r\u001b[K"));
});

test("styling wraps the text but never the erase sequence", () => {
  const dim = (text: string): string => `\u001b[2m${text}\u001b[0m`;
  const frame = renderFrame("⠙", "asking", 1000, dim);
  assert.equal(frame, "\r\u001b[K\u001b[2m⠙ asking… 1.0s\u001b[0m");
  assert.ok(frame.startsWith("\r\u001b[K"), "erase stays outside the styling");
});

test("frames advance and elapsed time grows", () => {
  const stream = recorder();
  let clock = 1000;
  const spinner = startSpinner({
    label: "asking",
    stream,
    enabled: true,
    frames: ["a", "b", "c"],
    intervalMs: 1_000_000, // the timer must not fire during the test
    now: () => clock,
  });

  assert.equal(stream.written.length, 1, "draws immediately, no blank pause");
  assert.match(stream.written[0]!, /a asking… 0\.0s$/);

  clock = 1500;
  spinner.tick();
  assert.match(stream.written[1]!, /b asking… 0\.5s$/);

  clock = 4000;
  spinner.tick();
  assert.match(stream.written[2]!, /c asking… 3\.0s$/);

  clock = 5000;
  spinner.tick();
  assert.match(stream.written[3]!, /a asking… 4\.0s$/, "frames cycle");

  spinner.stop();
});

test("stop erases the line and is idempotent", () => {
  const stream = recorder();
  const spinner = startSpinner({ label: "asking", stream, enabled: true, intervalMs: 1_000_000 });

  assert.equal(spinner.animating, true);
  spinner.stop();

  assert.equal(spinner.animating, false);
  assert.equal(stream.written.at(-1), "\r\u001b[K", "line left empty for the real output");

  const countAfterStop = stream.written.length;
  spinner.stop();
  spinner.tick();
  assert.equal(stream.written.length, countAfterStop, "no writes after stopping");
});

test("a disabled spinner writes nothing at all", () => {
  const stream = recorder();
  const spinner = startSpinner({ label: "asking", stream, enabled: false });

  spinner.tick();
  spinner.stop();

  assert.deepEqual(stream.written, [], "safe to use unconditionally");
  assert.equal(spinner.animating, false);
});
