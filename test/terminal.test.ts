import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { promisify } from "node:util";

import { createPalette, NO_COLOUR } from "../src/colour.ts";
import { completionSnippet, installInstructions, pickerStatus } from "../src/install.ts";
import { renderDiff, renderMarkdown } from "../src/render.ts";
import { renderFrame } from "../src/spinner.ts";
import { escapeJsonForTerminal, sanitizeForTerminal, terminalField } from "../src/terminal.ts";
import { shellQuote } from "../src/write.ts";

const ESC = "\u001b";
const ST = `${ESC}\\`;
const run = promisify(execFile);

test("document sanitisation strips ESC and C1 CSI sequences", () => {
  for (const csi of [`${ESC}[`, "\u009b"]) {
    assert.equal(sanitizeForTerminal(`before${csi}2Jafter${csi}31mred${csi}0m`), "beforeafterred");
    assert.equal(sanitizeForTerminal(`${csi}?25ltext${csi}1;2H!`), "text!");
    assert.equal(sanitizeForTerminal(`${csi}1 qtext`), "text");
  }
});

test("OSC clipboard, links and titles are stripped with BEL and either ST terminator", () => {
  for (const osc of [`${ESC}]`, "\u009d"]) {
    for (const end of ["\u0007", ST, "\u009c"]) {
      assert.equal(sanitizeForTerminal(`a${osc}52;c;cGF5bG9hZA==${end}b`), "ab");
      assert.equal(sanitizeForTerminal(`${osc}8;;https://example.invalid${end}label${osc}8;;${end}`), "label");
      assert.equal(sanitizeForTerminal(`${osc}0;window title${end}text`), "text");
    }
  }
});

test("DCS, SOS, PM and APC control strings are removed in ESC and C1 forms", () => {
  for (const start of [`${ESC}P`, `${ESC}X`, `${ESC}^`, `${ESC}_`, "\u0090", "\u0098", "\u009e", "\u009f"]) {
    for (const end of [ST, "\u009c"]) {
      assert.equal(sanitizeForTerminal(`before${start}payload\nmore payload${end}after`), "beforeafter");
    }
  }
});

test("multi-byte ESC forms and malformed or unterminated sequences leave no active controls", () => {
  assert.equal(sanitizeForTerminal(`${ESC}(Bhello${ESC}#8world${ESC}7!`), "helloworld!");
  assert.equal(sanitizeForTerminal(`before${ESC}]52;c;unfinished`), "before");
  assert.equal(sanitizeForTerminal(`before${ESC}_unfinished`), "before");
  assert.equal(sanitizeForTerminal(`before${ESC}[31;`), "before");
  assert.equal(sanitizeForTerminal(`before${ESC}`), "before");
  assert.equal(sanitizeForTerminal(`${ESC}${ESC}[31mtext`), "text");
  assert.equal(sanitizeForTerminal(`${ESC}[\n31mtext`), "text");
  assert.equal(sanitizeForTerminal(`${ESC}[31\u009d52;c;payload\u009ctext`), "text");
});

test("documents preserve Unicode and LF/tab, normalise CRLF and expose bidi controls", () => {
  const input = "café 日本語 😀\r\n\tcode\rtext\u0000\u0007\u0008\u000b\u007f\u0085\u202eend";
  const expected = "café 日本語 😀\n\tcodetext\\u202eend";
  assert.equal(sanitizeForTerminal(input), expected);
  assert.equal(sanitizeForTerminal(expected), expected, "idempotent");
  assert.equal(sanitizeForTerminal("a\u061cb\u200ec\u2066d\u2069e\u2028f"), "a\\u061cb\\u200ec\\u2066d\\u2069e\\u2028f");
});

test("single-line fields visibly escape controls instead of hiding text or forging rows", () => {
  const field = "file\nnext\r\t\u001b[2J\u009dtitle\u0007\u202e.ts";
  const escaped = "file\\nnext\\r\\t\\u001b[2J\\u009dtitle\\u0007\\u202e.ts";
  assert.equal(terminalField(field), escaped);
  assert.equal(terminalField(escaped), escaped);
  assert.equal(terminalField("café/日本語.ts"), "café/日本語.ts");
});

test("terminal JSON escapes C1 and format controls losslessly", () => {
  const value = { text: "a\u001b[2J\u009d52;c;x\u009c\u007f\u061c\u202e\u2069\n\tend", path: "file\u2028name" };
  const json = escapeJsonForTerminal(JSON.stringify(value, null, 2));
  assert.deepEqual(JSON.parse(json), value);
  assert.doesNotMatch(json, /[\u001b\u007f-\u009f\u061c\u2028-\u202e\u2066-\u2069]/);
  assert.ok(json.includes("\n"), "pretty-print whitespace is preserved");
});

test("rendering adds only trusted styling after sanitisation", () => {
  const paint = createPalette(true);
  const input = `## Title${ESC}]52;c;payload\u0007\n\n**bold** and code\n\n\`\`\`text\n${ESC}[2Jhello\n\`\`\``;
  const shown = renderMarkdown(input, { palette: paint });
  assert.match(shown, /\u001b\[1mTitle/);
  assert.match(shown, /hello/);
  assert.doesNotMatch(shown, /payload|\u001b\]|\u001b\[2J/);
  assert.equal(renderMarkdown(`plain${ESC}[2Jtext`, { palette: NO_COLOUR }), "plaintext");
  const entities = renderMarkdown("[link](&#27;[2J) `&#27;`", { palette: paint });
  assert.doesNotMatch(entities.replace(/\u001b\[[0-9;]*m/g, ""), /[\u001b\u007f-\u009f]/);
});

test("diff rendering sanitises file content and adds its own colours", () => {
  const input = `--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old${ESC}[2J\n+new${ESC}]52;c;payload\u0007\n`;
  const shown = renderDiff(input, createPalette(true));
  assert.match(shown, /\u001b\[31m-old/);
  assert.match(shown, /\u001b\[36m\+new/);
  assert.doesNotMatch(shown, /payload|\u001b\[2J|\u001b\]/);
  assert.equal(renderDiff(input, NO_COLOUR), "--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new\n");
});

test("spinner labels cannot inject terminal instructions or newlines", () => {
  const frame = renderFrame("x", `model${ESC}[2J\nforged`, 1000, createPalette(true).dim);
  assert.equal(frame, `\r${ESC}[K${ESC}[2mx model\\u001b[2J\\nforged… 1.0s${ESC}[22m`);
});

test("shell hints display controls visibly while Bash receives the original argument", async () => {
  const value = "path\n\t\r\u001b[2J\u009b31m\u202e'$(printf INJECTED)\\literal.ts";
  const quoted = shellQuote(value);
  assert.equal(terminalField(quoted), quoted, "safe to pass through a status sink");
  for (const env of [process.env, { ...process.env, LC_ALL: "C" }]) {
    const result = await run("bash", ["-c", `printf '%s' ${quoted}`], { env });
    assert.equal(result.stdout, value);
    assert.equal(result.stderr, "");
  }
});

test("installer output safely displays paths and keeps generated shell arguments intact", async () => {
  const script = "/tmp/a\n\u001b[2J'$(printf INJECTED)/completions/ask.bash";
  const snippet = completionSnippet(script);
  assert.doesNotMatch(snippet, /\u001b/);
  const result = await run("bash", ["-c", `${snippet}\nprintf '%s' done`]);
  assert.equal(result.stdout, "done", "a missing path must neither execute injected code nor print anything");
  assert.equal(result.stderr, "");
  assert.match(installInstructions(script, "rc\nfile"), /rc\\nfile/);
  assert.match(pickerStatus("fzf\u001b[2J\nname"), /fzf\\u001b\[2J\\nname/);
});
