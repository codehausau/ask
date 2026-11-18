// One-shot transport against any OpenAI-compatible /v1/chat/completions.
//
// Deliberately NOT an agent. The request type below *removes* every tool and
// streaming field from the SDK's params, so "we never send tools" is a compile
// error rather than a code-review promise. There is no loop in this module.

import OpenAI from "openai";
import { DEFAULT_RESPONSE_TIMEOUT_MS } from "./timeout.ts";
import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming,
} from "openai/resources/chat/completions";

export const DEFAULT_MODEL = "gpt-4o-mini";
/**
 * The model is told its own situation, because not knowing it produces useless
 * answers: "let me check refs.ts" or a clarifying question, neither of which can
 * be acted on when there is no turn the model controls.
 *
 * Asking it to name paths plainly also feeds the next-command suggestions, which
 * look for files the answer mentioned but that were never attached.
 */
export const DEFAULT_SYSTEM =
  "You are a precise senior engineer answering in a single shot. You cannot run " +
  "commands, read files you were not given, or ask a question and receive an " +
  "answer: there is no further turn under your control. " +
  "Answer directly, with no preamble. Cite file paths and line context for the " +
  "files you were given. " +
  "If the answer depends on a file you cannot see, name its path plainly so it " +
  "can be attached and the question asked again. " +
  "If something is genuinely ambiguous, state the assumption you are proceeding " +
  "on rather than asking a question.";

/** The only fields this tool is allowed to send. */
export type OneShotRequest = Omit<
  ChatCompletionCreateParamsNonStreaming,
  | "tools"
  | "tool_choice"
  | "functions"
  | "function_call"
  | "parallel_tool_calls"
  | "stream"
  | "stream_options"
>;

/** The single SDK method this tool uses; lets tests inject a stub. */
export interface ChatClient {
  readonly chat: {
    readonly completions: {
      create(body: OneShotRequest): Promise<ChatCompletion>;
    };
  };
}

export type TokenField = "max_tokens" | "max_completion_tokens";

export interface ClientOptions {
  /** Optional only for loopback endpoints, which ignore it. */
  apiKey: string | undefined;
  readonly baseURL?: string | undefined;
  readonly organization?: string | undefined;
  readonly project?: string | undefined;
  readonly timeoutMs?: number;
  /** SDK transport retries of the same request body; defaults to two in both UIs. */
  readonly maxRetries?: number;
  /** A TUI lifetime signal cancels an in-flight request on exit. */
  readonly signal?: AbortSignal;
}

export interface HistoryMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
}

export interface BuildRequestOptions {
  readonly prompt: string;
  readonly model?: string;
  readonly system?: string;
  /** Prior turns, oldest first. One logical completion, including transport retries. */
  readonly history?: readonly HistoryMessage[];
  readonly maxTokens?: number | undefined;
  readonly temperature?: number | undefined;
  readonly baseURL?: string | undefined;
  readonly tokenField?: TokenField | undefined;
}

export interface AskResult {
  readonly text: string;
  readonly model: string;
  readonly finishReason: string | null;
  readonly usage: { readonly input: number | null; readonly output: number | null };
}

/**
 * Local servers (Ollama, llama.cpp, LM Studio, vLLM on localhost) ignore the
 * Authorization header, but the SDK insists on something being set. Treat a
 * loopback endpoint as key-free rather than making people invent a dummy value.
 */
export function isLoopbackEndpoint(baseURL: string | undefined): boolean {
  if (!baseURL) return false;
  try {
    const { hostname } = new URL(baseURL);
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "[::1]" ||
      hostname === "::1" ||
      hostname.endsWith(".localhost")
    );
  } catch {
    return false;
  }
}

/** HTTP is unencrypted; only recognised loopback endpoints are exempt by default. */
export function isInsecureHttpEndpoint(baseURL: string | undefined): boolean {
  if (baseURL === undefined) return false;
  try {
    return new URL(baseURL).protocol === "http:" && !isLoopbackEndpoint(baseURL);
  } catch {
    // Malformed endpoint URLs are rejected by the SDK when building the request.
    return false;
  }
}

export function createClient({
  apiKey,
  baseURL,
  organization,
  project,
  timeoutMs = DEFAULT_RESPONSE_TIMEOUT_MS,
  maxRetries = 2,
  signal,
}: ClientOptions): ChatClient {
  if (!apiKey && isLoopbackEndpoint(baseURL)) {
    apiKey = "local";
  }
  if (!apiKey) {
    throw new Error("no API key: set OPENAI_API_KEY (or pass --api-key)");
  }
  // Pass every connection value explicitly: the SDK would otherwise read
  // OPENAI_* variables itself, bypassing the configuration's precedence.
  const client = new OpenAI({
    apiKey, baseURL: baseURL ?? "https://api.openai.com/v1",
    organization: organization ?? null, project: project ?? null,
    timeout: timeoutMs, maxRetries,
  });
  // Narrow the SDK down to the one call we make, so nothing else is reachable.
  return {
    chat: { completions: { create: (body) => client.chat.completions.create(body, { signal }) } },
  };
}

/**
 * Newer OpenAI models reject `max_tokens` and require `max_completion_tokens`,
 * while most OpenAI-compatible gateways only understand `max_tokens`.
 * Pick by endpoint; `override` wins when a gateway disagrees.
 */
export function tokenLimitField(
  baseURL: string | undefined,
  override?: TokenField | undefined,
): TokenField {
  if (override) return override;
  if (!baseURL) return "max_completion_tokens";
  try {
    return new URL(baseURL).host === "api.openai.com"
      ? "max_completion_tokens"
      : "max_tokens";
  } catch {
    return "max_tokens";
  }
}

/** Build the exact JSON body. Pure, so tests can assert on it. */
export function buildRequest({
  prompt,
  model = DEFAULT_MODEL,
  system = DEFAULT_SYSTEM,
  history = [],
  maxTokens,
  temperature,
  baseURL,
  tokenField,
}: BuildRequestOptions): OneShotRequest {
  if (!prompt.trim()) throw new Error("empty prompt");

  const messages: OneShotRequest["messages"] = [];
  if (system) messages.push({ role: "system", content: system });
  for (const message of history) {
    messages.push(
      message.role === "assistant"
        ? { role: "assistant", content: message.content }
        : { role: "user", content: message.content },
    );
  }
  messages.push({ role: "user", content: prompt });

  const request: OneShotRequest = { model, messages };

  if (typeof maxTokens === "number" && Number.isFinite(maxTokens)) {
    if (tokenLimitField(baseURL, tokenField) === "max_tokens") {
      request.max_tokens = maxTokens;
    } else {
      request.max_completion_tokens = maxTokens;
    }
  }
  if (typeof temperature === "number" && Number.isFinite(temperature)) {
    request.temperature = temperature;
  }
  return request;
}

/** Request one logical completion and return the answer. The SDK may retry the
 * same body on transient transport failures; it never creates a follow-up turn.
 */
export async function askOnce(client: ChatClient, request: OneShotRequest): Promise<AskResult> {
  const completion = await client.chat.completions.create(request);
  const choice = completion.choices?.[0];
  const message = choice?.message;
  const text = (message?.refusal ?? message?.content ?? "").trim();

  if (!text) {
    throw new Error(
      `model returned no text (finish_reason=${choice?.finish_reason ?? "unknown"})`,
    );
  }
  return {
    text,
    model: completion.model || request.model,
    finishReason: choice?.finish_reason ?? null,
    usage: {
      input: completion.usage?.prompt_tokens ?? null,
      output: completion.usage?.completion_tokens ?? null,
    },
  };
}
