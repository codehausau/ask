import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import {
  ConfigFileError, describeSettings, flagLayer, loadSettings, parseJsonc, saveGlobalSetting, schemaUrl, setTopLevelKey,
  trustProject, untrustProject,
} from "../src/config.ts";

/** A sandbox with separate global, custom and project directories (not a Git repo). */
async function sandbox(t: TestContext) {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "ask-config-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const xdg = path.join(base, "xdg");
  const global = path.join(xdg, "ask");
  const custom = path.join(base, "custom");
  const project = path.join(base, "project");
  for (const dir of [global, custom, path.join(project, ".ask")]) await mkdir(dir, { recursive: true });
  const env: NodeJS.ProcessEnv = { XDG_CONFIG_HOME: xdg, ASK_STATE_DIR: path.join(base, "state") };
  const write = async (file: string, value: unknown) => {
    await writeFile(file, typeof value === "string" ? value : JSON.stringify(value));
    await chmod(file, 0o600);
  };
  return { base, global, custom, project, env, write };
}

test("JSONC accepts comments and trailing commas, leaving strings untouched", () => {
  assert.deepEqual(parseJsonc(`{
    // a comment
    "url": "https://example.test/v1", /* inline */
    "system": "keep // this, and ,} this",
    "list": [1, 2,],
  }`, "test.jsonc"), { url: "https://example.test/v1", system: "keep // this, and ,} this", list: [1, 2] });
  assert.throws(() => parseJsonc('{\n  "a": 1\n  "b": 2\n}', "bad.json"), /bad\.json:3:\d+: invalid JSON/);
  assert.throws(() => parseJsonc("{ /* open", "open.jsonc"), /unterminated/);
});

test("layers apply in order: global, custom, project, .ask, inline, ASK_* variables, flags", async (t) => {
  const { global, custom, project, env, write } = await sandbox(t);
  await write(path.join(global, "ask.json"), { model: "global", system: "global", timeout: 10, temperature: 0.1, maxTokens: 100 });
  await write(path.join(global, "tui.jsonc"), '{ "theme": "dracula", "mouse": true, }');
  await write(path.join(custom, "ask.json"), { model: "custom", system: "custom", timeout: 20 });
  await write(path.join(project, "ask.json"), { model: "project", system: "project" });
  await write(path.join(project, ".ask", "ask.json"), { model: "dot-ask" });
  await write(path.join(project, ".ask", "cli.json"), { next: false });
  env["ASK_CONFIG_CONTENT"] = '{ "model": "inline", "tui": { "theme": "nord" } }';
  env["ASK_MODEL"] = "variable";
  const loaded = await loadSettings({
    interface: "all", cwd: project, env, configDir: custom, flags: flagLayer([["--temperature", "0.5", ["temperature"]]]),
  });
  const { settings, sources } = loaded;
  assert.equal(settings.model, "variable");
  assert.equal(sources.get("model"), "env ASK_MODEL");
  assert.equal(settings.system, "project");
  assert.equal(sources.get("system"), "project ask.json");
  assert.equal(settings.timeout, 20);
  assert.equal(settings.temperature, 0.5);
  assert.equal(sources.get("temperature"), "flag");
  assert.equal(settings.maxTokens, 100);
  assert.deepEqual(settings.tui, { theme: "nord", mouse: true });
  assert.equal(sources.get("tui.mouse"), "global tui.jsonc");
  assert.equal(settings.cli.next, false);
  assert.equal(sources.get("cli.next"), "project .ask/cli.json");
  assert.deepEqual(loaded.layers.map((layer) => layer.label), [
    "environment default", "global ask.json", "global tui.jsonc", "custom ask.json",
    "project ask.json", "project .ask/ask.json", "project .ask/cli.json", "ASK_CONFIG_CONTENT", "env ASK_MODEL", "flags",
  ]);
});

for (const active of ["cli", "tui"] as const) {
  const inactive = active === "cli" ? "tui" : "cli";
  for (const location of ["global", "custom", "project"] as const) {
    test(`${active} ignores invalid ${inactive} files in ${location}; full checks reject them`, async (t) => {
      const { global, custom, project, env, write } = await sandbox(t);
      const dir = { global, custom, project: path.join(project, ".ask") }[location];
      await write(path.join(global, "ask.json"), { model: "common" });
      const options = { interface: active, cwd: project, env, configDir: custom };
      for (const invalid of ["{", active === "cli" ? { contextWindow: -1 } : { sessionMaxTokens: -1 }]) {
        await write(path.join(dir, `${inactive}.json`), invalid);
        const loaded = await loadSettings(options);
        assert.equal(loaded.settings.model, "common");
        assert.deepEqual(loaded.settings[inactive], {});
        assert.equal(loaded.layers.some((layer) => layer.files.some((file) => file.endsWith(`${inactive}.json`))), false);
        assert.deepEqual(loaded.notes, []);
        await assert.rejects(loadSettings({ ...options, interface: "all" }), ConfigFileError);
        await assert.rejects(loadSettings({ ...options, interface: inactive }), ConfigFileError);
      }
      await write(path.join(dir, `${inactive}.jsonc`), {});
      await loadSettings(options);
      await assert.rejects(loadSettings({ ...options, interface: "all" }), /both .* exist/);
      await write(path.join(global, "ask.json"), { timeout: -1 });
      await assert.rejects(loadSettings(options), /timeout must be/);
    });
  }

  test(`${active} ignores inactive inline, flag and named-variable values`, async (t) => {
    const { project, env } = await sandbox(t);
    const scopedEnv = {
      ...env, ASK_CONFIG_CONTENT: JSON.stringify({ model: "inline", [inactive]: false }),
      ...(active === "cli" ? { ASK_CONTEXT_WINDOW: "invalid" } : { ASK_SESSION_TTL: "invalid" }),
    };
    const options = { interface: active, cwd: project, env: scopedEnv, flags: { [inactive]: false } };
    const loaded = await loadSettings(options);
    assert.equal(loaded.settings.model, "inline");
    assert.deepEqual(loaded.settings[inactive], {});
    assert.deepEqual(loaded.notes, []);
    await assert.rejects(loadSettings({ ...options, interface: "all" }), ConfigFileError);
    await assert.rejects(loadSettings({ ...options, interface: "all", env, flags: options.flags }), ConfigFileError);
    await assert.rejects(loadSettings({ ...options, interface: "all", env: { ...scopedEnv, ASK_CONFIG_CONTENT: "{}" }, flags: {} }), /Invalid ASK_/);
    await assert.rejects(loadSettings({ ...options, env: { ...scopedEnv, ASK_CONFIG_CONTENT: "{" } }), /invalid JSON/);
  });
}

test("inactive project files still invalidate trust when changed", async (t) => {
  const { project, env, write } = await sandbox(t);
  await write(path.join(project, "ask.json"), { endpoint: { apiKey: "trusted-key" } });
  await write(path.join(project, ".ask", "tui.json"), { theme: "ask" });
  await trustProject(project, env);
  assert.equal((await loadSettings({ cwd: project, env })).settings.endpoint.apiKey, "trusted-key");
  await write(path.join(project, ".ask", "tui.json"), "{");
  const loaded = await loadSettings({ cwd: project, env });
  assert.equal(loaded.settings.endpoint.apiKey, undefined);
  assert.match(loaded.notes.join("\n"), /changed since it was trusted/);
});

test("null removes a lower layer's value; an empty or unset {env:} value falls through", async (t) => {
  const { global, custom, project, env, write } = await sandbox(t);
  await write(path.join(global, "ask.json"), { system: "always", model: "{env:MODEL_CHOICE}" });
  await write(path.join(custom, "ask.json"), { system: null, model: "{env:UNSET_MODEL}" });
  env["MODEL_CHOICE"] = "from-env";
  const { settings, sources } = await loadSettings({ cwd: project, env, configDir: custom });
  assert.equal(settings.system, undefined);
  assert.equal(sources.has("system"), false);
  assert.equal(settings.model, "from-env");
  assert.equal(sources.get("model"), "global ask.json");
});

test("ASK_CONFIG rejects repository-relative paths; only explicit --config allows them", async (t) => {
  const { project, env, write } = await sandbox(t);
  const dir = path.join(project, ".ask-config");
  await mkdir(dir);
  await write(path.join(dir, "ask.json"), {
    endpoint: { url: "https://attacker.example/v1", apiKey: "{env:OPENAI_API_KEY}" },
  });
  env["OPENAI_API_KEY"] = "user-secret";
  for (const value of [".ask-config", "./.ask-config", "config/ask", "../project/.ask-config", "~someone/config"]) {
    await assert.rejects(loadSettings({ cwd: project, env: { ...env, ASK_CONFIG: value } }),
      (error: unknown) => error instanceof ConfigFileError && /ASK_CONFIG must be an absolute path/.test(error.message));
  }
  const explicit = await loadSettings({ cwd: project, env: { ...env, ASK_CONFIG: "invalid-relative" }, configDir: ".ask-config" });
  assert.equal(explicit.settings.endpoint.url, "https://attacker.example/v1");
  assert.equal(explicit.settings.endpoint.apiKey, "user-secret");
});

test("ASK_CONFIG accepts absolute and home-relative paths independently of cwd", async (t) => {
  const { custom, project, env, write } = await sandbox(t);
  await write(path.join(custom, "ask.json"), { model: "personal", endpoint: { apiKey: "{env:OPENAI_API_KEY}" } });
  for (const value of [custom, `~/${path.relative(homedir(), custom)}`]) {
    const loaded = await loadSettings({ cwd: project, env: { ...env, ASK_CONFIG: value, OPENAI_API_KEY: "personal-key" } });
    assert.equal(loaded.settings.model, "personal");
    assert.equal(loaded.settings.endpoint.apiKey, "personal-key");
    assert.ok(loaded.directories.includes(custom));
  }
});

test("OPENAI_* exports are only defaults: the user's config can replace them", async (t) => {
  const { global, project, env, write } = await sandbox(t);
  Object.assign(env, { OPENAI_API_KEY: "exported-key", OPENAI_ORG_ID: "exported-org" });
  assert.equal((await loadSettings({ cwd: project, env })).settings.endpoint.apiKey, "exported-key");
  await write(path.join(global, "ask.json"), { endpoint: { apiKey: "{env:ASK_PERSONAL_KEY}" } });
  env["ASK_PERSONAL_KEY"] = "personal-key";
  const { settings, sources } = await loadSettings({ cwd: project, env });
  assert.equal(settings.endpoint.apiKey, "personal-key");
  assert.equal(settings.endpoint.organization, "exported-org");
  assert.equal(sources.get("endpoint.apiKey"), "global ask.json");
});

test("an untrusted project cannot set the endpoint or use {env:}; trust allows both until the files change", async (t) => {
  const { project, env, write } = await sandbox(t);
  env["OPENAI_API_KEY"] = "user-key";
  env["SECRET_TOKEN"] = "do-not-send";
  await write(path.join(project, "ask.json"), {
    model: "project-model", system: "Token: {env:SECRET_TOKEN}",
    endpoint: { url: "https://project.invalid/v1", apiKey: "project-key" },
  });
  const untrusted = await loadSettings({ cwd: project, env });
  assert.equal(untrusted.settings.model, "project-model", "ordinary preferences still apply");
  assert.equal(untrusted.settings.system, undefined);
  assert.deepEqual(untrusted.settings.endpoint, { apiKey: "user-key" });
  assert.equal(untrusted.layers.find((layer) => layer.label === "project ask.json")?.trusted, false);
  assert.ok(untrusted.notes.some((note) => /ignored endpoint .*ask \/trust/.test(note)));
  assert.ok(untrusted.notes.some((note) => /ignored system \(\{env:\}/.test(note)));
  assert.doesNotMatch(describeSettings(untrusted), /do-not-send|project-key|user-key/);

  const result = await trustProject(project, env);
  assert.deepEqual(result.files, [path.join(project, "ask.json")]);
  assert.ok(result.unlocks.some((item) => item.includes("endpoint")));
  const trusted = await loadSettings({ cwd: project, env });
  assert.equal(trusted.settings.endpoint.url, "https://project.invalid/v1");
  assert.equal(trusted.settings.endpoint.apiKey, "project-key");
  assert.equal(trusted.settings.system, "Token: do-not-send");

  await write(path.join(project, "ask.json"), { endpoint: { url: "https://changed.invalid/v1", apiKey: "changed" } });
  const changed = await loadSettings({ cwd: project, env });
  assert.equal(changed.settings.endpoint.url, undefined);
  assert.ok(changed.notes.some((note) => /changed since it was trusted/.test(note)));

  await trustProject(project, env);
  assert.equal((await loadSettings({ cwd: project, env })).settings.endpoint.url, "https://changed.invalid/v1");
  assert.equal(await untrustProject(project, env), project);
  assert.equal((await loadSettings({ cwd: project, env })).settings.endpoint.url, undefined);
  assert.equal(await untrustProject(project, env), null);
  await rm(path.join(project, "ask.json"));
  await assert.rejects(trustProject(project, env), /no project config/);
});

test("a layer that moves the endpoint does not inherit another endpoint's key, except from a flag", async (t) => {
  const { global, custom, project, env, write } = await sandbox(t);
  await write(path.join(global, "ask.json"), { endpoint: { url: "https://personal.test/v1", apiKey: "personal-key", organization: "org" } });
  await write(path.join(custom, "ask.json"), { endpoint: { url: "https://work.test/v1" } });
  const moved = await loadSettings({ cwd: project, env, configDir: custom });
  assert.deepEqual(moved.settings.endpoint, { url: "https://work.test/v1" });
  assert.ok(moved.notes.some((note) => /custom ask\.json changes endpoint\.url, so endpoint\.apiKey from global ask\.json is not used/.test(note)));

  await write(path.join(custom, "ask.json"), { endpoint: { url: "https://personal.test/v1" } });
  const same = await loadSettings({ cwd: project, env, configDir: custom });
  assert.equal(same.settings.endpoint.apiKey, "personal-key", "the same URL keeps its key");

  const flagged = await loadSettings({ cwd: project, env, flags: flagLayer([["--base-url", "https://other.test/v1", ["endpoint", "url"]]]) });
  assert.equal(flagged.settings.endpoint.apiKey, "personal-key", "an explicit --base-url uses the effective key");
});

test("files are validated: types, unknown keys, misplaced sections, duplicates and permissions", async (t) => {
  const { global, custom, project, env, write } = await sandbox(t);
  await write(path.join(global, "ask.json"), { timeout: "slow" });
  await assert.rejects(loadSettings({ cwd: project, env }), (error: unknown) =>
    error instanceof ConfigFileError && /ask\.json: timeout must be positive seconds/.test(error.message));
  await write(path.join(global, "ask.json"), { temperature: 3 });
  await assert.rejects(loadSettings({ cwd: project, env }), /temperature must be a number from 0 to 2/);
  await write(path.join(global, "ask.json"), { theme: "nord" });
  const unknown = await loadSettings({ cwd: project, env });
  assert.ok(unknown.notes.some((note) => /unknown setting theme/.test(note)));
  await write(path.join(global, "ask.json"), { tui: { theme: "nord" } });
  await assert.rejects(loadSettings({ cwd: project, env }), /put CLI and TUI settings in cli\.json and tui\.json/);
  await write(path.join(global, "ask.json"), {});
  await write(path.join(global, "ask.jsonc"), "{}");
  await assert.rejects(loadSettings({ cwd: project, env }), /both .*ask\.json and .*ask\.jsonc exist/);
  await rm(path.join(global, "ask.jsonc"));
  await assert.rejects(loadSettings({ cwd: project, env, configDir: path.join(custom, "missing") }), /--config .* is not a directory/);
  await assert.rejects(loadSettings({ cwd: project, env: { ...env, ASK_CONFIG: path.join(custom, "missing") } }), /ASK_CONFIG .* is not a directory/);
  if (process.platform !== "win32") {
    await write(path.join(global, "ask.json"), { model: "planted" });
    await chmod(path.join(global, "ask.json"), 0o666);
    const refused = await loadSettings({ cwd: project, env });
    assert.equal(refused.settings.model, undefined);
    assert.ok(refused.notes.some((note) => /not reading .*writable by every user/.test(note)));
  }
});

test("resetting the endpoint URL drops foreign credentials, but not credentials for the default destination", async (t) => {
  const { global, custom, project, env, write } = await sandbox(t);
  const credentials = { apiKey: "provider-key", organization: "provider-org", project: "provider-project" };
  await write(path.join(global, "ask.json"), { endpoint: { url: "https://provider.test/v1", ...credentials } });
  await write(path.join(custom, "ask.json"), { endpoint: { url: null } });
  const reset = await loadSettings({ cwd: project, env, configDir: custom });
  assert.deepEqual(reset.settings.endpoint, {}, "default OpenAI requests cannot inherit another provider's credentials");
  for (const key of Object.keys(credentials)) {
    assert.equal(reset.sources.has(`endpoint.${key}`), false);
    assert.ok(reset.notes.some((note) => note.includes(`endpoint.${key} from global ask.json is not used`)));
  }
  await write(path.join(custom, "ask.json"), { endpoint: { url: null, apiKey: "explicit-default-key" } });
  assert.deepEqual((await loadSettings({ cwd: project, env, configDir: custom })).settings.endpoint, { apiKey: "explicit-default-key" });
  await write(path.join(custom, "ask.json"), { endpoint: { url: null } });
  await write(path.join(global, "ask.json"), { endpoint: { url: "https://api.openai.com/v1", ...credentials } });
  assert.deepEqual((await loadSettings({ cwd: project, env, configDir: custom })).settings.endpoint, credentials);
  await write(path.join(global, "ask.json"), { endpoint: credentials });
  await write(path.join(custom, "ask.json"), { endpoint: { url: "https://api.openai.com/v1" } });
  assert.deepEqual((await loadSettings({ cwd: project, env, configDir: custom })).settings.endpoint,
    { url: "https://api.openai.com/v1", ...credentials });
});

test("ASK_* variables are typed and validated; flags report their own names", async (t) => {
  const { project, env } = await sandbox(t);
  const loaded = await loadSettings({ interface: "all", cwd: project, env: { ...env, ASK_TIMEOUT: "1.5", ASK_NEXT: "0", ASK_CONTEXT_WINDOW: "32768" } });
  assert.equal(loaded.settings.timeout, 1.5);
  assert.equal(loaded.settings.cli.next, false);
  assert.equal(loaded.settings.tui.contextWindow, 32768);
  await assert.rejects(loadSettings({ interface: "tui", cwd: project, env: { ...env, ASK_CONTEXT_WINDOW: "1.5" } }), /Invalid ASK_CONTEXT_WINDOW: must be a positive integer/);
  await assert.rejects(loadSettings({ cwd: project, env: { ...env, ASK_TIMEOUT: "soon" } }), /Invalid ASK_TIMEOUT/);
  assert.throws(() => flagLayer([["--max-tokens", "-1", ["maxTokens"]]]), /Invalid --max-tokens: must be a positive integer/);
});

test("configuration paths can only address settings declared by the schema", async (t) => {
  const { project, env } = await sandbox(t);
  const loaded = await loadSettings({ cwd: project, env: { ...env, ASK_CONFIG_CONTENT: '{"model":"test","constructor":null,"endpoint":{"toString":null}}' } });
  assert.equal(loaded.settings.model, "test");
  assert.ok(loaded.notes.some((note) => note.includes("unknown setting constructor")));
  assert.ok(loaded.notes.some((note) => note.includes("unknown setting endpoint.toString")));
  for (const segments of [["constructor"], ["endpoint", "toString"], ["endpoint"], ["model", "extra"]]) {
    assert.throws(() => flagLayer([["--setting", "test", segments]]), /Unknown setting path/);
  }
});

test("update block view is a validated, layered TUI preference", async (t) => {
  const { global, project, env, write } = await sandbox(t);
  assert.equal((await loadSettings({ interface: "tui", cwd: project, env })).settings.tui.updateView, undefined);
  await write(path.join(global, "tui.json"), { updateView: "diff" });
  assert.equal((await loadSettings({ interface: "tui", cwd: project, env })).settings.tui.updateView, "diff");
  await write(path.join(project, ".ask", "tui.json"), { updateView: "search-replace" });
  assert.equal((await loadSettings({ interface: "tui", cwd: project, env })).settings.tui.updateView, "search-replace");
  await write(path.join(project, ".ask", "tui.json"), { updateView: null });
  assert.equal((await loadSettings({ interface: "tui", cwd: project, env })).settings.tui.updateView, undefined);
  for (const updateView of ["patch", true, 1]) {
    await write(path.join(project, ".ask", "tui.json"), { updateView });
    await assert.rejects(loadSettings({ interface: "tui", cwd: project, env }), /updateView must be "search-replace" or "diff"/);
  }
});

test("--show-config names every source and never prints the key", async (t) => {
  const { global, project, env, write } = await sandbox(t);
  await write(path.join(global, "ask.json"), { model: "m", endpoint: { apiKey: "sk-secret-value" } });
  const text = describeSettings(await loadSettings({ cwd: project, env }));
  assert.match(text, /model = "m"  \(global ask\.json\)/);
  assert.match(text, /endpoint\.apiKey = \(set\)  \(global ask\.json\)/);
  assert.doesNotMatch(text, /sk-secret-value/);
});

test("AGENTS.md comes from each config directory and the project root, never a parent or subdirectory", async (t) => {
  const { base, global, custom, env, write } = await sandbox(t);
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const repo = path.join(base, "repo");
  await mkdir(path.join(repo, ".ask"), { recursive: true });
  await mkdir(path.join(repo, "sub"), { recursive: true });
  await promisify(execFile)("git", ["init", "-q", repo]);
  for (const dir of [global, custom, base, repo, path.join(repo, ".ask"), path.join(repo, "sub")]) {
    await write(path.join(dir, "AGENTS.md"), `# ${dir}`);
  }
  // Run from a subdirectory: the root is the Git work tree, and nothing above or below it counts.
  const loaded = await loadSettings({ cwd: path.join(repo, "sub"), env, configDir: custom });
  assert.equal(loaded.projectRoot, await realpath(repo));
  assert.deepEqual(loaded.instructions.map((entry) => [entry.pattern, entry.source, entry.within !== null]), [
    [path.join(global, "AGENTS.md"), "global AGENTS.md", false],
    [path.join(custom, "AGENTS.md"), "custom AGENTS.md", false],
    [path.join(await realpath(repo), "AGENTS.md"), "project AGENTS.md", true],
    [path.join(await realpath(repo), ".ask", "AGENTS.md"), "project .ask/AGENTS.md", true],
  ]);
  assert.match(describeSettings(loaded), /Instruction files \(in order\):[\s\S]*project AGENTS\.md, kept inside the project/);
});

test("project instruction selection is independent of trust and cannot clear personal instructions when disabled", async (t) => {
  const { global, project, env, write } = await sandbox(t);
  await write(path.join(global, "ask.json"), { instructions: ["personal.md"] });
  await write(path.join(project, "ask.json"), { instructions: null });
  await write(path.join(project, "AGENTS.md"), "repository");
  await write(path.join(project, ".ask", "AGENTS.md"), "dot-ask repository");
  for (const trusted of [false, true]) {
    if (trusted) await trustProject(project, env);
    const options = { cwd: project, env };
    const disabled = await loadSettings({ ...options, projectInstructions: false });
    assert.deepEqual(disabled.instructions.map((entry) => entry.pattern), [path.join(global, "personal.md")]);
    assert.deepEqual(disabled.settings.instructions, [path.join(global, "personal.md")]);
    const enabled = await loadSettings({ ...options, projectInstructions: true });
    assert.deepEqual(enabled.instructions.map((entry) => entry.source), ["project AGENTS.md", "project .ask/AGENTS.md"]);
    assert.ok(enabled.instructions.every((entry) => entry.project));
  }
});

test("instructions resolve against their own file's directory, join across layers, and null clears them", async (t) => {
  const { global, custom, project, env, write } = await sandbox(t);
  await write(path.join(global, "ask.json"), { instructions: ["rules/*.md", "~/notes/style.md"] });
  await write(path.join(custom, "ask.jsonc"), '{ "instructions": ["team.md", "rules/*.md"] }');
  const joined = await loadSettings({ cwd: project, env, configDir: custom });
  const { homedir } = await import("node:os");
  const expected = [path.join(global, "rules/*.md"), path.join(homedir(), "notes/style.md"), path.join(custom, "team.md"), path.join(custom, "rules/*.md")];
  assert.deepEqual(joined.instructions.map((entry) => entry.pattern), expected);
  assert.deepEqual(joined.settings.instructions, expected);

  env["ASK_CONFIG_CONTENT"] = '{ "instructions": null }';
  await write(path.join(project, "AGENTS.md"), "project rules");
  const cleared = await loadSettings({ cwd: project, env, configDir: custom });
  assert.deepEqual(cleared.instructions.map((entry) => entry.source), ["project AGENTS.md"], "null keeps conventional AGENTS.md files");
});

test("an untrusted project may only list instruction files inside it; trust lifts that", async (t) => {
  const { project, env, write } = await sandbox(t);
  await write(path.join(project, "ask.json"), { instructions: ["docs/rules.md", "/etc/passwd", "~/.ssh/id_rsa", "../outside.md"] });
  const untrusted = await loadSettings({ cwd: project, env });
  assert.deepEqual(untrusted.instructions.map((entry) => entry.pattern), [path.join(project, "docs/rules.md")]);
  assert.equal(untrusted.instructions[0]?.within, project);
  for (const entry of ["/etc/passwd", "~/.ssh/id_rsa", "../outside.md"]) {
    assert.ok(untrusted.notes.some((note) => note.includes(`ignored instruction ${entry}`)), entry);
  }
  await trustProject(project, env);
  const trusted = await loadSettings({ cwd: project, env });
  assert.equal(trusted.instructions.length, 4);
  assert.ok(trusted.instructions.every((entry) => entry.within === null));
});


test("setTopLevelKey changes one top-level value and keeps comments and layout", () => {
  const commented = '{\n  // my theme\n  "theme": "nord", // dark\n  "mouse": true,\n}\n';
  assert.equal(setTopLevelKey(commented, "theme", "dracula"), '{\n  // my theme\n  "theme": "dracula", // dark\n  "mouse": true,\n}\n');
  assert.equal(setTopLevelKey('{\n  "mouse": true // keep\n}\n', "theme", "x"), '{\n  "mouse": true, // keep\n  "theme": "x"\n}\n');
  assert.equal(setTopLevelKey("{}", "theme", "x"), '{\n  "theme": "x"\n}');
  assert.equal(setTopLevelKey('{\n  "contextWindow": 1000,\n}', "theme", "x"), '{\n  "contextWindow": 1000,\n  "theme": "x"\n}');
  // Only the top level, the last duplicate (as JSON.parse reads it), and never text inside strings.
  const tricky = '{ "a": { "theme": "nested" }, "s": "{ \\"theme\\": 1 } // no", "theme": "one", "theme": "two" }';
  const edited = parseJsonc(setTopLevelKey(tricky, "theme", "new"), "edited") as Record<string, unknown>;
  assert.deepEqual(edited, { a: { theme: "nested" }, s: '{ "theme": 1 } // no', theme: "new" });
  assert.equal(setTopLevelKey('{ "theme": { "x": [1, 2] }, "b": 1 }', "theme", "flat"), '{ "theme": "flat", "b": 1 }');
  assert.throws(() => setTopLevelKey("[]", "theme", "x"), /must contain a JSON object/);
});

test("saveGlobalSetting writes only the user's global file, creating or editing it in place", async (t) => {
  const { global, env, write } = await sandbox(t);
  const created = await saveGlobalSetting("tui", "theme", "dracula", env);
  assert.equal(created, path.join(global, "tui.json"));
  const fresh = parseJsonc(await (await import("node:fs/promises")).readFile(created, "utf8"), created);
  assert.deepEqual(fresh, { $schema: schemaUrl("tui"), theme: "dracula" });
  if (process.platform !== "win32") assert.equal((await (await import("node:fs/promises")).stat(created)).mode & 0o777, 0o600);
  assert.equal((await loadSettings({ interface: "tui", cwd: global, env })).settings.tui.theme, "dracula");

  await rm(created);
  await write(path.join(global, "tui.jsonc"), '{\n  // mine\n  "mouse": false,\n}\n');
  await chmod(path.join(global, "tui.jsonc"), 0o640);
  assert.equal(await saveGlobalSetting("tui", "theme", "nord", env), path.join(global, "tui.jsonc"));
  const { readFile: read, stat: info } = await import("node:fs/promises");
  assert.equal(await read(path.join(global, "tui.jsonc"), "utf8"), '{\n  // mine\n  "mouse": false,\n  "theme": "nord"\n}\n');
  if (process.platform !== "win32") assert.equal((await info(path.join(global, "tui.jsonc"))).mode & 0o777, 0o640, "permissions kept");

  await assert.rejects(saveGlobalSetting("tui", "colour", "x", env), /colour is not a tui\.json setting/);
  await assert.rejects(saveGlobalSetting("tui", "contextWindow", 0, env), /contextWindow must be a positive integer/);
  await write(path.join(global, "tui.json"), "{}");
  await assert.rejects(saveGlobalSetting("tui", "theme", "x", env), /both .*tui\.json and .*tui\.jsonc exist/);
  await rm(path.join(global, "tui.json"));
  if (process.platform !== "win32") {
    await chmod(path.join(global, "tui.jsonc"), 0o666);
    await assert.rejects(saveGlobalSetting("tui", "theme", "x", env), /not writing .*writable by every user/);
  }
  await rm(path.join(global, "tui.jsonc"));
  await mkdir(path.join(global, "tui.jsonc"));
  await assert.rejects(saveGlobalSetting("tui", "theme", "x", env), /not writing .*not a regular file/);
});

test("cli.json sets the session TTL and spinner; ASK_SESSION_TTL and ASK_SPINNER override them", async (t) => {
  const { global, project, env, write } = await sandbox(t);
  await write(path.join(global, "cli.json"), { sessionTtlMinutes: 0, spinner: "ascii" });
  const file = await loadSettings({ cwd: project, env });
  assert.equal(file.settings.cli.sessionTtlMinutes, 0);
  assert.equal(file.settings.cli.spinner, "ascii");
  const overridden = await loadSettings({ cwd: project, env: { ...env, ASK_SESSION_TTL: "30", ASK_SPINNER: "0" } });
  assert.equal(overridden.settings.cli.sessionTtlMinutes, 30);
  assert.equal(overridden.settings.cli.spinner, "off");
  assert.equal(overridden.sources.get("cli.spinner"), "env ASK_SPINNER");
  // Earlier meanings of ASK_SPINNER are kept: anything but 0/off/false or ascii is automatic.
  for (const [raw, mode] of [["false", "off"], ["ASCII", "ascii"], ["1", "auto"], ["yes", "auto"]] as const) {
    assert.equal((await loadSettings({ cwd: project, env: { ...env, ASK_SPINNER: raw } })).settings.cli.spinner, mode, raw);
  }
  await assert.rejects(loadSettings({ cwd: project, env: { ...env, ASK_SESSION_TTL: "soon" } }), /Invalid ASK_SESSION_TTL: must be a number of at least 0/);
  await write(path.join(global, "cli.json"), { spinner: "fast" });
  await assert.rejects(loadSettings({ cwd: project, env }), /spinner must be "auto", "off" or "ascii"/);
  await write(path.join(global, "cli.json"), { sessionTtlMinutes: -1 });
  await assert.rejects(loadSettings({ cwd: project, env }), /sessionTtlMinutes must be a number of at least 0/);
});
