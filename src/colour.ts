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

/**
 * Attribute-specific resets, so nested styling composes: a coloured span inside
 * a bold heading must end the colour without also ending the bold, which a
 * blanket \u001b[0m would do.
 */
const RESET_INTENSITY = "\u001b[22m"; // ends bold and dim
const RESET_COLOUR = "\u001b[39m"; // back to the default foreground

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
    (code: string, reset: string) =>
    (text: string): string =>
      `${code}${text}${reset}`;

  return {
    enabled: true,
    dim: wrap("\u001b[2m", RESET_INTENSITY),
    bold: wrap("\u001b[1m", RESET_INTENSITY),
    red: wrap("\u001b[31m", RESET_COLOUR),
    yellow: wrap("\u001b[33m", RESET_COLOUR),
    cyan: wrap("\u001b[36m", RESET_COLOUR),
  };
}

/** Palette that emits nothing, for non-interactive paths and tests. */
export const NO_COLOUR: Palette = createPalette(false);
