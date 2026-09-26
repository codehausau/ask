#!/usr/bin/env node
// ask — attach files/directories as context, ask one question, print one answer.
//
//   ask '@src/cli.ts review this file for me'
//   ask '@src @test where is the loop?'
//   git diff | ask 'review this diff'
//
// No tools, no agent loop, no follow-up turns: exactly one HTTP request.

import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
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
import { applyEnvFiles, describeEnvFiles } from "./env.ts";
import { applyToRc, findExecutable, installInstructions, pickerStatus } from "./install.ts";
import { startSpinner } from "./spinner.ts";
import { OPTIONS, VERBS, VERBS_WITH_VALUE } from "./options.ts";
import { RefResolutionError, resolveRef } from "./refs.ts";
import {
  appendTurn,
  applyCompaction,
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

Sessions
  Interactive runs continue the previous conversation for this repository,
  so a follow-up needs no @references. Piped runs are always one-shot.

  ask /new '<prompt>'    start a fresh thread, then ask
  ask /new               start a fresh thread and stop
  ask /session           show the current thread, no API call
  ask /sessions          list the threads for this repository
  ask /switch <name>     switch to a thread, creating it if new
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
      --all-matches         attach every search match instead of the best one
      --include-secrets     do not skip .env / *.pem / key-ish files
      --new, --reset        alias of /new
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
  const system = estimateTokens(extras.system);
  const total = files + history + question + system;

  process.stdout.write(
    `\n${context.blocks.length} file(s), ${formatBytes(context.totalBytes)}\n\n` +
      `${paint.bold("estimated tokens for the next request")}\n` +
      paint.dim(
        `  files     ~${formatCount(files)}\n` +
          (extras.session ? `  history   ~${formatCount(history)}\n` : "") +
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
  for (const thread of threads) {
    const marker = thread.name === active ? paint.cyan("*") : " ";
    process.stdout.write(
      `${marker} ${thread.name.padEnd(20)} ${String(thread.turns).padStart(3)} turn(s)  ` +
        paint.dim(`~${thread.historyTokens} tokens  ${thread.updatedAt}`) +
        "\n",
    );
  }
  process.stdout.write(
    paint.dim(`\n* = active. Switch with 'ask /switch <name>'.\n`),
  );
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
    if (VERBS_WITH_VALUE.has(firstPositional)) {
      const value = positionals[1];
      if (value === undefined || value.startsWith("@")) {
        throw new UsageError(`${firstPositional} needs a name, e.g. ${firstPositional} review`);
      }
      values[target] = value;
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

  const stdinText = await readStdin();
  const { refs, question } = extractRefs(positionals.join(" "));
  const turnRefs = [...refs, ...((values["file"] as string[] | undefined) ?? [])];

  // Sessions are implicit for interactive runs only: a piped or scripted run
  // must stay reproducible. `--session <name>` forces them on regardless.
  const sessionsDisabled = bool("no-session") || process.env["ASK_SESSION"] === "0";
  const switchTo = flag("switch");
  const sessionsOn =
    !sessionsDisabled && (process.stdout.isTTY === true || flag("session") !== undefined);

  const needsScope =
    sessionsOn ||
    bool("new") ||
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

  if (bool("new")) {
    const removed = await resetSession(sessionKey);
    if (!bool("quiet")) {
      status.note(removed ? "-- started a new thread" : "-- no thread to clear; starting fresh");
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
    if (bool("new") || switchTo !== undefined) return 0;
    throw new UsageError("nothing to ask: give a prompt, an @path, or pipe stdin");
  }

  const session = sessionsOn && !bool("new") ? await loadSession(sessionKey, sessionTtlMs()) : null;

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

  const systemFile = flag("system-file");
  const system = systemFile
    ? await readFile(systemFile, "utf8")
    : (flag("system") ?? process.env["ASK_SYSTEM"] ?? DEFAULT_SYSTEM);

  if (bool("show-context")) {
    printContext(context, {
      question,
      stdinText,
      system,
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
    system,
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

  // Record the turn. Only the question, the refs as typed, and the answer —
  // never file contents, which are re-read next turn.
  let saved: Session | null = null;
  if (sessionsOn) {
    saved = appendTurn(history, {
      scope,
      name: sessionName,
      question: question || (stdinText ? "(piped input)" : ""),
      refs: turnRefs,
      answer: result.text,
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

  process.stdout.write(`${result.text}\n`);

  if (!bool("quiet")) {
    // Implicit state must be visible: say which thread and which turn.
    const thread = saved ? `thread ${sessionLabel(saved)} turn ${saved.turns.length} | ` : "";
    status.blank();
    status.note(
      `-- ${result.model} | ${thread}${context.blocks.length} file(s) ` +
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
