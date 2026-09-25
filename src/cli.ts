#!/usr/bin/env node
// ask — attach files/directories as context, ask one question, print one answer.
//
//   ask '@src/cli.ts review this file for me'
//   ask '@src @test where is the loop?'
//   git diff | ask 'review this diff'
//
// No tools, no agent loop, no follow-up turns: exactly one HTTP request.

import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  askOnce,
  buildRequest,
  createClient,
  DEFAULT_MODEL,
  DEFAULT_SYSTEM,
  type TokenField,
} from "./chat.ts";
import { collectContext, extractRefs, renderPrompt, type ContextResult } from "./context.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const USAGE = `ask — one-shot LLM question with file/directory context

Usage
  ask [options] '<prompt with @file or @dir references>'
  <command> | ask [options] '<prompt>'

Examples
  ask '@src/context.ts review this file for me'
  ask '@src explain the control flow, then list risks'
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
      --include-secrets     do not skip .env / *.pem / key-ish files
      --show-context        print what would be attached, then exit
      --dry-run             print the request JSON, then exit
      --json                print the result as JSON
  -q, --quiet               no stderr footer
  -V, --version             print the version
  -h, --help                this help
`;

const OPTIONS = {
  model: { type: "string", short: "m" },
  system: { type: "string", short: "s" },
  "system-file": { type: "string" },
  "base-url": { type: "string" },
  "api-key": { type: "string" },
  file: { type: "string", short: "f", multiple: true },
  "max-tokens": { type: "string" },
  temperature: { type: "string" },
  "token-field": { type: "string" },
  "max-file-bytes": { type: "string" },
  "max-total-bytes": { type: "string" },
  "max-files": { type: "string" },
  "include-secrets": { type: "boolean" },
  "show-context": { type: "boolean" },
  "dry-run": { type: "boolean" },
  json: { type: "boolean" },
  quiet: { type: "boolean", short: "q" },
  version: { type: "boolean", short: "V" },
  help: { type: "boolean", short: "h" },
} as const;

class UsageError extends Error {}

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

function loadEnvFiles(): void {
  if (typeof process.loadEnvFile !== "function") return;
  for (const candidate of [path.join(process.cwd(), ".env"), path.resolve(HERE, "..", "..", ".env")]) {
    try {
      process.loadEnvFile(candidate);
    } catch {
      // absent or unreadable .env is fine
    }
  }
}

function numberOption(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new UsageError(`--${name} must be a number, got "${raw}"`);
  return value;
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

function printContext(context: ContextResult): void {
  for (const block of context.blocks) {
    const note = block.truncated ? "  (truncated)" : "";
    process.stdout.write(`attach  ${block.path}  ${formatBytes(block.bytes)}${note}\n`);
  }
  for (const item of context.skipped) {
    process.stdout.write(`skip    ${item.path}  (${item.reason})\n`);
  }
  process.stdout.write(
    `\n${context.blocks.length} file(s), ${formatBytes(context.totalBytes)}, ` +
      `~${Math.ceil(context.totalBytes / 4)} tokens\n`,
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

  const flag = (name: string): string | undefined => values[name] as string | undefined;
  const bool = (name: string): boolean => values[name] === true;

  if (bool("help")) {
    process.stdout.write(USAGE);
    return 0;
  }

  if (bool("version")) {
    process.stdout.write(`ask ${await readVersion()}\n`);
    return 0;
  }

  loadEnvFiles();

  const stdinText = await readStdin();
  const { refs, question } = extractRefs(positionals.join(" "));
  const allRefs = [...refs, ...((values["file"] as string[] | undefined) ?? [])];

  if (allRefs.length === 0 && !question && !stdinText) {
    throw new UsageError("nothing to ask: give a prompt, an @path, or pipe stdin");
  }

  const context = await collectContext(allRefs, {
    includeSecrets: bool("include-secrets"),
    limits: {
      maxFileBytes: numberOption(flag("max-file-bytes"), "max-file-bytes"),
      maxTotalBytes: numberOption(flag("max-total-bytes"), "max-total-bytes"),
      maxFiles: numberOption(flag("max-files"), "max-files"),
    },
  });

  if (bool("show-context")) {
    printContext(context);
    return 0;
  }

  const systemFile = flag("system-file");
  const system = systemFile
    ? await readFile(systemFile, "utf8")
    : (flag("system") ?? process.env["ASK_SYSTEM"] ?? DEFAULT_SYSTEM);

  const baseURL = flag("base-url") ?? process.env["OPENAI_BASE_URL"];
  const request = buildRequest({
    prompt: renderPrompt(question, context, stdinText),
    model: flag("model") ?? process.env["ASK_MODEL"] ?? DEFAULT_MODEL,
    system,
    maxTokens: numberOption(flag("max-tokens"), "max-tokens"),
    temperature: numberOption(flag("temperature"), "temperature"),
    tokenField: tokenFieldOption(flag("token-field")),
    baseURL,
  });

  if (bool("dry-run")) {
    process.stdout.write(`${JSON.stringify(request, null, 2)}\n`);
    return 0;
  }

  const client = createClient({
    apiKey: flag("api-key") ?? process.env["OPENAI_API_KEY"],
    baseURL,
  });
  const result = await askOnce(client, request);

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
          },
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }

  process.stdout.write(`${result.text}\n`);

  if (!bool("quiet")) {
    process.stderr.write(
      `\n-- ${result.model} | ${context.blocks.length} file(s) ` +
        `${formatBytes(context.totalBytes)} | tokens in ${result.usage.input ?? "?"} ` +
        `out ${result.usage.output ?? "?"}\n`,
    );
    if (result.finishReason === "length") {
      process.stderr.write("-- warning: answer hit the token cap (--max-tokens)\n");
    }
    if (context.truncated) {
      process.stderr.write("-- warning: some context was truncated (--show-context to inspect)\n");
    }
  }
  return 0;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  if (error instanceof UsageError) {
    process.stderr.write(`ask: ${error.message}\n\n${USAGE}`);
    process.exitCode = 2;
  } else {
    const status =
      error !== null && typeof error === "object" && "status" in error && error.status
        ? ` (HTTP ${String(error.status)})`
        : "";
    process.stderr.write(`ask: ${error instanceof Error ? error.message : String(error)}${status}\n`);
    process.exitCode = 1;
  }
}
