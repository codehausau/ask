// Shell integration installer.
//
// Exists because "add this line to your ~/.bashrc" invites path mistakes: a
// `$PWD` that was not what you thought leaves a dead `source` line that errors
// on every new shell. `ask --install-completion` resolves the absolute path
// itself, and `--apply` rewrites the block idempotently, clearing stale lines
// from earlier attempts.

import { access, constants } from "node:fs/promises";
import path from "node:path";

const BEGIN = "# >>> ask completion >>>";
const END = "# <<< ask completion <<<";

/** Any line that tried to load a copy of the completion script. */
const STALE_SOURCE = /completions\/ask\.bash/;
const STALE_AT_KEY = /^\s*export\s+ASK_AT_KEY=/;

/** Comment headers a previous hand-written attempt left behind. */
const ORPHAN_COMMENT = /^\s*#.*\bask\b.*(picker|completion|ASK_AT_KEY|command line)/i;

/** The block to add to a shell rc file. */
export function completionSnippet(scriptPath: string): string {
  return [
    BEGIN,
    "# Managed by `ask --install-completion`. Edit above or below, not inside.",
    "# ASK_AT_KEY=1 makes typing `@` open the file picker on an `ask` command",
    "# line; `@` stays literal everywhere else. Set to 0 to disable.",
    "export ASK_AT_KEY=1",
    `[ -f "${scriptPath}" ] && source "${scriptPath}"`,
    END,
  ].join("\n");
}

export interface RcUpdate {
  readonly text: string;
  /** False when the file already said exactly this. */
  readonly changed: boolean;
  /** Stale lines cleared from previous, hand-written attempts. */
  readonly removedStale: number;
  /** True when a previously managed block was replaced. */
  readonly replacedBlock: boolean;
}

/**
 * Insert or refresh the managed block. Removes any previous managed block plus
 * loose `source .../completions/ask.bash` and `export ASK_AT_KEY=` lines, so a
 * wrong path from an earlier attempt cannot linger.
 */
export function applyToRc(rcText: string, scriptPath: string): RcUpdate {
  const lines = rcText.split("\n");
  const kept: string[] = [];

  let insideBlock = false;
  let replacedBlock = false;
  let removedStale = 0;

  for (const line of lines) {
    if (line.trim() === BEGIN) {
      insideBlock = true;
      replacedBlock = true;
      continue;
    }
    if (insideBlock) {
      if (line.trim() === END) insideBlock = false;
      continue;
    }
    if (STALE_SOURCE.test(line) || STALE_AT_KEY.test(line)) {
      removedStale += 1;
      continue;
    }
    kept.push(line);
  }

  // Trailing blanks first, or they hide the comment header below.
  while (kept.length > 0 && (kept[kept.length - 1] ?? "").trim() === "") kept.pop();

  // Then the hand-written comment header those lines used to sit under.
  let guard = 0;
  while (kept.length > 0 && guard < 5 && ORPHAN_COMMENT.test(kept[kept.length - 1] ?? "")) {
    kept.pop();
    removedStale += 1;
    guard += 1;
  }

  const body = kept.join("\n").replace(/\n+$/, "");
  const snippet = completionSnippet(scriptPath);
  const text = body.length > 0 ? `${body}\n\n${snippet}\n` : `${snippet}\n`;

  return { text, changed: text !== rcText, removedStale, replacedBlock };
}

/**
 * Find an executable on PATH without spawning it — the `@` picker silently
 * degrades to a literal `@` when fzf is missing, which is confusing enough to
 * be worth reporting during setup.
 */
export async function findExecutable(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  canExecute: (file: string) => Promise<boolean> = defaultCanExecute,
): Promise<string | null> {
  for (const dir of (env["PATH"] ?? "").split(path.delimiter)) {
    if (dir.length === 0) continue;
    const candidate = path.join(dir, name);
    if (await canExecute(candidate)) return candidate;
  }
  return null;
}

async function defaultCanExecute(file: string): Promise<boolean> {
  try {
    await access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** One line on whether the interactive picker will actually work. */
export function pickerStatus(fzfPath: string | null): string {
  return fzfPath === null
    ? "fzf: not found — '@' stays literal and TAB completion works;\n" +
        "     install fzf (apt-get install fzf / brew install fzf) for the picker\n"
    : `fzf: ${fzfPath} — typing '@' on an ask line opens the picker\n`;
}

/** Human-readable instructions for the print-only path. */
export function installInstructions(scriptPath: string, rcPath: string): string {
  return (
    `Add this to ${rcPath}, then run 'exec bash':\n\n` +
    `${completionSnippet(scriptPath)}\n\n` +
    `Or let ask do it:  ask --install-completion --apply\n\n` +
    `zsh: add 'autoload -U +X bashcompinit && bashcompinit' before the source line.\n`
  );
}
