import assert from "node:assert/strict";
import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { collectContext } from "../src/context.ts";
import {
  appendTurn,
  applyCompaction,
  backupSession,
  buildCompactionPrompt,
  DEFAULT_SESSION_NAME,
  estimateTokens,
  loadSession,
  pruneSession,
  resetSession,
  saveSession,
  sessionLabel,
  sessionMessages,
  sessionPath,
  sessionRefs,
  sessionTokens,
  sessionUsage,
  stateDir,
  type Session,
} from "../src/session.ts";

async function isolatedState(): Promise<{ env: NodeJS.ProcessEnv; dir: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "ask-state-"));
  return { env: { ...process.env, ASK_STATE_DIR: dir }, dir };
}

function session(scope: string, turns: Session["turns"] = []): Session {
  return {
    version: 1,
    name: DEFAULT_SESSION_NAME,
    scope,
    createdAt: "2026-09-26T00:00:00.000Z",
    updatedAt: "2026-09-26T00:00:00.000Z",
    turns,
  };
}

test("state directory honours ASK_STATE_DIR, then XDG, then ~/.local", () => {
  assert.equal(stateDir({ ASK_STATE_DIR: "/tmp/somewhere" }), "/tmp/somewhere");
  assert.equal(stateDir({ XDG_STATE_HOME: "/tmp/xdg" }), path.join("/tmp/xdg", "ask"));
  assert.match(stateDir({}), /\.local\/state\/ask$/);
});

test("sessions are keyed by scope and name", () => {
  const env = { ASK_STATE_DIR: "/tmp/state" };
  const a = sessionPath({ scope: "/repo/one", name: "default", env });
  const b = sessionPath({ scope: "/repo/two", name: "default", env });
  const c = sessionPath({ scope: "/repo/one", name: "review", env });

  assert.notEqual(a, b, "different repos get different threads");
  assert.notEqual(a, c, "named threads are separate");
  assert.equal(a, sessionPath({ scope: "/repo/one", name: "default", env }), "stable");
  assert.match(a, /^\/tmp\/state\/sessions\/[0-9a-f]{16}\.json$/);
});

test("a saved session round-trips and is owner-only", async () => {
  const { env } = await isolatedState();
  const original = appendTurn(null, {
    scope: "/repo/one",
    name: DEFAULT_SESSION_NAME,
    question: "what does this do?",
    refs: ["src/chat.ts"],
    answer: "it sends one request",
  });

  const file = await saveSession(original, env);
  const info = await stat(file);
  assert.equal(info.mode & 0o777, 0o600, "contains your source: owner-only");

  const loaded = await loadSession({ scope: "/repo/one", name: DEFAULT_SESSION_NAME, env });
  assert.deepEqual(loaded, original);
});

test("an idle session expires rather than resurfacing later", async () => {
  const { env } = await isolatedState();
  const now = Date.parse("2026-09-26T12:00:00.000Z");
  const stale = appendTurn(null, {
    scope: "/repo/one",
    name: DEFAULT_SESSION_NAME,
    question: "old question",
    refs: [],
    answer: "old answer",
    now: new Date(now - 3 * 60 * 60 * 1000),
  });
  await saveSession(stale, env);

  const key = { scope: "/repo/one", name: DEFAULT_SESSION_NAME, env };
  assert.equal(await loadSession(key, 2 * 60 * 60 * 1000, now), null, "3h idle, 2h TTL");
  assert.notEqual(await loadSession(key, 4 * 60 * 60 * 1000, now), null, "within a 4h TTL");
  assert.notEqual(await loadSession(key, 0, now), null, "TTL 0 disables expiry");
});

test("a corrupt or foreign session file starts a new thread instead of failing", async () => {
  const { env } = await isolatedState();
  const key = { scope: "/repo/one", name: DEFAULT_SESSION_NAME, env };
  const file = sessionPath(key);
  await saveSession(session("/repo/one"), env);

  await writeFile(file, "{ not json");
  assert.equal(await loadSession(key), null);

  await writeFile(file, JSON.stringify({ version: 99, turns: [] }));
  assert.equal(await loadSession(key), null, "unknown schema version");
});

test("reset removes the thread and reports whether there was one", async () => {
  const { env } = await isolatedState();
  const key = { scope: "/repo/one", name: DEFAULT_SESSION_NAME, env };

  assert.equal(await resetSession(key), false, "nothing to remove");
  await saveSession(session("/repo/one", [
    { at: "2026-09-26T00:00:00.000Z", question: "q", refs: [], answer: "a" },
  ]), env);
  assert.equal(await resetSession(key), true);
  assert.equal(await loadSession(key), null);
});

test("refs accumulate across turns, deduplicated, first appearance first", () => {
  const thread = session("/repo", [
    { at: "1", question: "q1", refs: ["src/a.ts"], answer: "a1" },
    { at: "2", question: "q2", refs: ["src/b.ts", "src/a.ts"], answer: "a2" },
  ]);
  assert.deepEqual(sessionRefs(thread), ["src/a.ts", "src/b.ts"]);
  assert.deepEqual(sessionRefs(null), []);
});

test("history carries questions and answers, never file contents", () => {
  const thread = session("/repo", [
    { at: "1", question: "what does this do?", refs: ["src/a.ts"], answer: "one request" },
    { at: "2", question: "and the token field?", refs: [], answer: "max_tokens locally" },
  ]);

  assert.deepEqual(sessionMessages(thread), [
    { role: "user", content: "what does this do?" },
    { role: "assistant", content: "one request" },
    { role: "user", content: "and the token field?" },
    { role: "assistant", content: "max_tokens locally" },
  ]);
  // The file body is absent: it is re-read fresh for the current request.
  assert.equal(
    sessionMessages(thread).some((message) => message.content.includes("<file")),
    false,
  );
});

test("pruning drops oldest turns first and reports how many", () => {
  const turns = [1, 2, 3, 4].map((index) => ({
    at: String(index),
    question: `question ${index} `.repeat(20),
    refs: [],
    answer: `answer ${index} `.repeat(20),
  }));
  const thread = session("/repo", turns);

  const budget = estimateTokens(turns[2]!.question) + estimateTokens(turns[2]!.answer) +
    estimateTokens(turns[3]!.question) + estimateTokens(turns[3]!.answer);

  const pruned = pruneSession(thread, budget, 0);
  assert.equal(pruned.dropped, 2);
  assert.deepEqual(
    pruned.session.turns.map((turn) => turn.at),
    ["3", "4"],
  );

  // A large current turn squeezes out more history.
  const squeezed = pruneSession(thread, budget, budget);
  assert.equal(squeezed.session.turns.length, 0);
  assert.equal(squeezed.dropped, 4);

  // Nothing to do when it already fits.
  assert.equal(pruneSession(thread, 1_000_000, 0).dropped, 0);
});

test("appendTurn preserves createdAt and advances updatedAt", () => {
  const first = appendTurn(null, {
    scope: "/repo",
    name: "default",
    question: "q1",
    refs: [],
    answer: "a1",
    now: new Date("2026-09-26T01:00:00.000Z"),
  });
  const second = appendTurn(first, {
    scope: "/repo",
    name: "default",
    question: "q2",
    refs: [],
    answer: "a2",
    now: new Date("2026-09-26T02:00:00.000Z"),
  });

  assert.equal(second.createdAt, "2026-09-26T01:00:00.000Z");
  assert.equal(second.updatedAt, "2026-09-26T02:00:00.000Z");
  assert.equal(second.turns.length, 2);
});

test("sessionLabel uses the repo name by default, the given name otherwise", () => {
  assert.equal(sessionLabel({ name: "default", scope: "/workspaces/tak/takbot" }), "takbot");
  assert.equal(sessionLabel({ name: "review", scope: "/workspaces/tak/takbot" }), "review");
});

test("usage is recorded per turn and totalled across the thread", () => {
  const first = appendTurn(null, {
    scope: "/repo",
    name: "default",
    question: "q1",
    refs: [],
    answer: "a1",
    usage: { input: 1200, output: 80 },
  });
  const second = appendTurn(first, {
    scope: "/repo",
    name: "default",
    question: "q2",
    refs: [],
    answer: "a2",
    usage: { input: 1500, output: 120 },
  });

  assert.deepEqual(second.turns[0]?.usage, { input: 1200, output: 80 });
  assert.deepEqual(sessionUsage(second), {
    input: 2700,
    output: 200,
    reported: 2,
    turns: 2,
  });
});

test("a turn without reported usage is counted, not invented", () => {
  const withUsage = appendTurn(null, {
    scope: "/repo",
    name: "default",
    question: "q1",
    refs: [],
    answer: "a1",
    usage: { input: 100, output: 10 },
  });
  // Endpoints are not obliged to report usage; nulls must not become zeros
  // that look like a complete total.
  const withoutUsage = appendTurn(withUsage, {
    scope: "/repo",
    name: "default",
    question: "q2",
    refs: [],
    answer: "a2",
  });

  assert.equal(withoutUsage.turns[1]?.usage, undefined);
  const spent = sessionUsage(withoutUsage);
  assert.equal(spent.input, 100);
  assert.equal(spent.reported, 1);
  assert.equal(spent.turns, 2, "caller can see the total is partial");

  const nullUsage = appendTurn(null, {
    scope: "/repo",
    name: "default",
    question: "q",
    refs: [],
    answer: "a",
    usage: { input: null, output: null },
  });
  assert.deepEqual(sessionUsage(nullUsage), { input: 0, output: 0, reported: 1, turns: 1 });
  assert.deepEqual(sessionUsage(null), { input: 0, output: 0, reported: 0, turns: 0 });
});

test("history tokens count what is actually resent", () => {
  const thread = session("/repo", [
    { at: "1", question: "hello there", refs: [], answer: "general kenobi" },
  ]);
  const expected = sessionMessages(thread).reduce(
    (total, message) => total + estimateTokens(message.content),
    0,
  );
  assert.equal(sessionTokens(thread), expected);
  assert.equal(sessionTokens(null), 0);
});

test("compaction replaces the thread but keeps every attached file", () => {
  const thread = session("/repo", [
    { at: "1", question: "q1", refs: ["src/a.ts"], answer: "a1" },
    { at: "2", question: "q2", refs: ["src/b.ts"], answer: "a2" },
    { at: "3", question: "q3", refs: [], answer: "a3" },
  ]);

  const compacted = applyCompaction(thread, "- decided X\n- open: Y", new Date("2026-09-26T03:00:00.000Z"));

  assert.equal(compacted.turns.length, 1);
  const turn = compacted.turns[0]!;
  assert.equal(turn.summary, true);
  assert.equal(turn.covers, 3);
  assert.equal(turn.answer, "- decided X\n- open: Y");
  assert.deepEqual(turn.refs, ["src/a.ts", "src/b.ts"], "files stay attached");
  assert.deepEqual(sessionRefs(compacted), ["src/a.ts", "src/b.ts"]);
  assert.equal(compacted.updatedAt, "2026-09-26T03:00:00.000Z");
  assert.equal(compacted.createdAt, thread.createdAt, "still the same thread");
});

test("compacting twice accumulates the covered count", () => {
  const once = applyCompaction(
    session("/repo", [
      { at: "1", question: "q1", refs: [], answer: "a1" },
      { at: "2", question: "q2", refs: [], answer: "a2" },
    ]),
    "first summary",
  );
  const twice = applyCompaction(
    { ...once, turns: [...once.turns, { at: "3", question: "q3", refs: [], answer: "a3" }] },
    "second summary",
  );
  assert.equal(twice.turns[0]?.covers, 3, "2 covered + 1 new");
});

test("a summary is sent as a stated summary, not a fake exchange", () => {
  const compacted = applyCompaction(
    session("/repo", [{ at: "1", question: "q1", refs: [], answer: "a1" }]),
    "- decided X",
  );
  const withFollowUp: Session = {
    ...compacted,
    turns: [...compacted.turns, { at: "2", question: "q2", refs: [], answer: "a2" }],
  };

  assert.deepEqual(sessionMessages(withFollowUp), [
    { role: "user", content: "<conversation-summary>\n- decided X\n</conversation-summary>" },
    { role: "user", content: "q2" },
    { role: "assistant", content: "a2" },
  ]);
});

test("compaction shrinks the history token count", () => {
  const thread = session(
    "/repo",
    [1, 2, 3].map((index) => ({
      at: String(index),
      question: `question ${index} `.repeat(40),
      refs: [],
      answer: `answer ${index} `.repeat(40),
    })),
  );
  const before = sessionTokens(thread);
  const after = sessionTokens(applyCompaction(thread, "- three points, briefly"));
  assert.ok(after < before / 4, `expected a big reduction, got ${before} → ${after}`);
});

test("the compaction prompt includes every turn and its files", () => {
  const prompt = buildCompactionPrompt(
    session("/repo", [
      { at: "1", question: "what does chat.ts do?", refs: ["src/chat.ts"], answer: "one request" },
      { at: "2", question: "and refs.ts?", refs: [], answer: "resolution" },
    ]),
  );
  assert.match(prompt, /what does chat\.ts do\?/);
  assert.match(prompt, /files: src\/chat\.ts/);
  assert.match(prompt, /one request/);
  assert.match(prompt, /and refs\.ts\?/);
  assert.match(prompt, /Compact the thread above/);
});

test("reset also removes the pre-compaction backup", async () => {
  const { env } = await isolatedState();
  const key = { scope: "/repo/one", name: DEFAULT_SESSION_NAME, env };
  const thread = session("/repo/one", [
    { at: "1", question: "q", refs: [], answer: "a" },
  ]);

  await saveSession(thread, env);
  const backup = await backupSession(thread, env);
  assert.equal((await stat(backup)).mode & 0o777, 0o600);

  assert.equal(await resetSession(key), true);
  await assert.rejects(() => stat(backup), /ENOENT/, "backup cleared too");
});

test("a session file inside a repo can never be attached", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ask-session-skip-"));
  await mkdir(path.join(root, ".ask", "sessions"), { recursive: true });
  await writeFile(path.join(root, ".ask", "sessions", "thread.json"), '{"secret":"history"}');
  await writeFile(path.join(root, "real.ts"), "export const real = 1;\n");

  const context = await collectContext(["."], { cwd: root });
  assert.deepEqual(
    context.blocks.map((block) => block.path),
    ["real.ts"],
    ".ask is skipped, so the model never reads its own transcript back",
  );
});
