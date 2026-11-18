import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { askOnce, buildRequest, createClient } from "../src/chat.ts";
import { responseTimeoutMs } from "../src/timeout.ts";

test("request timeout defaults to two minutes and flags override exported seconds", () => {
  assert.equal(responseTimeoutMs(undefined, {}), 120_000);
  assert.equal(responseTimeoutMs(undefined, { ASK_TIMEOUT: "300" }), 300_000);
  assert.equal(responseTimeoutMs("30", { ASK_TIMEOUT: "invalid" }), 30_000);
  assert.equal(responseTimeoutMs("0.025", {}), 25);
});

test("invalid timeouts fail rather than silently disabling the timeout", () => {
  for (const raw of ["", " ", "0", "-1", "NaN", "Infinity", "oops", "0.0001", "2147483.648", "1e99"]) {
    assert.throws(() => responseTimeoutMs(raw, {}), /--timeout must be positive seconds/);
    assert.throws(() => responseTimeoutMs(undefined, { ASK_TIMEOUT: raw }), /ASK_TIMEOUT must be positive seconds/);
  }
});

test("configured timeout aborts a stalled provider when retries are explicitly disabled", async () => {
  let requests = 0;
  const server = createServer(() => { requests++; });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const client = createClient({
      apiKey: undefined,
      baseURL: `http://127.0.0.1:${address.port}/v1`,
      timeoutMs: responseTimeoutMs("0.2", {}), maxRetries: 0,
    });
    await assert.rejects(askOnce(client, buildRequest({ prompt: "Hello" })), /Request timed out/);
    assert.equal(requests, 1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("shared CLI/TUI transport retries the identical body at most twice on transient failures", async () => {
  const requests = new Map<string, string[]>();
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    const route = request.url!;
    const attempts = requests.get(route) ?? [];
    attempts.push(body);
    requests.set(route, attempts);
    const success = route.startsWith("/recover/") && attempts.length === 3;
    response.writeHead(success ? 200 : route.startsWith("/unauthorized/") ? 401 : 503, {
      "content-type": "application/json", "retry-after-ms": "1",
    });
    response.end(JSON.stringify(success
      ? { choices: [{ message: { content: "Recovered" }, finish_reason: "stop" }] }
      : { error: { message: "Temporary failure" } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const request = buildRequest({ prompt: "CURRENT_CONTENT", system: "SYSTEM_CONTENT", history: [{ role: "user", content: "HISTORY_CONTENT" }], model: "test", temperature: 0.2 });
    for (const [route, expectedAttempts] of [["recover", 3], ["exhausted", 3], ["unauthorized", 1]] as const) {
      const client = createClient({ apiKey: undefined, baseURL: `http://127.0.0.1:${address.port}/${route}/v1` });
      if (route === "recover") assert.equal((await askOnce(client, request)).text, "Recovered");
      else await assert.rejects(askOnce(client, request), /Temporary failure/);
      const attempts = requests.get(`/${route}/v1/chat/completions`)!;
      assert.equal(attempts.length, expectedAttempts);
      assert.equal(new Set(attempts).size, 1, "transport retries must not append turns or change message content");
      assert.deepEqual(JSON.parse(attempts[0]!), request);
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("the TUI lifetime signal cancels SDK retries on exit", async () => {
  const lifetime = new AbortController();
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.writeHead(503, { "retry-after-ms": "1000" });
    response.end("Unavailable");
    lifetime.abort();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const client = createClient({ apiKey: undefined, baseURL: `http://127.0.0.1:${address.port}/v1`, signal: lifetime.signal });
    await assert.rejects(askOnce(client, buildRequest({ prompt: "Hello" })), /abort/i);
    assert.equal(requests, 1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
