import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import test, { type TestContext } from "node:test";
import {
  appendTurn, applyCompaction, archiveSession, clearSession, commitThread, dropOldestTurns, emptySession,
  listSessions, readThread, rememberFailedPrompt, resetSession, sessionMessages, sessionPath, sessionPrompts,
} from "../src/session.ts";

async function fixture(t: TestContext) {
  const dir = await mkdtemp(path.join(tmpdir(), "ask-thread-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const key = { scope: dir, name: "work", env: { ASK_STATE_DIR: dir } };
  const file = sessionPath(key);
  const legacy = path.join(dir, "sessions", path.basename(file));
  await mkdir(path.dirname(legacy));
  const turn = { at: new Date().toISOString(), question: "why?", answer: "because", refs: ["old"] };
  const thread = { ...emptySession(dir, "work"), turns: [turn], selection: {
    refs: ["src"], excluded: ["src/local"], skills: [{ name: "review", file: ".ask/skills/review.md" }],
  } };
  return { key, file, legacy, thread };
}

test("current selection and turns round-trip without materializing content or approvals", async t => {
  const { key, file, thread } = await fixture(t);
  const revision = await commitThread(key, thread, null);
  assert.deepEqual(await readThread(key), { revision, session: thread });
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), thread);
  if (process.platform !== "win32") assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test("CLI handoff keeps failed TUI inputs in recall order but out of conversation history", async t => {
  const { key } = await fixture(t);
  const first = rememberFailedPrompt(emptySession(key.scope, key.name), "failed before first");
  const answered = appendTurn(first, { ...key, question: "first", refs: [], answer: "one" });
  const next = appendTurn(rememberFailedPrompt(answered, "failed between"), { ...key, question: "second", refs: [], answer: "two" });
  const thread = rememberFailedPrompt(next, "failed last");
  assert.deepEqual(sessionPrompts(thread), ["failed before first", "first", "failed between", "second", "failed last"]);
  assert.deepEqual(sessionPrompts(dropOldestTurns(thread, 1)), ["failed between", "second", "failed last"]);
  assert.deepEqual(sessionMessages(thread).map(m => m.content), ["first", "one", "second", "two"]);
  assert.deepEqual(sessionPrompts(applyCompaction(thread, "summary")), []);
  await commitThread(key, thread, null);
  const cleared = await clearSession(key);
  assert.ok(cleared); assert.deepEqual(sessionPrompts(cleared), []);
});

test("legacy summary and cleared context survive migration; corrupt v2 never falls back", async t => {
  const { key, file, legacy, thread } = await fixture(t);
  const old = { ...thread, version: 1, selection: undefined, turns: [{ ...thread.turns[0], summary: true }],
    context: { refs: ["a"], skills: [] } };
  await writeFile(legacy, JSON.stringify(old));
  const before = await readThread(key);
  assert.match(sessionMessages(before.session)[0]!.content, /conversation-summary/);
  await commitThread(key, before.session!, before.revision);
  assert.deepEqual((await listSessions(key.scope, key.env)).map(s => s.name), ["work"]);
  await writeFile(file, '{"version":99}');
  await assert.rejects(readThread(key), /invalid or unsupported/);
  await assert.rejects(commitThread(key, thread, null), /invalid or unsupported/);
});

test("competing revisions and an abandoned staging file cannot overwrite a committed turn", async t => {
  const { key, file, thread } = await fixture(t);
  const r = await commitThread(key, thread, null);
  await writeFile(`${file}.interrupted.tmp`, "{");
  const update = { ...thread, turns: [] };
  const results = await Promise.allSettled([commitThread(key, update, r), commitThread(key, update, r)]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  await assert.rejects(commitThread(key, thread, r), /changed/);
  assert.deepEqual((await readThread(key)).session?.turns, []);
});

test("clear, archive and reset never resurrect legacy copies or backups", async t => {
  const { key, legacy, thread } = await fixture(t);
  for (const action of ["clear", "archive", "reset"]) {
    await writeFile(legacy, JSON.stringify({ ...thread, version: 1 }));
    await writeFile(legacy.replace(".json", ".pre-compact.json"), "old history");
    const { revision } = await readThread(key);
    await commitThread(key, thread, revision);
    if (action === "clear") {
      const cleared = await clearSession(key);
      assert.deepEqual(cleared?.turns, []);
      assert.deepEqual(cleared?.selection, thread.selection);
      await resetSession(key);
    } else if (action === "archive") await archiveSession(thread, key.env);
    else await resetSession(key);
    assert.equal((await readThread(key)).session, null);
    await assert.rejects(stat(legacy.replace(".json", ".pre-compact.json")), { code: "ENOENT" });
  }
});
