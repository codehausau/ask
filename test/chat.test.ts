import assert from "node:assert/strict";
import test from "node:test";
import type { ChatCompletion } from "openai/resources/chat/completions";

import {
  askOnce,
  buildRequest,
  tokenLimitField,
  type ChatClient,
  type OneShotRequest,
} from "../src/chat.ts";

interface Capture {
  count: number;
  request?: OneShotRequest;
}

function stubClient(
  response: Partial<ChatCompletion>,
): { client: ChatClient; capture: Capture } {
  const capture: Capture = { count: 0 };
  const client: ChatClient = {
    chat: {
      completions: {
        create: async (request) => {
          capture.count += 1;
          capture.request = request;
          return response as ChatCompletion;
        },
      },
    },
  };
  return { client, capture };
}

test("request carries no tool or streaming affordances", () => {
  const request = buildRequest({ prompt: "hi", model: "gpt-4o-mini" });
  // Compile-time guarantee too: OneShotRequest omits these keys entirely, so
  // `request.tools = ...` would not type-check.
  for (const forbidden of ["tools", "tool_choice", "functions", "function_call", "stream"]) {
    assert.equal(forbidden in request, false, `${forbidden} must not be sent`);
  }
});

test("request is a system + single user message", () => {
  const request = buildRequest({ prompt: "review this", system: "be terse", model: "m" });
  assert.deepEqual(request.messages, [
    { role: "system", content: "be terse" },
    { role: "user", content: "review this" },
  ]);
});

test("empty system prompt is omitted", () => {
  const request = buildRequest({ prompt: "p", system: "", model: "m" });
  assert.equal(request.messages.length, 1);
  assert.equal(request.messages[0]?.role, "user");
});

test("temperature and token cap are only sent when set", () => {
  const bare = buildRequest({ prompt: "p", model: "m" });
  assert.equal("temperature" in bare, false);
  assert.equal("max_tokens" in bare, false);
  assert.equal("max_completion_tokens" in bare, false);

  const tuned = buildRequest({ prompt: "p", model: "m", temperature: 0, maxTokens: 64 });
  assert.equal(tuned.temperature, 0);
  assert.equal(tuned.max_completion_tokens, 64);

  const gateway = buildRequest({
    prompt: "p",
    model: "m",
    maxTokens: 64,
    baseURL: "http://localhost:11434/v1",
  });
  assert.equal(gateway.max_tokens, 64);
  assert.equal("max_completion_tokens" in gateway, false);
});

test("token limit field follows the endpoint", () => {
  assert.equal(tokenLimitField(undefined), "max_completion_tokens");
  assert.equal(tokenLimitField("https://api.openai.com/v1"), "max_completion_tokens");
  assert.equal(tokenLimitField("http://localhost:11434/v1"), "max_tokens");
  assert.equal(tokenLimitField("https://openrouter.ai/api/v1"), "max_tokens");
  assert.equal(tokenLimitField("not a url"), "max_tokens");
  assert.equal(tokenLimitField("https://api.openai.com/v1", "max_tokens"), "max_tokens");
});

test("empty prompt is rejected before any request", () => {
  assert.throws(() => buildRequest({ prompt: "   " }), /empty prompt/);
});

test("askOnce issues exactly one request and returns the answer", async () => {
  const { client, capture } = stubClient({
    model: "gpt-4o-mini-2024",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "  looks fine  ", refusal: null },
        finish_reason: "stop",
        logprobs: null,
      },
    ],
    usage: { prompt_tokens: 120, completion_tokens: 8, total_tokens: 128 },
  });

  const result = await askOnce(client, buildRequest({ prompt: "p", model: "gpt-4o-mini" }));

  assert.equal(capture.count, 1, "exactly one API call — no agent loop");
  assert.equal(result.text, "looks fine");
  assert.equal(result.model, "gpt-4o-mini-2024");
  assert.equal(result.finishReason, "stop");
  assert.deepEqual(result.usage, { input: 120, output: 8 });
});

test("askOnce surfaces a refusal as text", async () => {
  const { client } = stubClient({
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: null, refusal: "I can't help with that" },
        finish_reason: "stop",
        logprobs: null,
      },
    ],
  });
  const result = await askOnce(client, buildRequest({ prompt: "p" }));
  assert.equal(result.text, "I can't help with that");
});

test("askOnce tolerates a missing usage block", async () => {
  const { client } = stubClient({
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "ok", refusal: null },
        finish_reason: "stop",
        logprobs: null,
      },
    ],
  });
  const result = await askOnce(client, buildRequest({ prompt: "p", model: "fallback" }));
  assert.deepEqual(result.usage, { input: null, output: null });
  assert.equal(result.model, "fallback", "falls back to the requested model");
});

test("askOnce errors when the model returns nothing", async () => {
  const { client } = stubClient({
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "", refusal: null },
        finish_reason: "length",
        logprobs: null,
      },
    ],
  });
  await assert.rejects(
    () => askOnce(client, buildRequest({ prompt: "p" })),
    /no text \(finish_reason=length\)/,
  );
});
