#!/usr/bin/env node
// A fixed runtime launch, not a model tool. Neither repository runtime hooks nor
// automatic .env loading may run before the application's own checks.
import { spawn } from "node:child_process";
import { constants } from "node:os";
import { fileURLToPath } from "node:url";
import { terminalField } from "@codehaus-au/ask/internal/terminal";
import { findBun } from "./bun-path.ts";

function fail(message: string) {
  process.stderr.write(`ask-tui: ${terminalField(message)}\n`);
  process.exitCode = 1;
}

let bun: string | null = null;
try { bun = findBun(); } catch (error) { fail(error instanceof Error ? error.message : String(error)); }
if (bun === null && process.exitCode !== 1) {
  fail("could not find Bun. Install Bun 1.3.14+ and put it on PATH, or set ASK_BUN to its absolute path. " +
    "Relative PATH entries, node_modules, and paths inside the current folder or repository are ignored.");
}

if (bun !== null) {
  const child = spawn(bun, [
    "--no-env-file", `--config=${fileURLToPath(new URL("./bunfig.toml", import.meta.url))}`,
    fileURLToPath(new URL("./index.js", import.meta.url)), ...process.argv.slice(2),
  ], {
    stdio: "inherit",
    shell: false,
  });
  const term = () => { child.kill("SIGTERM"); };
  const hup = () => { child.kill("SIGHUP"); };
  process.on("SIGTERM", term);
  process.on("SIGHUP", hup);
  const cleanup = () => {
    process.removeListener("SIGTERM", term);
    process.removeListener("SIGHUP", hup);
  };
  child.once("error", (error) => {
    cleanup();
    fail(`could not start Bun. Install Bun 1.3.14+ and put it on PATH. ${error.message}`);
  });
  child.once("exit", (code, signal) => {
    cleanup();
    // A signalled child exits the way a shell reports it: 128 + signal number.
    process.exitCode = signal ? 128 + (constants.signals[signal] ?? 0) : code ?? 1;
  });
}
