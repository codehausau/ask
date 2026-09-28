#!/usr/bin/env node
// ask — attach files/directories as context, ask one question, print one answer.
//
//   ask '@src/cli.ts review this file for me'
//   ask '@src @test where is the loop?'
//   git diff | ask 'review this diff'
//
// No tools, no agent loop, no follow-up turns: exactly one HTTP request.

import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  askOnce,
  buildRequest,
  createClient,
  isLoopbackEndpoint,
  DEFAULT_MODEL,
  DEFAULT_SYSTEM,
  type TokenField,
} from "./chat.ts";
import { collectContext, extractRefs, renderPrompt, type ContextResult } from "./context.ts";
import { createPalette, NO_COLOUR, supportsColour, type Palette } from "./colour.ts";
import { gitDiffNoIndex, gitFileState } from "./git.ts";
import { applyEnvFiles, describeEnvFiles } from "./env.ts";
import { applyToRc, findExecutable, installInstructions, pickerStatus } from "./install.ts";
import {
  discoverSkills,
  filterSkills,
  loadSkill,
  renderSkills,
  resolveSkill,
  skillSearchPaths,
  SkillResolutionError,
  type LoadedSkill,
} from "./skills.ts";
import { startSpinner } from "./spinner.ts";
import {
  checkCreateRequest,
  checkCreateResponse,
  CREATE_SYSTEM,
  checkWriteTargetContext,
  checkWriteTargetPath,
  looksLikeEdit,
  shellQuote,
  checkWriteResponse,
  stripCodeFence,
  summariseChange,
  WRITE_SYSTEM,
} from "./write.ts";
import { OPTIONS, VERBS, VERBS_WITH_VALUE } from "./options.ts";
import { RefResolutionError, repairSpacedRefs, resolveRef } from "./refs.ts";
import {
  appendTurn,
  applyCompaction,
  archiveSession,
  isValidSessionName,
  listSessions,
  resolveSessionName,
  writeCurrentSession,
  backupSession,
  buildCompactionPrompt,
  COMPACT_SYSTEM,
  DEFAULT_SESSION_MAX_TOKENS,
  DEFAULT_SESSION_TTL_MS,
  estimateTokens,
  loadSession,
  pruneSession,
  resetSession,
  saveSession,
  sessionLabel,
  sessionMessages,
  sessionPath,
  sessionRefs,
  sessionScope,
  sessionSkills,
  sessionTokens,
  sessionUsage,
  type Session,
} from "./session.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const USAGE = `ask — one-shot LLM question with file/directory context

Usage
  ask [options] '<prompt with @file, @dir, @glob or @search references>'
  ask /new | /reset | /session
  <command> | ask [options] '<prompt>'

Editing a file
  With exactly one file attached, /write (or --write) replaces it with the
  model's answer, and /diff (or --diff) previews that without writing.
  /create <path> writes a new file instead, and refuses if it already exists;
  unlike /write it accepts any amount of context. Refused if the file is not tracked
  and clean in git (--force overrides), if the file was truncated to fit the
  context, or if the answer hit the token cap.

Skills
  A skill is a directory with a SKILL.md holding reusable instructions. They are
  looked for in $ASK_SKILLS_DIR, ./.ask/skills, ./.agents/skills,
  ~/.config/ask/skills and ~/.claude/skills. Only SKILL.md is read; bundled
  assets are ignored. The skill is chosen here, never by the model.

Sessions
  Interactive runs continue the previous conversation for this repository,
  so a follow-up needs no @references. Piped runs are always one-shot.

  ask /new '<prompt>'    file the thread away, start fresh, then ask
  ask /new               file the thread away and start fresh
  ask /reset             throw the current thread away
  ask /session           show the current thread, no API call
  ask /sessions          list the threads for this repository
  ask /switch <name>     switch to a thread, creating it if new
  ask /write '<prompt>'  edit the single attached file (alias of --write)
  ask /diff '<prompt>'   preview that edit without writing (alias of --diff)
  ask /create <path> '<prompt>'
                         write a new file; any context is allowed
  ask /skills [term]     list available skills, no API call
  ask /compact           summarise the thread into notes, keeping files attached
  --no-session           one-shot, ignoring and not touching the thread

References
  @src/context.ts   an exact path (file or directory)
  @context          searched for in the tree: best-ranked match wins
  @'src/**/*.ts'    a glob (quote it so the shell does not expand it first)

Examples
  ask '@src/context.ts review this file for me'
  ask '@src explain the control flow, then list risks'
  ask '@chat what does this module do?'        # resolves to src/chat.ts
  ask -f 'path with spaces.ts' 'any bugs?'
  git diff --staged | ask 'review this diff for regressions'
  ask --show-context '@src' 'summarise'        # list attachments, no API call

Options
  -m, --model <name>        model id (env ASK_MODEL, default ${DEFAULT_MODEL})
  -s, --system <text>       system prompt (env ASK_SYSTEM)
      --system-file <path>  read the system prompt from a file
      --base-url <url>      OpenAI-compatible endpoint (env OPENAI_BASE_URL)
      --api-key <key>       API key (env OPENAI_API_KEY)
  -f, --file <path>         attach a path explicitly; repeatable
      --max-tokens <n>      cap the answer length
      --temperature <n>     sampling temperature (omitted unless set)
      --token-field <name>  max_tokens | max_completion_tokens (auto by default)
      --max-file-bytes <n>  per-file cap before truncation (default 262144)
      --max-total-bytes <n> total context cap (default 1048576)
      --max-files <n>       max files from directory walks (default 200)
      --skill <name>        prepend a skill's instructions; repeatable,
                            searched if not an exact name
      --list-skills         alias of /skills
      --create <path>       alias of /create
      --write               alias of /write
      --diff                alias of /diff
      --force               allow --write on a dirty or untracked file
      --all-matches         attach every search match instead of the best one
      --include-secrets     do not skip .env / *.pem / key-ish files
      --new                 alias of /new
      --reset               alias of /reset
      --show-session        alias of /session
      --list-sessions       alias of /sessions
      --switch <name>       alias of /switch
      --compact             alias of /compact
      --no-session          do not read or write the thread
      --session <name>      use a named thread for this run (forces sessions on)
                            precedence: --session, ASK_SESSION, /switch, default
      --session-max-tokens <n>
                            prune oldest turns past this budget (default ${DEFAULT_SESSION_MAX_TOKENS})
      --show-context        print what would be attached, then exit
      --dry-run             print the request JSON, then exit
      --json                print the result as JSON
  -q, --quiet               no stderr footer
  -V, --version             print the version
  -h, --help                this help
      --install-completion  print the shell setup block (--apply writes it)
      --no-color            no colour in status output (also NO_COLOR=1)
`;

class UsageError extends Error {}

/** Configuration problem: reported without dumping the whole usage text. */
class ConfigError extends Error {}

/**
 * Read the version from package.json. The relative depth differs between the
 * compiled entrypoint (dist/src/cli.js) and running the source directly
 * (src/cli.ts), so try both rather than assuming a layout.
 */
async function readVersion(): Promise<string> {
  for (const candidate of ["../package.json", "../../package.json"]) {
    try {
      const raw = await readFile(new URL(candidate, import.meta.url), "utf8");
      const parsed = JSON.parse(raw) as { name?: string; version?: string };
      if (parsed.name === "@codehaus/ask" && parsed.version) return parsed.version;
    } catch {
      // try the next candidate
    }
  }
  return "unknown";
}

/** .env candidates: the working directory first, then the install root. */
function envCandidates(): string[] {
  return [
    path.join(process.cwd(), ".env"),
    path.resolve(HERE, "..", "..", ".env"),
    path.resolve(HERE, "..", ".env"),
  ];
}

function numberOption(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new UsageError(`--${name} must be a number, got "${raw}"`);
  return value;
}

/** Idle timeout for implicit sessions; `ASK_SESSION_TTL` is in minutes. */
function sessionTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env["ASK_SESSION_TTL"];
  if (raw === undefined) return DEFAULT_SESSION_TTL_MS;
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes < 0) return DEFAULT_SESSION_TTL_MS;
  return minutes * 60 * 1000;
}

function tokenFieldOption(raw: string | undefined): TokenField | undefined {
  if (raw === undefined) return undefined;
  if (raw !== "max_tokens" && raw !== "max_completion_tokens") {
    throw new UsageError("--token-field must be max_tokens or max_completion_tokens");
  }
  return raw;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").trim();
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Report references that were not literal paths, so it is always obvious which
 * file a search or glob actually picked.
 */
function resolutionNotes(context: ContextResult, cwd: string): string[] {
  const notes: string[] = [];
  for (const resolution of context.resolutions) {
    if (resolution.kind === "path") continue;
    const shown = resolution.paths
      .slice(0, 3)
      .map((absolute) => path.relative(cwd, absolute))
      .join(", ");
    const more = resolution.paths.length > 3 ? ` (+${resolution.paths.length - 3} more)` : "";
    notes.push(`@${resolution.ref} → ${shown}${more} [${resolution.kind}]`);
  }
  return notes;
}

/**
 * What the next request would cost, broken down. Shown by --show-context, which
 * never calls the API, so this is the safe way to check before spending.
 */
function printContext(
  context: ContextResult,
  extras: {
    question: string;
    stdinText: string;
    system: string;
    skills: readonly LoadedSkill[];
    session: Session | null;
    palette: Palette;
  },
): void {
  const paint = extras.palette;
  for (const note of resolutionNotes(context, process.cwd())) {
    process.stdout.write(`${paint.cyan("match")}   ${note}\n`);
  }
  for (const block of context.blocks) {
    const note = block.truncated ? paint.yellow("  (truncated)") : "";
    process.stdout.write(`${paint.bold("attach")}  ${block.path}  ${formatBytes(block.bytes)}${note}\n`);
  }
  for (const item of context.skipped) {
    process.stdout.write(paint.dim(`skip    ${item.path}  (${item.reason})\n`));
  }

  const files = Math.ceil(context.totalBytes / 4);
  const history = sessionTokens(extras.session);
  const question = estimateTokens(extras.question) + estimateTokens(extras.stdinText);
  // Skills are part of the system prompt, but big enough to deserve their own
  // line: a skill can cost more than the files you attached.
  const skillTokens = extras.skills.reduce(
    (total, skill) => total + estimateTokens(skill.body),
    0,
  );
  const system = estimateTokens(extras.system) - skillTokens;
  const total = files + history + question + system + skillTokens;

  process.stdout.write(
    `\n${context.blocks.length} file(s), ${formatBytes(context.totalBytes)}\n\n` +
      `${paint.bold("estimated tokens for the next request")}\n` +
      paint.dim(
        `  files     ~${formatCount(files)}\n` +
          (extras.session ? `  history   ~${formatCount(history)}\n` : "") +
          (extras.skills.length > 0
            ? `  skills    ~${formatCount(skillTokens)} (${extras.skills
                .map((skill) => skill.name)
                .join(", ")})\n`
            : "") +
          `  question  ~${formatCount(question)}\n` +
          `  system    ~${formatCount(system)}\n`,
      ) +
      `  total     ~${formatCount(total)}\n`,
  );
}

function formatCount(value: number): string {
  return value >= 10_000 ? `${(value / 1000).toFixed(1)}k` : String(value);
}

/** Print a session without calling the API. */
function printSession(session: Session | null, file: string, paint: Palette): void {
  if (!session || session.turns.length === 0) {
    process.stdout.write(`no active thread\n${paint.dim(`(would be stored at ${file})`)}\n`);
    return;
  }

  const spent = sessionUsage(session);
  const partial = spent.reported < spent.turns ? ` (${spent.reported}/${spent.turns} turns)` : "";

  process.stdout.write(
    `${paint.bold(`thread ${sessionLabel(session)}`)}  ${session.turns.length} turn(s)\n` +
      paint.dim(
        `scope   ${session.scope}\n` +
          `updated ${session.updatedAt}\n` +
          `history ~${formatCount(sessionTokens(session))} tokens, resent every turn\n` +
          `spent   ${formatCount(spent.input)} in / ${formatCount(spent.output)} out${partial}\n` +
          `file    ${file}\n`,
      ) +
      "\n",
  );

  let total = 0;
  session.turns.forEach((turn, index) => {
    const refs = turn.refs.length > 0 ? `  [${turn.refs.map((ref) => `@${ref}`).join(" ")}]` : "";
    const answer = turn.answer.replace(/\s+/g, " ");
    total += estimateTokens(turn.question) + estimateTokens(turn.answer);

    if (turn.summary) {
      // Shown as a summary, not as a question and answer that never happened.
      process.stdout.write(
        `${index + 1}. ${paint.cyan("summary")} of ${turn.covers ?? "?"} earlier turn(s)${paint.dim(refs)}\n` +
          `   ${paint.dim(answer.length > 300 ? `${answer.slice(0, 300)}…` : answer)}\n`,
      );
      return;
    }
    process.stdout.write(
      `${index + 1}. ${paint.bold("you")}: ${turn.question}${paint.dim(refs)}\n` +
        `   ${paint.cyan("llm")}: ${paint.dim(answer.length > 160 ? `${answer.slice(0, 160)}…` : answer)}\n`,
    );
  });

  process.stdout.write(
    paint.dim(
      `\n~${total} tokens of question-and-answer text; ` +
        `file contents are re-read fresh each turn\n`,
    ),
  );
}

/**
 * Locate completions/ask.bash relative to this entrypoint, which differs
 * between the compiled CLI (dist/src/cli.js) and running the source directly.
 */
async function findCompletionScript(): Promise<string | null> {
  for (const candidate of ["../completions/ask.bash", "../../completions/ask.bash"]) {
    const resolved = fileURLToPath(new URL(candidate, import.meta.url));
    try {
      await readFile(resolved);
      return resolved;
    } catch {
      // try the next layout
    }
  }
  return null;
}

/** Print, or with `apply` write, the shell integration block. */
async function installCompletion(apply: boolean): Promise<number> {
  const script = await findCompletionScript();
  if (!script) {
    const palette = createPalette(supportsColour(process.stderr));
    process.stderr.write(
      `${palette.red("ask: cannot find completions/ask.bash next to this install")}\n` +
        `${palette.dim("     (a packaged copy ships in the tarball; clone the repo if it is missing)")}\n`,
    );
    return 1;
  }

  const rcPath = process.env["ASK_RC"] ?? path.join(homedir(), ".bashrc");

  const fzf = await findExecutable("fzf");

  if (!apply) {
    process.stdout.write(`${installInstructions(script, rcPath)}\n${pickerStatus(fzf)}`);
    return 0;
  }

  const existing = await readFile(rcPath, "utf8").catch(() => "");
  const update = applyToRc(existing, script);

  if (!update.changed) {
    process.stdout.write(`already configured in ${rcPath}\n${pickerStatus(fzf)}`);
    return 0;
  }

  await writeFile(rcPath, update.text);
  process.stdout.write(
    `${update.replacedBlock ? "refreshed" : "added"} the ask block in ${rcPath}\n` +
      (update.removedStale > 0
        ? `cleared ${update.removedStale} stale line(s) from earlier attempts\n`
        : "") +
      `run 'exec bash' to load it\n${pickerStatus(fzf)}`,
  );
  return 0;
}

/** Status goes to stderr, dimmed; the answer on stdout stays untouched. */
function statusWriter(palette: Palette) {
  return {
    note: (line: string): void => void process.stderr.write(`${palette.dim(line)}\n`),
    warn: (line: string): void => void process.stderr.write(`${palette.yellow(line)}\n`),
    blank: (): void => void process.stderr.write("\n"),
  };
}

/** List every thread for this scope, marking the active one. */
async function printSessions(scope: string, active: string, paint: Palette): Promise<void> {
  const threads = await listSessions(scope);

  if (threads.length === 0) {
    process.stdout.write(
      `no threads yet for ${paint.bold(path.basename(scope))}\n` +
        paint.dim("start one by asking something, or 'ask /switch <name>'\n"),
    );
    return;
  }

  process.stdout.write(`threads for ${paint.bold(path.basename(scope))}\n\n`);
  // The active thread may be empty and so have no file yet; say so rather than
  // printing a list with nothing marked active.
  if (!threads.some((thread) => thread.name === active)) {
    process.stdout.write(`${paint.cyan("*")} ${active.padEnd(24)} ${paint.dim("empty")}\n`);
  }
  for (const thread of threads) {
    const marker = thread.name === active ? paint.cyan("*") : " ";
    const label = thread.archivedFrom === undefined ? "" : paint.dim("  (archived)");
    process.stdout.write(
      `${marker} ${thread.name.padEnd(24)} ${String(thread.turns).padStart(3)} turn(s)  ` +
        paint.dim(`~${thread.historyTokens} tokens  ${thread.updatedAt}`) +
        `${label}\n`,
    );
  }
  process.stdout.write(
    paint.dim(
      `\n* = active. Switch with 'ask /switch <name>'.\n` +
        `/new files the current thread away, /reset throws it away.\n`,
    ),
  );
}

/** List skills, optionally filtered, without calling the API. */
async function printSkills(term: string, paint: Palette): Promise<void> {
  const roots = skillSearchPaths();
  const all = await discoverSkills(roots);
  const shown = filterSkills(all, term);

  if (all.length === 0) {
    process.stdout.write(
      `no skills found\n${paint.dim(`looked in:\n${roots.map((root) => `  ${root}`).join("\n")}\n`)}`,
    );
    return;
  }
  if (shown.length === 0) {
    process.stdout.write(`no skill matches "${term}" (${all.length} available)\n`);
    return;
  }

  const heading = term.trim().length > 0 ? `skills matching "${term}"` : "skills";
  process.stdout.write(`${paint.bold(heading)}\n\n`);
  for (const skill of shown) {
    const description = skill.description.length > 0 ? skill.description : "(no description)";
    process.stdout.write(
      `${paint.cyan(skill.name)}\n  ${description}\n` +
        paint.dim(`  ${skill.file}  ${formatBytes(skill.bytes)}\n`),
    );
  }
  process.stdout.write(
    paint.dim(`\n${shown.length} of ${all.length} skill(s). Use: ask --skill <name> '<prompt>'\n`),
  );
}

/** Resolve and load every requested skill, reporting inexact matches. */
async function gatherSkills(terms: readonly string[]): Promise<LoadedSkill[]> {
  if (terms.length === 0) return [];

  const available = await discoverSkills(skillSearchPaths());
  const loaded: LoadedSkill[] = [];
  const seen = new Set<string>();

  for (const term of terms) {
    const summary = resolveSkill(term, available);
    if (seen.has(summary.name)) continue;
    seen.add(summary.name);
    loaded.push(await loadSkill(summary, summary.name === term ? "name" : "search"));
  }
  return loaded;
}

async function main(argv: string[]): Promise<number> {
  let values: Record<string, unknown>;
  let positionals: string[];
  try {
    const parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
    values = parsed.values;
    positionals = parsed.positionals;
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }

  // A leading /verb maps onto the flag of the same name. A few take a value,
  // which is the next positional: `ask /switch docs`.
  const firstPositional = positionals[0];
  if (firstPositional !== undefined && firstPositional in VERBS) {
    const target = VERBS[firstPositional]!;
    const expects = VERBS_WITH_VALUE.get(firstPositional);
    if (expects) {
      const raw = positionals[1];
      if (raw === undefined || raw.length === 0) {
        throw new UsageError(
          `${firstPositional} needs ${expects.noun}, e.g. ask ${expects.example}`,
        );
      }
      // `@path` is how files are named everywhere else, so accept it here too
      // rather than making the sigil a syntax error.
      values[target] = expects.isPath && raw.startsWith("@") ? raw.slice(1) : raw;
      positionals = positionals.slice(2);
    } else {
      values[target] = true;
      positionals = positionals.slice(1);
    }
  }

  const flag = (name: string): string | undefined => values[name] as string | undefined;
  const bool = (name: string): boolean => values[name] === true;

  const colour = bool("no-color")
    ? NO_COLOUR
    : createPalette(supportsColour(process.stderr));
  const status = statusWriter(colour);

  if (bool("help")) {
    process.stdout.write(USAGE);
    return 0;
  }

  if (bool("version")) {
    process.stdout.write(`ask ${await readVersion()}\n`);
    return 0;
  }

  if (bool("install-completion")) {
    return installCompletion(bool("apply"));
  }

  const envReports = await applyEnvFiles(envCandidates());

  const createPath = flag("create");
  const skillTerms = (values["skill"] as string[] | undefined) ?? [];

  if (bool("list-skills")) {
    await printSkills(
      positionals.join(" "),
      bool("no-color") ? NO_COLOUR : createPalette(supportsColour(process.stdout)),
    );
    return 0;
  }

  // /write <path> and /diff <path>: the target is named, never inferred.
  const writeTarget = flag("write") ?? flag("diff");
  const writeMode = writeTarget !== undefined;
  const diffOnly = flag("diff") !== undefined;

  const stdinText = await readStdin();
  const parsed = extractRefs(positionals.join(" "));
  // A filename's spaces split its reference in two; rejoin when the longer form
  // is a real path. Quoting (@"name with spaces.md") is the explicit way.
  const { refs, question, repaired } = await repairSpacedRefs(
    parsed.refs,
    parsed.question,
    process.cwd(),
  );
  for (const ref of repaired) {
    if (!bool("quiet") && !bool("json")) status.note(`-- read @${ref} as one path (spaces)`);
  }
  const turnRefs = [...refs, ...((values["file"] as string[] | undefined) ?? [])];
  // The target must be in context for the model to edit it; naming it twice is
  // harmless because references are deduplicated.
  if (writeTarget !== undefined) {
    const absolute = path.resolve(process.cwd(), writeTarget);
    const info = await stat(absolute).catch(() => null);
    const problems = checkWriteTargetPath({
      target: writeTarget,
      exists: info !== null,
      isFile: info?.isFile() ?? false,
    });
    if (problems.length > 0) {
      throw new ConfigError(
        `cannot write:\n${problems.map((line: string) => `  - ${line}`).join("\n")}`,
      );
    }
    turnRefs.push(writeTarget);
  }

  // Sessions are implicit for interactive runs only: a piped or scripted run
  // must stay reproducible. `--session <name>` forces them on regardless.
  // --no-session is the absolute off switch. ASK_SESSION=0 turns sessions off
  // for the shell, but naming a thread explicitly is a stronger signal than an
  // environment default, so --session <name> overrides it.
  const sessionsDisabled =
    bool("no-session") ||
    (process.env["ASK_SESSION"] === "0" && flag("session") === undefined);
  const switchTo = flag("switch");
  const sessionsOn =
    !sessionsDisabled && (process.stdout.isTTY === true || flag("session") !== undefined);

  const needsScope =
    sessionsOn ||
    bool("new") ||
    bool("reset") ||
    bool("show-session") ||
    bool("list-sessions") ||
    bool("compact") ||
    switchTo !== undefined;
  const scope = needsScope ? await sessionScope(process.cwd()) : process.cwd();

  if (switchTo !== undefined) {
    if (!isValidSessionName(switchTo)) {
      throw new UsageError(
        `invalid thread name "${switchTo}": letters, digits, dot, dash, underscore`,
      );
    }
    await writeCurrentSession(scope, switchTo);
    const target = await loadSession({ scope, name: switchTo }, sessionTtlMs());
    status.note(
      target
        ? `-- switched to thread ${switchTo} (${target.turns.length} turn(s))`
        : `-- switched to thread ${switchTo} (new)`,
    );
  }

  const sessionName = await resolveSessionName(scope, flag("session"));
  const sessionKey = { scope, name: sessionName };

  if (bool("list-sessions")) {
    await printSessions(scope, sessionName, colour);
    return 0;
  }

  // /new files the thread away and starts fresh; /reset throws it away.
  if (bool("new") || bool("reset")) {
    const current = sessionsDisabled ? null : await loadSession(sessionKey, 0);

    if (bool("reset")) {
      const removed = await resetSession(sessionKey);
      if (!bool("quiet")) {
        status.note(
          removed && current
            ? `-- discarded ${current.turns.length} turn(s)`
            : "-- nothing to discard",
        );
      }
    } else {
      const archived = current ? await archiveSession(current) : null;
      if (!bool("quiet")) {
        status.note(
          archived
            ? `-- archived ${current?.turns.length ?? 0} turn(s) as ${archived}; started a new thread`
            : "-- already a fresh thread",
        );
        if (archived) status.note(`--   come back with 'ask /switch ${archived}'`);
      }
    }
  }

  if (bool("show-session")) {
    const existing = sessionsDisabled ? null : await loadSession(sessionKey, sessionTtlMs());
    printSession(
      existing,
      sessionPath(sessionKey),
      bool("no-color") ? NO_COLOUR : createPalette(supportsColour(process.stdout)),
    );
    return 0;
  }

  // /compact: one invocation, one request, whose answer becomes the new
  // history. Deliberately explicit — nothing is ever summarised behind your
  // back during a normal question.
  if (bool("compact")) {
    const existing = sessionsDisabled ? null : await loadSession(sessionKey, sessionTtlMs());
    if (!existing || existing.turns.length === 0) {
      process.stdout.write("no thread to compact\n");
      return 0;
    }
    if (existing.turns.length === 1 && existing.turns[0]?.summary === true) {
      process.stdout.write("thread is already a single summary; nothing to compact\n");
      return 0;
    }

    const compactBaseURL = flag("base-url") ?? process.env["OPENAI_BASE_URL"];
    const compactRequest = buildRequest({
      prompt: buildCompactionPrompt(existing),
      model: flag("model") ?? process.env["ASK_MODEL"] ?? DEFAULT_MODEL,
      system: COMPACT_SYSTEM,
      maxTokens: numberOption(flag("max-tokens"), "max-tokens") ?? 800,
      temperature: numberOption(flag("temperature"), "temperature"),
      tokenField: tokenFieldOption(flag("token-field")),
      baseURL: compactBaseURL,
    });

    if (bool("dry-run")) {
      process.stdout.write(`${JSON.stringify(compactRequest, null, 2)}\n`);
      return 0;
    }

    const before = sessionTokens(existing);
    const compactClient = createClient({
      apiKey: flag("api-key") ?? process.env["OPENAI_API_KEY"],
      baseURL: compactBaseURL,
    });
    const compactSpinner = startSpinner({
      label: `compacting ${existing.turns.length} turn(s)`,
      stream: process.stderr,
      style: colour.dim,
      ...(bool("quiet") ? { enabled: false } : {}),
    });
    let summary: Awaited<ReturnType<typeof askOnce>>;
    try {
      summary = await askOnce(compactClient, compactRequest);
    } finally {
      compactSpinner.stop();
    }

    // Compaction is lossy, so keep the previous thread recoverable.
    const backup = await backupSession(existing);
    const compacted = applyCompaction(existing, summary.text);
    await saveSession(compacted);

    const after = sessionTokens(compacted);
    process.stdout.write(`${summary.text}\n`);
    if (!bool("quiet")) {
      status.blank();
      status.note(
        `-- compacted ${existing.turns.length} turn(s): ~${before} → ~${after} tokens of history`,
      );
      status.note(
        `-- ${compacted.turns[0]?.refs.length ?? 0} file(s) stay attached; ` +
          `previous thread kept at ${backup}`,
      );
      if (after >= before) {
        // Short threads cost more to summarise than to keep verbatim.
        status.warn(
          "-- note: the summary is no smaller than the thread it replaced; " +
            "/compact pays off on long threads (restore with the file above)",
        );
      }
    }
    return 0;
  }

  if (turnRefs.length === 0 && !question && !stdinText) {
    // `ask /new` or `ask /switch x` on their own are complete commands.
    if (bool("new") || bool("reset") || switchTo !== undefined) return 0;
    throw new UsageError("nothing to ask: give a prompt, an @path, or pipe stdin");
  }

  const session =
    sessionsOn && !bool("new") && !bool("reset")
      ? await loadSession(sessionKey, sessionTtlMs())
      : null;

  // Files from earlier turns stay attached, re-read from disk so a follow-up
  // after an edit sees current code. Refs that no longer resolve are dropped
  // rather than failing the follow-up.
  const carried: string[] = [];
  for (const ref of sessionRefs(session)) {
    if (turnRefs.includes(ref)) continue;
    try {
      await resolveRef(ref, { cwd: process.cwd() });
      carried.push(ref);
    } catch {
      if (!bool("quiet")) status.note(`-- dropped @${ref} from the thread (no longer resolves)`);
    }
  }
  const allRefs = [...carried, ...turnRefs];

  const context = await collectContext(allRefs, {
    includeSecrets: bool("include-secrets"),
    allMatches: bool("all-matches"),
    limits: {
      maxFileBytes: numberOption(flag("max-file-bytes"), "max-file-bytes"),
      maxTotalBytes: numberOption(flag("max-total-bytes"), "max-total-bytes"),
      maxFiles: numberOption(flag("max-files"), "max-files"),
    },
  });

  // Skills carry across a session like @refs do, and are re-read each turn.
  const carriedSkills = sessionSkills(session).filter((name) => !skillTerms.includes(name));
  const skills = await gatherSkills([...carriedSkills, ...skillTerms]);
  if (!bool("quiet") && !bool("json")) {
    for (const skill of skills) {
      const how = skill.matched === "search" ? " [search]" : "";
      status.note(`-- skill ${skill.name}${how}`);
    }
  }

  // Nothing attached, but something was asked for: say why, and how to fix it.
  if (context.blocks.length === 0 && allRefs.length > 0 && !bool("quiet")) {
    const binary = context.skipped.filter(
      (item) => item.reason === "binary-content" || item.reason === "binary-extension",
    );
    for (const item of binary) {
      status.warn(`-- ${item.path} is not text, so nothing was attached`);
    }
    if (binary.length > 0) {
      status.note("-- convert it and pipe the text in instead, e.g.");
      status.note(`--   pandoc -t plain '${binary[0]?.path}' | ask 'what is this document?'`);
      status.note("--   pdftotext file.pdf - | ask 'summarise this'");
    }
  }

  const systemFile = flag("system-file");
  const explicitSystem = systemFile
    ? await readFile(systemFile, "utf8")
    : (flag("system") ?? process.env["ASK_SYSTEM"]);
  // Write mode needs "output the whole file and nothing else"; an explicitly
  // chosen system prompt still wins.
  const system =
    explicitSystem ??
    (createPath !== undefined
      ? CREATE_SYSTEM
      : writeMode
        ? WRITE_SYSTEM
        : DEFAULT_SYSTEM);

  const skillText = renderSkills(skills);
  const systemWithSkills = skillText.length > 0 ? `${system}\n\n${skillText}` : system;

  if (bool("show-context")) {
    printContext(context, {
      question,
      stdinText,
      system: systemWithSkills,
      skills,
      session,
      palette: bool("no-color") ? NO_COLOUR : createPalette(supportsColour(process.stdout)),
    });
    return 0;
  }

  // Say which file a search or glob picked before spending tokens on it.
  if (!bool("quiet") && !bool("json")) {
    for (const note of resolutionNotes(context, process.cwd())) {
      status.note(`-- ${note}`);
    }
  }

  // /create: refuse before spending tokens. Creating destroys nothing, so the
  // only hazards are clobbering a file and conjuring directories.
  if (createPath !== undefined) {
    const absolute = path.resolve(process.cwd(), createPath);
    const exists = await stat(absolute).then(
      () => true,
      () => false,
    );
    const parentExists = await stat(path.dirname(absolute)).then(
      (info) => info.isDirectory(),
      () => false,
    );
    const problems = checkCreateRequest({
      target: createPath,
      exists,
      parentExists,
      withEditFlags: flag("write") !== undefined || flag("diff") !== undefined,
    });
    if (problems.length > 0) {
      throw new ConfigError(
        `cannot create:\n${problems.map((line: string) => `  - ${line}`).join("\n")}`,
      );
    }
  }

  // /write and /diff: the remaining checks need the collected context.
  if (writeTarget !== undefined) {
    const relative = path.relative(process.cwd(), path.resolve(process.cwd(), writeTarget));
    const block = context.blocks.find((candidate) => candidate.path === relative);
    const problems = checkWriteTargetContext({
      target: writeTarget,
      attached: block !== undefined,
      truncated: block?.truncated ?? false,
    });
    if (problems.length > 0) {
      throw new ConfigError(`cannot write:\n${problems.map((line: string) => `  - ${line}`).join("\n")}`);
    }
  }

  const prompt = renderPrompt(question, context, stdinText);

  // Prune loudly: the whole thread is resent every turn, so silent growth is
  // the one thing an implicit session must not do.
  let history = session;
  if (session) {
    const budget =
      numberOption(flag("session-max-tokens"), "session-max-tokens") ??
      DEFAULT_SESSION_MAX_TOKENS;
    const pruned = pruneSession(session, budget, estimateTokens(prompt));
    history = pruned.session;
    if (pruned.dropped > 0 && !bool("quiet")) {
      status.note(`-- pruned ${pruned.dropped} old turn(s) to stay under ${budget} tokens`);
    }
  }

  const baseURL = flag("base-url") ?? process.env["OPENAI_BASE_URL"];
  const request = buildRequest({
    prompt,
    model: flag("model") ?? process.env["ASK_MODEL"] ?? DEFAULT_MODEL,
    system: systemWithSkills,
    history: sessionMessages(history),
    maxTokens: numberOption(flag("max-tokens"), "max-tokens"),
    temperature: numberOption(flag("temperature"), "temperature"),
    tokenField: tokenFieldOption(flag("token-field")),
    baseURL,
  });

  if (bool("dry-run")) {
    process.stdout.write(`${JSON.stringify(request, null, 2)}\n`);
    return 0;
  }

  const apiKey = flag("api-key") ?? process.env["OPENAI_API_KEY"];
  if (!apiKey && !isLoopbackEndpoint(baseURL)) {
    // Say what was read, so a .env that exists but was not picked up is
    // obvious rather than a dead end.
    throw new ConfigError(
      "no API key: set OPENAI_API_KEY, put it in .env, or pass --api-key\n" +
        describeEnvFiles(envReports, "OPENAI_API_KEY"),
    );
  }

  const client = createClient({ apiKey, baseURL });

  // A local model can take a while; show progress, but only for a human at a
  // terminal, and always erase the line afterwards.
  const spinner = startSpinner({
    label: `asking ${request.model}`,
    stream: process.stderr,
    style: colour.dim,
    ...(bool("quiet") ? { enabled: false } : {}),
  });

  let result: Awaited<ReturnType<typeof askOnce>>;
  try {
    result = await askOnce(client, request);
  } finally {
    spinner.stop();
  }

  // Set when a write happened (or was a no-op), standing in for the answer.
  let writeSummary: string | null = null;

  // /create: the answer is a new file.
  if (createPath !== undefined) {
    const absolute = path.resolve(process.cwd(), createPath);
    const { content, strippedFence } = stripCodeFence(result.text);
    const proposed = content.endsWith("\n") ? content : `${content}\n`;

    const problems = checkCreateResponse(proposed, result.finishReason);
    if (problems.length > 0) {
      throw new ConfigError(
        `refusing to create ${createPath}:\n` +
          problems.map((line: string) => `  - ${line}`).join("\n"),
      );
    }

    if (strippedFence && !bool("quiet")) {
      status.note("-- stripped a markdown code fence from the response");
    }

    // Exclusive create: nothing can have appeared since the pre-flight check.
    await writeFile(absolute, proposed, { flag: "wx" });

    const lines = proposed.split("\n").length - 1;
    const summary = `created ${createPath}: ${lines} lines, ${formatBytes(
      Buffer.byteLength(proposed, "utf8"),
    )}`;
    status.note(`-- ${summary}`);
    status.note(`-- untracked; review it, then 'git add ${createPath}'`);
    writeSummary = `(${summary})`;
  }

  // --write / --diff: the model returned a whole file, so check it and either
  // preview or replace. The model never chooses to write; this does.
  if (writeTarget !== undefined) {
    const targetFile = path.relative(process.cwd(), path.resolve(process.cwd(), writeTarget));
    const absolute = path.resolve(process.cwd(), writeTarget);
    const original =
      context.blocks.find((candidate) => candidate.path === targetFile)?.text ?? "";
    const { content, strippedFence } = stripCodeFence(result.text);
    // Preserve the file's trailing-newline convention.
    const proposed = original.endsWith("\n") && !content.endsWith("\n") ? `${content}\n` : content;

    const problems = checkWriteResponse({
      original,
      proposed,
      finishReason: result.finishReason,
      ...(bool("force") ? { shrinkFloor: 0 } : {}),
    });
    if (problems.length > 0) {
      throw new ConfigError(
        `refusing to write ${targetFile}:\n` +
          problems.map((line: string) => `  - ${line}`).join("\n"),
      );
    }

    if (strippedFence && !bool("quiet")) {
      status.note("-- stripped a markdown code fence from the response");
    }

    const change = summariseChange(original, proposed);
    if (proposed === original && !diffOnly) {
      status.note(`-- ${targetFile} unchanged`);
      writeSummary = `(no change to ${targetFile})`;
    }

    // Preview mode: show the diff, touch nothing.
    if (diffOnly) {
      const temporary = path.join(tmpdir(), `ask-proposed-${process.pid}-${path.basename(targetFile)}`);
      await writeFile(temporary, proposed);
      try {
        const diff = await gitDiffNoIndex(absolute, temporary, colour.enabled);
        process.stdout.write(
          diff ??
            `${targetFile}: ${change.beforeLines} → ${change.afterLines} lines ` +
              `(git unavailable, so no diff)\n`,
        );
      } finally {
        await rm(temporary, { force: true });
      }
      status.note(`-- nothing written; drop --diff to apply`);
      return 0;
    }

    // Unchanged answers need no write at all.
    if (writeSummary === null) {
      // git is the undo button, so require that it can act as one.
      const state = await gitFileState(absolute);
      if (state !== "clean" && !bool("force")) {
        const detail =
          state === "dirty"
            ? "it has uncommitted changes"
            : state === "untracked"
              ? "it is not tracked by git"
              : "it is not in a git repository";
        throw new ConfigError(
          `refusing to overwrite ${targetFile}: ${detail}, so the current contents ` +
            "could not be recovered. Commit or stash first, or pass --force.",
        );
      }

      await writeFile(absolute, proposed);
      const summary =
        `wrote ${targetFile}: ${change.beforeLines} → ${change.afterLines} lines, ` +
        `${formatBytes(change.beforeBytes)} → ${formatBytes(change.afterBytes)}`;
      status.note(`-- ${summary}`);
      if (state === "clean") {
        status.note("-- review with 'git diff', undo with 'git checkout --'");
      }
      // The answer *is* the file, so the thread records what happened instead:
      // history must never accumulate file contents.
      writeSummary = `(${summary})`;
    }
  }

  // Record the turn. Only the question, the refs as typed, and the answer —
  // never file contents, which are re-read next turn.
  let saved: Session | null = null;
  if (sessionsOn) {
    saved = appendTurn(history, {
      scope,
      name: sessionName,
      question: question || (stdinText ? "(piped input)" : ""),
      refs: turnRefs,
      skills: skills.map((skill) => skill.name),
      answer: writeSummary ?? result.text,
      usage: result.usage,
    });
    await saveSession(saved);
  }

  if (bool("json")) {
    process.stdout.write(
      `${JSON.stringify(
        {
          model: result.model,
          text: result.text,
          usage: result.usage,
          finishReason: result.finishReason,
          context: {
            files: context.blocks.map((block) => block.path),
            bytes: context.totalBytes,
            skipped: context.skipped,
            resolutions: context.resolutions.map((resolution) => ({
              ref: resolution.ref,
              kind: resolution.kind,
              paths: resolution.paths.map((absolute) => path.relative(process.cwd(), absolute)),
            })),
          },
          session: saved
            ? { name: sessionLabel(saved), turns: saved.turns.length, scope: saved.scope }
            : null,
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }

  // In write mode the answer is the file itself; it is on disk, not stdout.
  if (writeSummary === null) process.stdout.write(`${result.text}\n`);

  // An edit instruction with one file attached, but no /write: say how to apply
  // it. Suggesting is the whole of it — inferring the intent and writing would
  // undo the point of naming the target.
  if (writeSummary === null && !bool("quiet") && !bool("json")) {
    const only = context.blocks.length === 1 ? context.blocks[0]?.path : undefined;
    if (only !== undefined && looksLikeEdit(question)) {
      status.note("-- nothing was written. To apply an answer like this to the file:");
      status.note(`--   ask /write ${shellQuote(only)} ${shellQuote(question)}`);
      status.note("--   ask /diff  ... to preview it first");
    }
  }

  if (!bool("quiet")) {
    // Implicit state must be visible: say which thread and which turn.
    const thread = saved ? `thread ${sessionLabel(saved)} turn ${saved.turns.length} | ` : "";
    const skillNote =
      skills.length > 0 ? `skill ${skills.map((skill) => skill.name).join("+")} | ` : "";
    status.blank();
    status.note(
      `-- ${result.model} | ${thread}${skillNote}${context.blocks.length} file(s) ` +
        `${formatBytes(context.totalBytes)} | tokens in ${result.usage.input ?? "?"} ` +
        `out ${result.usage.output ?? "?"}`,
    );
    if (saved && saved.turns.length > 1) {
      // Implicit context compounds, so show what the thread has cost so far.
      const spent = sessionUsage(saved);
      status.note(
        `-- thread total: ${formatCount(spent.input)} in / ` +
          `${formatCount(spent.output)} out over ${spent.turns} turns ` +
          `(~${formatCount(sessionTokens(saved))} history resent next turn)`,
      );
    }
    if (result.finishReason === "length") {
      status.warn("-- warning: answer hit the token cap (--max-tokens)");
    }
    if (context.truncated) {
      status.warn("-- warning: some context was truncated (--show-context to inspect)");
    }
  }
  return 0;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  // The palette is rebuilt here: main() may have thrown before parsing flags.
  const palette = process.argv.includes("--no-color")
    ? NO_COLOUR
    : createPalette(supportsColour(process.stderr));
  const fail = (line: string): void => void process.stderr.write(`${palette.red(line)}\n`);
  const hint = (line: string): void => void process.stderr.write(`${palette.dim(line)}\n`);

  if (error instanceof ConfigError) {
    fail(`ask: ${error.message}`);
    process.exitCode = 2;
  } else if (error instanceof SkillResolutionError) {
    fail(`ask: ${error.message}`);
    for (const candidate of error.candidates.slice(0, 10)) {
      hint(`      ${candidate}`);
    }
    hint(
      error.candidates.length > 0
        ? "      name one of them exactly"
        : "      'ask /skills' lists what is available",
    );
    process.exitCode = 2;
  } else if (error instanceof RefResolutionError) {
    fail(`ask: ${error.message}`);
    for (const candidate of error.candidates.slice(0, 10)) {
      hint(`      ${candidate}`);
    }
    if (error.candidates.length > 10) {
      hint(`      ... and ${error.candidates.length - 10} more`);
    }
    if (error.candidates.length > 0) {
      hint("      name one of them, use a glob, or pass --all-matches");
    }
    process.exitCode = 2;
  } else if (error instanceof UsageError) {
    fail(`ask: ${error.message}`);
    process.stderr.write(`\n${USAGE}`);
    process.exitCode = 2;
  } else {
    const httpStatus =
      error !== null && typeof error === "object" && "status" in error && error.status
        ? ` (HTTP ${String(error.status)})`
        : "";
    fail(`ask: ${error instanceof Error ? error.message : String(error)}${httpStatus}`);
    process.exitCode = 1;
  }
}
