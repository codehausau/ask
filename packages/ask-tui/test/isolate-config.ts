// Loaded before every test file (node --import / bun --preload). Tests must
// never read the developer's own ask config, which may hold a real API key:
// point XDG_CONFIG_HOME at an empty directory for this process and its children.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "ask-test-config-"));
process.env["XDG_CONFIG_HOME"] = dir;
// A custom config directory or inline config would be another layer.
delete process.env["ASK_CONFIG"];
delete process.env["ASK_CONFIG_CONTENT"];
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
