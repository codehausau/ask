// Progress spinner for the wait on a single request.
//
// Interactive only: it writes to stderr and animates solely when stderr is a
// terminal, so piped output and CI logs stay clean. The cursor is never hidden,
// so a Ctrl-C mid-request cannot leave the terminal in a bad state.

export interface SpinnerStream {
  write(chunk: string): unknown;
  readonly isTTY?: boolean | undefined;
}

export interface SpinnerOptions {
  readonly label: string;
  /** Wraps the rendered frame, e.g. to dim it. Defaults to no styling. */
  readonly style?: (text: string) => string;
  readonly stream?: SpinnerStream;
  /** Overrides the terminal and environment checks. */
  readonly enabled?: boolean;
  readonly intervalMs?: number;
  readonly frames?: readonly string[];
  readonly now?: () => number;
  readonly env?: NodeJS.ProcessEnv;
}

export interface Spinner {
  /** Advance one frame. Called by the timer; exposed so tests need no clock. */
  tick(): void;
  /** Erase the line. Safe to call more than once. */
  stop(): void;
  readonly animating: boolean;
}

const BRAILLE = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const ASCII = ["-", "\\", "|", "/"] as const;

/** Erase from the cursor to the end of line, leaving the cursor at column 0. */
const CLEAR_LINE = "\r\u001b[K";

/**
 * Animate only for a human at a terminal. `ASK_SPINNER=0`, a dumb terminal, or
 * a CI environment all opt out.
 */
export function shouldAnimate(
  stream: SpinnerStream | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!stream?.isTTY) return false;
  if (env["ASK_SPINNER"] === "0") return false;
  if (env["TERM"] === "dumb" || env["TERM"] === undefined) return false;
  if (env["CI"] !== undefined && env["CI"] !== "" && env["CI"] !== "false") return false;
  return true;
}

/** Braille needs a UTF-8 locale; fall back to ASCII rather than print mojibake. */
export function pickFrames(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  if (env["ASK_SPINNER"] === "ascii") return ASCII;
  const locale = env["LC_ALL"] ?? env["LC_CTYPE"] ?? env["LANG"] ?? "";
  return /utf-?8/i.test(locale) ? BRAILLE : ASCII;
}

/** One frame of output, e.g. `⠙ asking gpt-4o-mini… 2.4s`. */
export function renderFrame(
  frame: string,
  label: string,
  elapsedMs: number,
  style: (text: string) => string = (text) => text,
): string {
  const seconds = (elapsedMs / 1000).toFixed(1);
  // The erase stays outside the styling, so a reset cannot swallow it.
  return `${CLEAR_LINE}${style(`${frame} ${label}… ${seconds}s`)}`;
}

/**
 * Start a spinner. When animation is disabled the returned spinner is inert, so
 * callers never have to branch on it.
 */
export function startSpinner(options: SpinnerOptions): Spinner {
  const env = options.env ?? process.env;
  const stream = options.stream;
  const animating = options.enabled ?? shouldAnimate(stream, env);

  if (!animating || !stream) {
    return { tick: () => {}, stop: () => {}, animating: false };
  }

  const frames = options.frames ?? pickFrames(env);
  const now = options.now ?? Date.now;
  const started = now();
  let index = 0;
  let stopped = false;

  const tick = (): void => {
    if (stopped) return;
    const frame = frames[index % frames.length] ?? "";
    index += 1;
    stream.write(renderFrame(frame, options.label, now() - started, options.style));
  };

  tick();
  const timer = setInterval(tick, options.intervalMs ?? 90);
  // Never hold the process open on account of the animation.
  if (typeof timer.unref === "function") timer.unref();

  return {
    tick,
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      stream.write(CLEAR_LINE);
    },
    get animating() {
      return !stopped;
    },
  };
}
