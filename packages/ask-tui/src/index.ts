// Use the Node launcher so repository Bun hooks cannot execute before this entry.
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createClient, DEFAULT_MODEL, isInsecureHttpEndpoint, isLoopbackEndpoint } from "@codehaus-au/ask/internal/chat";
import { describeSettings, flagLayer, globalConfigDir, loadSettings, saveGlobalSetting } from "@codehaus-au/ask/internal/config";
import { legacyEnvNotice } from "@codehaus-au/ask/internal/env";
import { loadInstructions, renderInstructions } from "@codehaus-au/ask/internal/instructions";
import { mentionCandidates } from "@codehaus-au/ask/internal/refs";
import { terminalField } from "@codehaus-au/ask/internal/terminal";
import { DEFAULT_RESPONSE_TIMEOUT_MS, timeoutSecondsToMs } from "@codehaus-au/ask/internal/timeout";
import { TuiChat } from "./chat.ts";
import { discoverSkills, skillSearchPaths, SkillResolutionError } from "@codehaus-au/ask/internal/skills";
import { loadCustomThemes } from "./custom-themes.ts";
import { themeModes } from "./themes.ts";

const HELP = `ask-tui — user-driven OpenTUI chat (Bun 1.3.14+)
Usage: ask-tui [--model <id>] [--base-url <url>] [--api-key <key>]
               [--system <text>] [--max-tokens <n>] [--temperature <n>]
               [--allow-insecure-http] [--skill <name>]... [--list-skills]
               [--context-window <tokens>] [--timeout <seconds>] [--theme <name>] [--no-mouse]
               [--config <dir>] [--show-config] [--no-instructions]
Configuration is shared with ask (lowest precedence first): ~/.config/ask/ (or
$XDG_CONFIG_HOME/ask), --config <dir> or $ASK_CONFIG, the project's ask.json(c),
its .ask/ directory, $ASK_CONFIG_CONTENT, ASK_* variables, then flags. TUI settings
go in tui.json(c): theme, contextWindow, mouse. A project cannot choose the
endpoint or key, or use {env:VAR}, until you run: ask /trust
 --show-config prints each setting and where it came from.
 --check-config validates common, CLI and TUI settings, then exits.
AGENTS.md from each config directory and the project root, plus configured
instructions files, are added to the system prompt; --no-instructions skips them.
One logical completion per submission; no model tools or agent loop.
Up to two SDK retries resend the same request body after transient failures.
Mention @files or @folders anywhere. Suggested updates require review and /apply.
History is in memory for this TUI only. Ctrl+C copies a selection, otherwise exits.
Ctrl+D always exits. /help lists commands.
--skill selects instructions for this chat; repeat to compose skills.
--list-skills lists discovered skills offline; no key or terminal required.
--context-window (ASK_CONTEXT_WINDOW, tui.contextWindow): capacity in tokens.
It is never looked up. When set, the oldest history is dropped so each estimated
request fits, and a message too large even without history is refused before
sending. Without it, resent history is capped at about 32000 tokens.
--timeout (ASK_TIMEOUT, timeout): default 120 seconds per attempt; retries can extend total time.
--theme (ASK_THEME, tui.theme): default ask. Use /theme to preview and change themes.
Custom themes: themes/<name>.json(c) in any config directory, with colour roles
(background, panel, accent, text, muted, heading, summary, border, code, warning,
error, selectionBg, selectionFg) as hex, and optional "extends" and "mode".
--no-mouse (tui.mouse: false) leaves mouse selection to your terminal; /copy uses OSC52.
`;

async function main() {
  const { values } = parseArgs({ args: process.argv.slice(2), options: {
    model: { type: "string", short: "m" }, "base-url": { type: "string" },
    "api-key": { type: "string" }, system: { type: "string", short: "s" },
    "max-tokens": { type: "string" }, temperature: { type: "string" },
    "allow-insecure-http": { type: "boolean" }, help: { type: "boolean", short: "h" },
    skill: { type: "string", multiple: true }, "list-skills": { type: "boolean" },
    "context-window": { type: "string" }, "no-mouse": { type: "boolean" },
    timeout: { type: "string" }, theme: { type: "string" },
    config: { type: "string" }, "show-config": { type: "boolean" }, "no-instructions": { type: "boolean" },
    "check-config": { type: "boolean" },
  } });
  if (values.help) { process.stdout.write(HELP); return; }
  if (!("Bun" in globalThis)) throw new Error("ask-tui requires Bun 1.3.14+; the existing ask CLI still runs on Node.");
  if (!process.execArgv.includes("--no-env-file") || process.execArgv.some((arg) => /^--env-file(?:=|$)/.test(arg))) {
    throw new Error("Bun's .env autoload must be disabled. Use ask-tui or pnpm tui; do not pass --env-file.");
  }
  const bunConfig = fileURLToPath(new URL("./bunfig.toml", import.meta.url));
  if (!process.execArgv.includes(`--config=${bunConfig}`)) {
    throw new Error("Use ask-tui or pnpm tui to launch with Ask's trusted Bun configuration.");
  }
  const cwd = process.cwd();
  if (values["list-skills"]) {
    const roots = skillSearchPaths(cwd, process.env, values.config);
    const available = await discoverSkills(roots);
    process.stdout.write([
      ...available.map((skill) => `${terminalField(skill.name)} — ${terminalField(skill.description)}`),
      ...(available.length ? [] : ["No skills found."]),
      "Search paths:", ...roots.map((root) => `  ${terminalField(root)}`), "",
    ].join("\n"));
    return;
  }
  const loaded = await loadSettings({
    interface: values["check-config"] ? "all" : "tui",
    cwd, configDir: values.config,
    flags: flagLayer([
      ["--model", values.model, ["model"]],
      ["--system", values.system, ["system"]],
      ["--max-tokens", values["max-tokens"], ["maxTokens"]],
      ["--temperature", values.temperature, ["temperature"]],
      ["--timeout", values.timeout, ["timeout"]],
      ["--base-url", values["base-url"], ["endpoint", "url"]],
      ["--api-key", values["api-key"], ["endpoint", "apiKey"]],
      ["--theme", values.theme, ["tui", "theme"]],
      ["--context-window", values["context-window"], ["tui", "contextWindow"]],
      ["--no-mouse", values["no-mouse"] ? "false" : undefined, ["tui", "mouse"]],
    ]),
  });
  if (values["show-config"] || values["check-config"]) { process.stdout.write(`${describeSettings(loaded)}\n`); return; }
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("ask-tui requires an interactive terminal. Use ask for pipes and scripts.");
  const { settings } = loaded;
  const baseURL = settings.endpoint.url;
  if (isInsecureHttpEndpoint(baseURL) && !values["allow-insecure-http"]) {
    throw new Error("Refusing unencrypted remote HTTP; use HTTPS or explicitly pass --allow-insecure-http.");
  }
  const model = settings.model ?? DEFAULT_MODEL;
  const timeoutMs = settings.timeout === undefined ? DEFAULT_RESPONSE_TIMEOUT_MS : timeoutSecondsToMs(settings.timeout);
  const customThemes = await loadCustomThemes(loaded.directories);
  let theme = settings.tui.theme ?? "ask";
  let themeNotice: string | undefined;
  try {
    themeModes(theme); // Validate before creating a client or loading the native UI.
  } catch (error) {
    if (/^global tui\.jsonc?$/.test(loaded.sources.get("tui.theme") ?? "")) {
      // A saved project/--config theme may not exist in this directory. Keep the
      // saved preference for when it is available, but let this session start.
      themeNotice = `Saved theme ${terminalField(theme)} is unavailable here; using ask. Choose another with /theme.`;
      theme = "ask";
    } else {
      // Explicit choices still fail, with any broken custom file's diagnostic.
      throw new Error([error instanceof Error ? error.message : String(error), ...customThemes.notes].join("\n"));
    }
  }
  const apiKey = settings.endpoint.apiKey;
  if (!apiKey && !isLoopbackEndpoint(baseURL)) {
    // .env files that earlier versions read: the working directory and install location.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const legacy = await legacyEnvNotice([path.join(cwd, ".env"), path.resolve(here, "..", "..", ".env"), path.resolve(here, "..", ".env")]);
    const pairing = loaded.notes.filter((note) => note.includes("endpoint.apiKey"));
    throw new Error(`no API key: export OPENAI_API_KEY, set endpoint.apiKey in ${path.join(globalConfigDir(), "ask.json")}, or pass --api-key` +
      pairing.map((note) => `\n${note}`).join("") + (legacy ? `\n${legacy}` : "") +
      "\nRun ask-tui --show-config to see where each setting comes from.");
  }
  const readInstructions = () => values["no-instructions"]
    ? Promise.resolve({ files: [], notes: [] })
    : loadInstructions(loaded.instructions, loaded.projectRoot);
  const startupInstructions = await readInstructions();
  const lifetime = new AbortController();
  const chat = new TuiChat(createClient({
    apiKey, baseURL, organization: settings.endpoint.organization, project: settings.endpoint.project,
    timeoutMs, signal: lifetime.signal,
  }), {
    cwd, model, baseURL, system: settings.system ?? "",
    maxTokens: settings.maxTokens, temperature: settings.temperature,
    contextWindow: settings.tui.contextWindow,
    skillRoots: skillSearchPaths(cwd, process.env, values.config),
    instructions: async () => renderInstructions((await readInstructions()).files),
  });
  await chat.selectSkills(values.skill ?? []);
  // Never load the native UI from the existing Node entry point or offline help.
  const [{ createCliRenderer }, { mountChatUI }] = await Promise.all([
    import("@opentui/core"), import("./ui.ts"),
  ]);
  // The UI decides whether Ctrl+C copies a selection or exits.
  const renderer = await createCliRenderer({ exitOnCtrlC: false, useMouse: settings.tui.mouse !== false });
  renderer.once("destroy", () => lifetime.abort());
  const stop = () => renderer.destroy();
  process.once("SIGTERM", stop);
  process.once("SIGHUP", stop);
  try {
    // Shown in the transcript: stderr would be drawn over (or under) the UI.
    const notices = [...loaded.notes, ...customThemes.notes, ...startupInstructions.notes].map((note) => note.charAt(0).toUpperCase() + note.slice(1));
    if (themeNotice) notices.push(themeNotice);
    if (startupInstructions.files.length) {
      notices.push(`Instructions: ${startupInstructions.files.map((file) => terminalField(file.display)).join(", ")}`);
    }
    const saveTheme = async (name: string) => {
      const file = await saveGlobalSetting("tui", "theme", name);
      // A layer above the global file would still choose the theme next time.
      const source = loaded.sources.get("tui.theme");
      const winner = source && !source.startsWith("global ") ? source : null;
      const home = homedir();
      return {
        file: file.startsWith(`${home}${path.sep}`) ? `~${file.slice(home.length)}` : file,
        warning: winner ? `Saved, but ${terminalField(winner)} also sets the theme and takes precedence next time.` : undefined,
      };
    };
    mountChatUI(renderer, chat, model, {
      theme, notices, saveTheme, loadCandidates: () => mentionCandidates(cwd),
      ...(settings.tui.updateView ? { updateView: settings.tui.updateView } : {}),
    });
    await renderer.closed;
  } finally {
    lifetime.abort();
    renderer.destroy();
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGHUP", stop);
  }
}

main().catch((error: unknown) => {
  const candidates = error instanceof SkillResolutionError ? error.candidates.map((name) => `\n  ${terminalField(name)}`).join("") : "";
  // Escape each line: messages may span lines, but nothing else may control the terminal.
  const message = (error instanceof Error ? error.message : String(error)).split("\n").map(terminalField).join("\n");
  process.stderr.write(`ask-tui: ${message}${candidates}\n`);
  process.exitCode = 1;
});
