// Suggesting the next command, without asking the model.
//
// A one-shot tool cannot take the next step itself, so the human is the loop.
// Everything here is computed from facts the CLI already has plus the answer it
// just received, checked against the filesystem — so a suggestion can be
// unhelpful but never wrong: a path that does not exist is never offered, and a
// flag that does not exist can never be invented.
//
// The division of labour is deliberate: these suggest *plumbing* (attach this,
// apply with /write, raise that cap). Only a model could suggest *intent*, and
// that would cost tokens on every request and need validating anyway.

import { shellQuote } from "./write.ts";

export interface Suggestion {
  /** A copy-pasteable command. */
  readonly command: string;
  /** Why it is being offered, shown in parentheses. */
  readonly why: string;
}

export interface NextFacts {
  readonly question: string;
  readonly answer: string;
  /** Files attached to this request, relative to cwd. */
  readonly attached: readonly string[];
  /** Existing files the answer named but that were not attached. */
  readonly mentioned: readonly string[];
  /** The answer stopped because it hit the token cap. */
  readonly hitTokenCap: boolean;
  /** Attached files were cut short by the context caps. */
  readonly contextTruncated: boolean;
  /** Tokens of history that will be resent next turn. */
  readonly sessionTokens: number;
  /** True when this run already wrote a file. */
  readonly wrote: boolean;
  /** The question reads like an instruction to change the file. */
  readonly editRequested: boolean;
  /** Output tokens this answer used, when the endpoint reported them. */
  readonly outputTokens: number | null;
}

/** Above this much history, resending it every turn is worth compacting. */
export const COMPACT_THRESHOLD_TOKENS = 8_000;

/** Fenced code blocks in the answer. An odd count means an unclosed fence. */
export function countCodeBlocks(answer: string): number {
  const fences = (answer.match(/^\s*```/gm) ?? []).length;
  return Math.floor(fences / 2);
}

/**
 * Path-like tokens in the answer. Only used as candidates: every one is checked
 * against the filesystem before it can be suggested.
 */
export function extractPathCandidates(answer: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();

  // URLs go first: the path pattern would otherwise match everything after the
  // scheme, turning https://example.com/docs/x.html into a "path".
  const text = answer.replace(/[a-z][\w+.-]*:\/\/\S+/gi, " ");

  // Either something containing a slash, or a bare filename with an extension
  // that looks like source. Backticks and quotes are common around both.
  const pattern = /[`'"(]?((?:[\w.@-]+\/)+[\w.-]+|[\w-]+\.[A-Za-z][\w]{0,7})[`'")]?/g;

  for (const match of text.matchAll(pattern)) {
    let candidate = match[1] ?? "";
    // Trailing sentence punctuation is not part of a path.
    candidate = candidate.replace(/[.,;:]+$/, "");

    if (candidate.length === 0 || candidate.length > 200) continue;
    if (/^[\d.]+$/.test(candidate)) continue; // a version number
    if (seen.has(candidate)) continue;

    seen.add(candidate);
    found.push(candidate);
  }

  return found;
}

/**
 * Build the suggestions. Ordered by usefulness, and capped by the caller —
 * three lines of advice after every answer would be noise.
 */
export function suggestNext(facts: NextFacts): Suggestion[] {
  const suggestions: Suggestion[] = [];

  // A truncated answer is the most actionable thing that can happen.
  if (facts.hitTokenCap) {
    const doubled = Math.max(2_000, (facts.outputTokens ?? 1_000) * 2);
    suggestions.push({
      command: `ask --max-tokens ${doubled} ${shellQuote(facts.question)}`,
      why: "the answer was cut off by the token cap",
    });
  }

  if (facts.contextTruncated) {
    suggestions.push({
      command: `ask --max-file-bytes 524288 ${shellQuote(facts.question)}`,
      why: "an attached file was truncated to fit the context caps",
    });
  }

  // Files the answer pointed at that the model could not actually see.
  if (facts.mentioned.length > 0) {
    const refs = [...facts.attached, ...facts.mentioned].map((file) => `@${file}`).join(" ");
    suggestions.push({
      command: `ask ${shellQuote(`${refs} ${facts.question}`.trim())}`,
      why: `${facts.mentioned.join(", ")} ${
        facts.mentioned.length === 1 ? "was" : "were"
      } mentioned but not attached`,
    });
  }

  // An edit that was asked for, answered with code, and not applied.
  const onlyFile = facts.attached.length === 1 ? facts.attached[0] : undefined;
  if (
    !facts.wrote &&
    facts.editRequested &&
    onlyFile !== undefined &&
    countCodeBlocks(facts.answer) === 1
  ) {
    suggestions.push({
      command: `ask /write ${shellQuote(onlyFile)} ${shellQuote(facts.question)}`,
      why: "nothing was written; /diff previews it first",
    });
  }

  if (facts.sessionTokens > COMPACT_THRESHOLD_TOKENS) {
    suggestions.push({
      command: "ask /compact",
      why: `~${facts.sessionTokens} tokens of history are resent every turn`,
    });
  }

  return suggestions;
}
