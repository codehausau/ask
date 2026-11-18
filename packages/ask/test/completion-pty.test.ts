import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

for (const picker of [false, true]) {
  test(`real readline TAB completion preserves shell metacharacters (${picker ? "fzf" : "plain"})`, async (t) => {
    if (picker) {
      try { await run("fzf", ["--version"]); }
      catch { t.skip("fzf is not installed; the plain readline path is still tested"); return; }
    }
    const base = await mkdtemp(path.join(tmpdir(), "ask-tab-"));
    t.after(() => rm(base, { recursive: true, force: true }));
    const names = [
      "pick_space name.ts",
      "pick_quote'name.ts",
      'pick_double"name.ts',
      "pick_$(printf INJECTED).ts",
      "pick_`printf INJECTED`.ts",
      "pick_;printf INJECTED;#.ts",
      "pick_|printf INJECTED.ts",
      "pick_[ab]*.ts",
      "pick_back\\slash.ts",
      "pick_$(printf injected>INJECTED).ts",
      ...(picker ? ["pick_line\nbreak.ts", "pick_trailing\n"] : []),
    ];
    const cases: { cwd: string; prefix: string; picker: boolean; expected: string[]; suffix?: string; unchanged?: boolean; models?: string }[] = [];
    for (const name of names) {
      const repo = path.join(base, String(cases.length));
      const cwd = path.join(repo, "files");
      await mkdir(cwd, { recursive: true });
      await writeFile(path.join(cwd, name), "");
      await run("git", ["-C", repo, "init", "-q"]);
      for (const [prefix, expected] of [
        ["ask @pick", [`@${name}`]],
        ["ask -f pick", ["-f", name]],
        ["ask --system-file pick", ["--system-file", name]],
        ["ask @", [`@${name}`]],
      ] as const) {
        cases.push({ cwd, prefix, picker, expected: [...expected] });
      }
    }
    for (const quote of ["'", '"']) {
      cases.push({ cwd: cases[0]!.cwd, prefix: `ask ${quote}@pick`, suffix: quote,
        picker, expected: ["@pick"], unchanged: true });
    }
    const nestedRepo = path.join(base, "nested-repo");
    const nestedCwd = path.join(nestedRepo, "files");
    await mkdir(path.join(nestedCwd, "nested"), { recursive: true });
    const nestedName = "nested/pick_$(printf injected>INJECTED).ts";
    await writeFile(path.join(nestedCwd, nestedName), "");
    await run("git", ["-C", nestedRepo, "init", "-q"]);
    cases.push({ cwd: nestedCwd, prefix: "ask @pick", picker, expected: [`@${nestedName}`] });
    cases.push({ cwd: cases[0]!.cwd, prefix: "ask -m model", picker,
      models: "model$(>INJECTED)", expected: ["-m", "model$(>INJECTED)"] });
    const dashCwd = path.join(base, "dash");
    await mkdir(dashCwd);
    await writeFile(path.join(dashCwd, "-leading.txt"), "");
    cases.push({ cwd: dashCwd, prefix: "ask -f -lead", picker, expected: ["-f", "./-leading.txt"] });
    const pending = run("python3", [path.join(ROOT, "test", "completion-pty.py")], { timeout: 90_000 });
    pending.child.stdin?.end(JSON.stringify({ completion: path.join(ROOT, "completions", "ask.bash"), cases }));
    const { stdout } = await pending;
    const results = JSON.parse(stdout) as { line: string; args: string[]; trace: string }[];
    assert.equal(results.length, cases.length);
    results.forEach((result, index) => {
      assert.deepEqual(result.args, cases[index]!.expected,
        `${cases[index]!.prefix} completed to ${JSON.stringify(result.line)}: ${result.trace}`);
      if (cases[index]!.unchanged) assert.equal(result.line, cases[index]!.prefix);
    });
    for (const scenario of cases) {
      assert.equal(await stat(path.join(scenario.cwd, "INJECTED")).then(() => true, () => false), false,
        "completion and ENTER must never execute filename command substitutions");
    }
  });
}
