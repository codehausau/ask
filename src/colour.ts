// Colour for status output only.
//
// The model's answer is never coloured: it goes to stdout and is routinely
// piped, redirected or pasted, where escape codes are a liability. Everything
// ask says *about* the request — resolution notes, the footer, warnings,
// errors, the spinner — is dimmed or tinted on stderr, which is what separates
// the two visually.
//
// Honours https://no-color.org, FORCE_COLOR, TERM=dumb, and only colours a
// stream that is actually a terminal.

export interface ColourStream {
  readonly isTTY?: boolean | undefined;
}

export interface Palette {
  readonly enabled: boolean;
  dim(text: string): string;
  bold(text: string): string;
  red(text: string): string;
  yellow(text: string): string;
  cyan(text: string): string;
}

const RESET = "\u001b[0m";

/**
 * Whether to emit escape codes for `stream`.
 *
 * NO_COLOR wins over FORCE_COLOR: a user who has globally opted out should not
 * be overridden by an environment variable a tool set for its own reasons.
 */
export function supportsColour(
  stream: ColourStream | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const noColour = env["NO_COLOR"];
  if (noColour !== undefined && noColour !== "") return false;

  const force = env["FORCE_COLOR"];
  if (force !== undefined) return force !== "0" && force !== "";

  if (env["TERM"] === "dumb" || env["TERM"] === undefined) return false;
  return stream?.isTTY === true;
}

export function createPalette(enabled: boolean): Palette {
  if (!enabled) {
    const plain = (text: string): string => text;
    return { enabled: false, dim: plain, bold: plain, red: plain, yellow: plain, cyan: plain };
  }
  const wrap =
    (code: string) =>
    (text: string): string =>
      `${code}${text}${RESET}`;

  return {
    enabled: true,
    dim: wrap("\u001b[2m"),
    bold: wrap("\u001b[1m"),
    red: wrap("\u001b[31m"),
    yellow: wrap("\u001b[33m"),
    cyan: wrap("\u001b[36m"),
  };
}

/** Palette that emits nothing, for non-interactive paths and tests. */
export const NO_COLOUR: Palette = createPalette(false);
