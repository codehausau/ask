// One-shot transport against any OpenAI-compatible /v1/chat/completions.
//
// Deliberately NOT an agent. The request type below *removes* every tool and
// streaming field from the SDK's params, so "we never send tools" is a compile
// error rather than a code-review promise. There is no loop in this module.

import OpenAI from "openai";
import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming,
} from "openai/resources/chat/completions";

export const DEFAULT_MODEL = "gpt-4o-mini";
export const DEFAULT_SYSTEM =
  "You are a precise senior engineer. Answer directly, no preamble. " +
  "Cite file paths and line context when you reference the supplied files.";

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
  readonly apiKey: string | undefined;
  readonly baseURL?: string | undefined;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
}

export interface BuildRequestOptions {
  readonly prompt: string;
  readonly model?: string;
  readonly system?: string;
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

export function createClient({
  apiKey,
  baseURL,
  timeoutMs = 120_000,
  maxRetries = 2,
}: ClientOptions): ChatClient {
  if (!apiKey) {
    throw new Error("no API key: set OPENAI_API_KEY (or pass --api-key)");
  }
  const client = new OpenAI({ apiKey, baseURL, timeout: timeoutMs, maxRetries });
  // Narrow the SDK down to the one call we make, so nothing else is reachable.
  return {
    chat: { completions: { create: (body) => client.chat.completions.create(body) } },
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
  maxTokens,
  temperature,
  baseURL,
  tokenField,
}: BuildRequestOptions): OneShotRequest {
  if (!prompt.trim()) throw new Error("empty prompt");

  const request: OneShotRequest = {
    model,
    messages: system
      ? [
          { role: "system", content: system },
          { role: "user", content: prompt },
        ]
      : [{ role: "user", content: prompt }],
  };

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

/** Send one request and return the answer. Never assumes optional fields. */
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
