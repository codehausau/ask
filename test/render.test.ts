import assert from "node:assert/strict";
import test from "node:test";

import { createPalette, NO_COLOUR } from "../src/colour.ts";
import { detectLanguage, highlight } from "../src/highlight.ts";
import {
  dropEmptyFences,
  normaliseNestedFences,
  renderMarkdown,
  tidyBlankLines,
  visibleLength,
} from "../src/render.ts";

const paint = createPalette(true);

/** What the terminal would actually show, with the escapes removed. */
function plain(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

test("fence tags map onto highlighters, unknown ones stay plain", () => {
  for (const tag of ["ts", "tsx", "typescript", "js", "jsx", "mjs"]) {
    assert.equal(detectLanguage(tag), "ts", tag);
  }
  assert.equal(detectLanguage("json5"), "json");
  assert.equal(detectLanguage("bash"), "shell");
  assert.equal(detectLanguage("console"), "shell");
  assert.equal(detectLanguage("yml"), "yaml");
  assert.equal(detectLanguage("xml"), "xml");
  assert.equal(detectLanguage("cot"), "xml", "CoT payloads are XML");
  assert.equal(detectLanguage("rust"), "plain", "no grammar, no guessing");
  assert.equal(detectLanguage(undefined), "plain");
  assert.equal(detectLanguage("ts title=x"), "ts", "extra fence metadata ignored");
});

test("highlighting never changes the code, only its colours", () => {
  const samples = [
    'export const a = 1; // note\nconst s = "with // slashes";\n',
    "const t = `template ${x} literal`;\n",
    'if (/[a-z]\\/\\//.test(s)) return "regex-ish";\n',
    '{"key": "value", "n": 12, "ok": true}\n',
    "# comment\nrun --flag \"$HOME/x\" | jq .a\n",
    '<event uid="x" time="2026-01-01T00:00:00Z"><!-- c --></event>\n',
    "",
  ];

  for (const source of samples) {
    for (const language of ["ts", "json", "shell", "xml"] as const) {
      const painted = highlight(source, language, paint);
      assert.equal(
        plain(painted),
        source,
        `${language} highlighting must be lossless for ${JSON.stringify(source)}`,
      );
    }
  }
});

test("keywords are styled but ordinary identifiers are not", () => {
  const painted = highlight("export const widget = 1;\n", "ts", paint);
  assert.match(painted, /\u001b\[1mexport\u001b\[22m/, "export is a keyword");
  assert.match(painted, /\u001b\[1mconst\u001b\[22m/);
  assert.equal(/\u001b\[[0-9;]*m[a-z]*widget/.test(painted), false, "widget is not styled");
});

test("a disabled palette leaves code exactly as it was", () => {
  const source = 'export const a = "x"; // note\n';
  assert.equal(highlight(source, "ts", NO_COLOUR), source);
  assert.equal(highlight(source, "plain", paint), source, "unknown language, no change");
});

test("a plain answer round-trips through the renderer", () => {
  const answer = "Just a sentence with no markdown in it.";
  assert.equal(plain(renderMarkdown(answer, { palette: paint })).trim(), answer);
});

test("rendering is skipped entirely for a disabled palette", () => {
  const answer = "## Heading\n\n- one\n- two\n";
  assert.equal(renderMarkdown(answer, { palette: NO_COLOUR }), answer, "byte-identical");
});

test("headings, emphasis and code spans are styled", () => {
  const out = renderMarkdown("## Review\n\nIt is **sound** and `chat.ts` is fine.\n", {
    palette: paint,
  });
  assert.match(out, /\u001b\[1mReview\u001b\[22m/);
  assert.match(out, /\u001b\[1msound\u001b\[22m/);
  assert.match(out, /\u001b\[33mchat\.ts\u001b\[39m/);
  assert.equal(plain(out).includes("##"), false, "markup is consumed, not shown");
  assert.equal(plain(out).includes("**"), false);
});

test("lists keep their content and numbering", () => {
  const out = plain(renderMarkdown("1. first\n2. second\n\n- a\n- b\n", { palette: paint }));
  assert.match(out, /1\. first/);
  assert.match(out, /2\. second/);
  assert.match(out, /• a/);
  assert.match(out, /• b/);
});

test("a nested list is indented rather than flattened", () => {
  const out = plain(renderMarkdown("- outer\n  - inner\n", { palette: paint }));
  const inner = out.split("\n").find((line) => line.includes("inner")) ?? "";
  const outer = out.split("\n").find((line) => line.includes("outer")) ?? "";
  assert.ok(
    inner.search(/\S/) > outer.search(/\S/),
    `expected deeper indent, got ${JSON.stringify(inner)}`,
  );
});

test("a code block is framed, labelled and kept verbatim", () => {
  const out = renderMarkdown("```ts\nconst a = 1;\n```\n", { palette: paint });
  const shown = plain(out);
  assert.match(shown, /┌─ ts/);
  assert.match(shown, /└─/);
  assert.match(shown, /^ {2}const a = 1;$/m, "indented, unchanged");
});

test("a table lines up on visible width, not byte length", () => {
  const out = renderMarkdown("| Field | When |\n| --- | --- |\n| `a` | now |\n", {
    palette: paint,
  });
  const lines = plain(out).split("\n").filter((line) => line.includes("│"));
  assert.ok(lines.length >= 2, "header and body");
  // Every row's separator sits in the same column despite the styled cell.
  const columns = lines.map((line) => line.indexOf("│"));
  assert.equal(new Set(columns).size, 1, `separators misaligned: ${columns.join(",")}`);
});

test("blockquotes are marked and links keep their URL", () => {
  const quote = plain(renderMarkdown("> mind this\n", { palette: paint }));
  assert.match(quote, /│ mind this/);

  const link = plain(renderMarkdown("See [the docs](https://example.com/x).\n", { palette: paint }));
  assert.match(link, /the docs <https:\/\/example\.com\/x>/, "a terminal cannot click");
});

test("long paragraphs wrap to the given width", () => {
  const answer = `${"word ".repeat(60).trim()}\n`;
  const lines = plain(renderMarkdown(answer, { palette: paint, width: 40 }))
    .split("\n")
    .filter((line) => line.trim().length > 0);

  assert.ok(lines.length > 1, "wrapped");
  for (const line of lines) assert.ok(line.length <= 40, `too long: ${line.length}`);
});

test("visibleLength ignores escape sequences", () => {
  assert.equal(visibleLength("plain"), 5);
  assert.equal(visibleLength(paint.bold("plain")), 5);
  assert.equal(visibleLength(paint.bold(paint.cyan("plain"))), 5);
});

test("markdown the renderer does not understand is still shown", () => {
  // An unhandled token type must emit its raw text rather than vanish.
  const out = plain(renderMarkdown("Text\n\n<div>html</div>\n\nMore\n", { palette: paint }));
  assert.match(out, /Text/);
  assert.match(out, /html/);
  assert.match(out, /More/);
});

test("an empty fence is dropped rather than framed", () => {
  // Reported: an answer ended with a stray empty fence, rendering as a frame
  // around nothing.
  const out = plain(renderMarkdown("Answer.\n\n```\n```\n", { palette: paint }));
  assert.equal(out.includes("┌─"), false, "no frame around nothing");
  assert.match(out, /Answer\./);

  assert.equal(dropEmptyFences("a\n\n```\n```\n").includes("```"), false);
  assert.equal(dropEmptyFences("a\n```\n\n\n```\nb").includes("```"), false, "blank-only body");
  // A block with content is untouched.
  assert.match(dropEmptyFences("```ts\nconst a = 1;\n```"), /const a = 1;/);
  assert.match(dropEmptyFences("```ts\nconst a = 1;\n```"), /```/);
});

test("an unlabelled fence gets no invented label", () => {
  const labelled = plain(renderMarkdown("```ts\nconst a = 1;\n```\n", { palette: paint }));
  assert.match(labelled, /┌─ ts/);

  const bare = plain(renderMarkdown("```\nplain text\n```\n", { palette: paint }));
  assert.match(bare, /┌─\n/, "frame only");
  assert.equal(bare.includes("┌─ code"), false, "no made-up language");
  assert.equal(bare.includes("┌─ text"), false);
});

test("blocks are separated by exactly one blank line", () => {
  const out = plain(
    renderMarkdown("## One\n\ntext\n\n```ts\na\n```\n\n## Two\n\nmore\n", { palette: paint }),
  );
  assert.equal(/\n\n\n/.test(out), false, `doubled blank lines in:\n${out}`);
  assert.equal(tidyBlankLines("a\n\n\n\nb"), "a\n\nb");
  assert.equal(tidyBlankLines("\n\na\n\n"), "a");
});

test("a document wrapped in a markdown fence survives its own fences", () => {
  // The reported case: a README inside ```markdown, containing ```sh — CommonMark
  // ends the outer block at the inner fence, spilling the rest of the document.
  const answer = [
    "Here is an example:",
    "",
    "```markdown",
    "# Title",
    "",
    "## Install",
    "",
    "```sh",
    "npm i",
    "```",
    "",
    "## License",
    "",
    "MIT",
    "```",
    "",
  ].join("\n");

  const out = plain(renderMarkdown(answer, { palette: paint }));
  const frames = (out.match(/┌─/g) ?? []).length;
  assert.equal(frames, 1, `the document should be one block, got ${frames}`);
  // Everything after the inner fence stayed inside, indented as block content.
  assert.match(out, /^ {2}## License$/m);
  assert.match(out, /^ {2}MIT$/m);
});

test("the nested-fence repair only fires when it is needed", () => {
  // No inner fences: the last fence is the closing one, so nothing to do.
  const simple = "```markdown\n# Title\n```";
  assert.equal(normaliseNestedFences(simple), simple);

  // Two markdown fences: ambiguous, so leave well alone rather than swallow
  // everything between them.
  const two = "```markdown\n# A\n\n```sh\nx\n```\n```\n\n```markdown\n# B\n```";
  assert.equal(normaliseNestedFences(two), two);

  // No markdown fence at all.
  const code = "```ts\nconst a = 1;\n```";
  assert.equal(normaliseNestedFences(code), code);

  // The case it exists for gains a four-backtick fence.
  const nested = "```markdown\n# A\n\n```sh\nx\n```\n\nend\n```";
  const fixed = normaliseNestedFences(nested);
  assert.match(fixed, /^````markdown$/m);
  assert.match(fixed, /^````$/m);
});
