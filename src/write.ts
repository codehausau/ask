// Writing a model response back to a file.
//
// This is the only feature that modifies your source tree, so it is built to
// refuse rather than risk it. The model never decides to write — you pass
// --write, exactly one file is in play, and every check below must pass first.
//
// The failure that matters most: a response truncated by a token cap would
// silently chop the end off your file. That is a hard refusal, not a warning.

export interface FenceResult {
  readonly content: string;
  /** True when a wrapping ``` fence was removed. */
  readonly strippedFence: boolean;
}

/**
 * Models wrap file contents in a fence even when told not to. Strip it only
 * when the *entire* response is one fenced block, so a file that legitimately
 * contains fences (like this project's README) is left alone.
 */
export function stripCodeFence(text: string): FenceResult {
  const trimmed = text.trim();
  const match = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(trimmed);
  if (!match) return { content: text, strippedFence: false };

  const inner = match[1] ?? "";
  // A second fence opening inside means the response was multiple blocks, or
  // prose plus a block; too ambiguous to guess at.
  if (/^```/m.test(inner)) return { content: text, strippedFence: false };

  return { content: inner, strippedFence: true };
}

export interface WriteTargetPath {
  /** Path named on the command line. */
  readonly target: string;
  readonly exists: boolean;
  readonly isFile: boolean;
}

/**
 * Checks on the path alone, run before context is even collected so that a
 * missing target reports "use /create" rather than a reference-resolution error.
 */
export function checkWriteTargetPath(input: WriteTargetPath): string[] {
  if (input.target.trim().length === 0) {
    return ["/write needs a path, e.g. /write src/chat.ts 'add a docstring'"];
  }
  if (!input.exists) {
    return [`${input.target} does not exist; use /create to write a new file`];
  }
  if (!input.isFile) {
    return [`${input.target} is not a regular file`];
  }
  return [];
}

export interface WriteTargetContext {
  readonly target: string;
  /** True when the target's contents reached the prompt. */
  readonly attached: boolean;
  /** True when the target was truncated to fit the context caps. */
  readonly truncated: boolean;
}

/**
 * Checks once context exists. The target is named explicitly rather than
 * inferred, so other attached files are read-only references and their number
 * is irrelevant.
 */
export function checkWriteTargetContext(input: WriteTargetContext): string[] {
  const problems: string[] = [];

  if (!input.attached) {
    // A target excluded by the skip rules (a .env, a lockfile, something
    // binary) would be rewritten from contents the model never saw.
    problems.push(
      `${input.target} was not attached, so the model cannot see it ` +
        "(the skip rules exclude credentials, lockfiles and binaries; --include-secrets may help)",
    );
  }
  if (input.truncated) {
    problems.push(
      `${input.target} was truncated to fit the context caps, so the model never saw all of it; ` +
        "raise --max-file-bytes or split the file",
    );
  }
  return problems;
}

export interface WriteResultInput {
  readonly original: string;
  readonly proposed: string;
  /** finish_reason from the endpoint. */
  readonly finishReason: string | null;
  /** Fraction of the original size below which a write is refused. */
  readonly shrinkFloor?: number;
}

/** Checks on the response itself. Returns reasons to refuse. */
export function checkWriteResponse(input: WriteResultInput): string[] {
  const problems: string[] = [];
  const floor = input.shrinkFloor ?? 0.25;

  if (input.finishReason === "length") {
    // The single most dangerous case: the tail of the file is simply missing.
    problems.push(
      "the response hit the token cap and is incomplete; writing it would truncate the file " +
        "(raise --max-tokens)",
    );
  }
  if (input.proposed.trim().length === 0) {
    problems.push("the model returned nothing to write");
  }

  const originalBytes = Buffer.byteLength(input.original, "utf8");
  const proposedBytes = Buffer.byteLength(input.proposed, "utf8");
  if (originalBytes > 0 && proposedBytes < originalBytes * floor) {
    const percent = Math.round((proposedBytes / originalBytes) * 100);
    problems.push(
      `the response is ${percent}% of the original size, which looks like a partial answer ` +
        "rather than an edit (--force to write it anyway)",
    );
  }
  return problems;
}

export interface ChangeSummary {
  readonly beforeBytes: number;
  readonly afterBytes: number;
  readonly beforeLines: number;
  readonly afterLines: number;
}

export function summariseChange(before: string, after: string): ChangeSummary {
  return {
    beforeBytes: Buffer.byteLength(before, "utf8"),
    afterBytes: Buffer.byteLength(after, "utf8"),
    beforeLines: before.length === 0 ? 0 : before.split("\n").length,
    afterLines: after.length === 0 ? 0 : after.split("\n").length,
  };
}

/** System prompt for write mode: the whole file, nothing else. */
export const WRITE_SYSTEM =
  "You edit a single source file. Output the complete updated contents of the " +
  "file and nothing else: no explanation, no commentary, no markdown code " +
  "fence. Preserve the file's existing style, indentation, and trailing " +
  "newline convention. Make only the changes the request asks for; leave every " +
  "other line byte-identical. If the request cannot be satisfied, output the " +
  "file unchanged.";

/** System prompt for `/create`: a whole new file, nothing else. */
export const CREATE_SYSTEM =
  "You write one new source file. Output the complete contents of that file and " +
  "nothing else: no explanation, no commentary, no markdown code fence. Match " +
  "the conventions of any files supplied as context — language, style, " +
  "indentation, naming, import order, comment density. End with a single " +
  "trailing newline.";

export interface CreateRequestInput {
  /** Path as given on the command line. */
  readonly target: string;
  /** True when something already exists at that path. */
  readonly exists: boolean;
  /** True when the containing directory exists. */
  readonly parentExists: boolean;
  /** True when --write or --diff was also passed. */
  readonly withEditFlags: boolean;
}

/**
 * Checks before spending tokens. Creating a file destroys nothing, so the only
 * hazards are clobbering an existing file and conjuring directories.
 */
export function checkCreateRequest(input: CreateRequestInput): string[] {
  const problems: string[] = [];

  if (input.target.trim().length === 0) {
    problems.push("/create needs a path, e.g. /create test/env.test.ts");
  }
  if (input.exists) {
    problems.push(`${input.target} already exists; use /write to change a file in place`);
  }
  if (!input.parentExists) {
    problems.push(
      `the directory for ${input.target} does not exist; create it first ` +
        "(directories are never created implicitly)",
    );
  }
  if (input.withEditFlags) {
    problems.push("/create does not combine with /write or /diff");
  }
  return problems;
}

/**
 * Checks on the response. No shrink test applies: there is no original to
 * compare against, which is precisely why creating is the safer operation.
 */
export function checkCreateResponse(proposed: string, finishReason: string | null): string[] {
  const problems: string[] = [];

  if (finishReason === "length") {
    problems.push(
      "the response hit the token cap and is incomplete; the file would be cut off " +
        "(raise --max-tokens)",
    );
  }
  if (proposed.trim().length === 0) {
    problems.push("the model returned nothing to write");
  }
  return problems;
}
