// Skills: reusable instruction files injected into the system prompt.
//
// A skill is a directory containing SKILL.md with YAML front matter (`name`,
// `description`) — the same layout agent harnesses use, so existing skill
// directories work unchanged.
//
// The selection is always made here, never by the model. A model that could
// choose which skill to load would be making a tool call, which is the one
// thing this tool does not do. `--skill` names one, or searches for one and
// reports what it picked.
//
// Only SKILL.md is read. Bundled assets and scripts are ignored: a one-shot CLI
// cannot run them, and a large skill directory would silently eat the context
// budget. Files a skill refers to are attached with `@` like anything else.

import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

/** A SKILL.md larger than this is refused rather than blowing the context. */
export const MAX_SKILL_BYTES = 128 * 1024;

export interface SkillSummary {
  readonly name: string;
  readonly description: string;
  /** Absolute path to the SKILL.md. */
  readonly file: string;
  /** The search directory it came from. */
  readonly root: string;
  readonly bytes: number;
}

export interface LoadedSkill extends SkillSummary {
  /** SKILL.md with its front matter removed. */
  readonly body: string;
  /** How `--skill <term>` matched: by name, or by searching descriptions. */
  readonly matched: "name" | "search";
}

export class SkillResolutionError extends Error {
  readonly term: string;
  readonly candidates: readonly string[];

  constructor(message: string, term: string, candidates: readonly string[] = []) {
    super(message);
    this.name = "SkillResolutionError";
    this.term = term;
    this.candidates = candidates;
  }
}

export interface FrontMatter {
  readonly name: string | null;
  readonly description: string;
  readonly body: string;
}

/**
 * Parse the leading `---` block. Deliberately minimal: `key: value` lines with
 * optional quotes. A file without front matter is still usable — the directory
 * name becomes the skill name.
 */
export function parseFrontMatter(text: string): FrontMatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) return { name: null, description: "", body: text.trim() };

  const fields = new Map<string, string>();
  for (const line of (match[1] ?? "").split(/\r?\n/)) {
    const field = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line.trim());
    if (!field) continue;
    let value = (field[2] ?? "").trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    fields.set(field[1]!.toLowerCase(), value);
  }

  return {
    name: fields.get("name") ?? null,
    description: fields.get("description") ?? "",
    body: (match[2] ?? "").trim(),
  };
}

/**
 * Where to look for skills, highest priority first:
 *
 *   $ASK_SKILLS_DIR          explicit, may list several directories
 *   ./.ask/skills            then the same two in every ancestor directory,
 *   ./.agents/skills         nearest first — skills usually live at the
 *                            workspace root while you work in a sub-project
 *   ~/.config/ask/skills     personal
 *   ~/.claude/skills         shared with an agent harness
 *
 * Ancestors are searched because running from `repo/packages/thing` should still
 * find `repo/.agents/skills`, the same way git finds its root.
 */
export function skillSearchPaths(
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const paths: string[] = [];

  for (const entry of (env["ASK_SKILLS_DIR"] ?? "").split(path.delimiter)) {
    if (entry.trim().length > 0) paths.push(path.resolve(entry));
  }

  let dir = path.resolve(cwd);
  for (;;) {
    paths.push(path.join(dir, ".ask", "skills"));
    paths.push(path.join(dir, ".agents", "skills"));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  const xdg = env["XDG_CONFIG_HOME"];
  paths.push(
    xdg ? path.join(path.resolve(xdg), "ask", "skills") : path.join(homedir(), ".config", "ask", "skills"),
  );
  paths.push(path.join(homedir(), ".claude", "skills"));

  // An ancestor may coincide with $HOME, so the same path can appear twice.
  return [...new Set(paths)];
}

/**
 * How deep to look below a search path. Five, because real layouts nest: a
 * synced skill set lands at <root>/synced/<bucket-id>/<skill>/SKILL.md. The walk
 * stops as soon as it finds a SKILL.md, so this only bounds grouping layers.
 */
export const MAX_SKILL_DEPTH = 5;

/** Directory names never descended into while looking for skills. */
const SKIP_SKILL_DIRS: ReadonlySet<string> = new Set([
  ".git",
  "node_modules",
  "assets",
  "resources",
  "scripts",
  "templates",
  "__pycache__",
]);

/** Markdown that documents a skill set rather than being a skill. */
const NOT_A_SKILL: ReadonlySet<string> = new Set([
  "readme.md",
  "license.md",
  "contributing.md",
  "changelog.md",
  "index.md",
]);

async function readSkill(file: string, root: string, fallbackName: string): Promise<SkillSummary | null> {
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) return null;

  let front: FrontMatter;
  try {
    front = parseFrontMatter(await readFile(file, "utf8"));
  } catch {
    return null;
  }
  return {
    name: front.name ?? fallbackName,
    description: front.description,
    file,
    root,
    bytes: info.size,
  };
}

/**
 * Every skill below the given roots, deduplicated by name with earlier roots
 * winning, so a repository-local skill shadows a personal one.
 *
 * Two layouts are accepted:
 *   <dir>/SKILL.md   the conventional form; the directory may also hold assets
 *   <dir>/<name>.md  a single-file skill, which is all a rubric needs
 *
 * Grouping directories are walked to MAX_SKILL_DEPTH, so skills/tak/cot/SKILL.md
 * is found. A directory containing SKILL.md is *not* descended into: everything
 * beside it is that skill's own material, not more skills.
 */
export async function discoverSkills(roots: readonly string[]): Promise<SkillSummary[]> {
  const byName = new Map<string, SkillSummary>();
  const visited = new Set<string>();

  async function walk(dir: string, root: string, depth: number): Promise<void> {
    if (depth > MAX_SKILL_DEPTH) return;

    // Guard against symlink loops.
    const key = path.resolve(dir);
    if (visited.has(key)) return;
    visited.add(key);

    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // absent or unreadable search paths are normal
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));

    // A SKILL.md here means this directory *is* a skill; do not look deeper.
    if (entries.some((entry) => entry.isFile() && entry.name === "SKILL.md")) {
      const skill = await readSkill(path.join(dir, "SKILL.md"), root, path.basename(dir));
      if (skill && !byName.has(skill.name)) byName.set(skill.name, skill);
      return;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || SKIP_SKILL_DIRS.has(entry.name)) continue;
        await walk(path.join(dir, entry.name), root, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;

      // Single-file skill: any markdown that is not obviously documentation.
      const lower = entry.name.toLowerCase();
      if (!lower.endsWith(".md") || NOT_A_SKILL.has(lower)) continue;

      const skill = await readSkill(
        path.join(dir, entry.name),
        root,
        entry.name.slice(0, -3),
      );
      if (skill && !byName.has(skill.name)) byName.set(skill.name, skill);
    }
  }

  for (const root of roots) {
    await walk(root, root, 1);
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Lower is better; null means no match. Exported because it is a contract. */
export function rankSkill(skill: SkillSummary, term: string): number | null {
  const needle = term.toLowerCase();
  const name = skill.name.toLowerCase();

  if (name === needle) return 0;
  if (name.startsWith(needle)) return 1;
  if (name.includes(needle)) return 2;
  if (skill.description.toLowerCase().includes(needle)) return 3;
  return null;
}

/** Skills whose name or description mentions `term`; all of them when empty. */
export function filterSkills(skills: readonly SkillSummary[], term: string): SkillSummary[] {
  if (term.trim().length === 0) return [...skills];
  return skills
    .map((skill) => ({ skill, rank: rankSkill(skill, term) }))
    .filter((entry): entry is { skill: SkillSummary; rank: number } => entry.rank !== null)
    .sort((a, b) => a.rank - b.rank || a.skill.name.localeCompare(b.skill.name))
    .map((entry) => entry.skill);
}

/** Resolve one `--skill <term>`: an exact name, else the single best match. */
export function resolveSkill(term: string, skills: readonly SkillSummary[]): SkillSummary {
  if (term.trim().length === 0) {
    throw new SkillResolutionError("--skill needs a name", term);
  }
  if (skills.length === 0) {
    throw new SkillResolutionError(
      `no skills found; looked in the directories listed by 'ask /skills'`,
      term,
    );
  }

  const exact = skills.find((skill) => skill.name === term);
  if (exact) return exact;

  const scored = skills
    .map((skill) => ({ skill, rank: rankSkill(skill, term) }))
    .filter((entry): entry is { skill: SkillSummary; rank: number } => entry.rank !== null);

  if (scored.length === 0) {
    throw new SkillResolutionError(`no skill matches "${term}"`, term);
  }

  const best = Math.min(...scored.map((entry) => entry.rank));
  const tied = scored
    .filter((entry) => entry.rank === best)
    .map((entry) => entry.skill)
    .sort((a, b) => a.name.localeCompare(b.name));

  if (tied.length > 1) {
    throw new SkillResolutionError(
      `"${term}" matches ${tied.length} skills equally well`,
      term,
      tied.map((skill) => skill.name),
    );
  }
  return tied[0]!;
}

/** Read a skill's body, refusing one large enough to distort the context. */
export async function loadSkill(
  skill: SkillSummary,
  matched: "name" | "search",
): Promise<LoadedSkill> {
  if (skill.bytes > MAX_SKILL_BYTES) {
    throw new SkillResolutionError(
      `${skill.name} is ${Math.round(skill.bytes / 1024)} KB, over the ${Math.round(
        MAX_SKILL_BYTES / 1024,
      )} KB skill limit`,
      skill.name,
    );
  }
  const front = parseFrontMatter(await readFile(skill.file, "utf8"));
  return { ...skill, body: front.body, matched };
}

/**
 * Skills become part of the system prompt: they are instructions, not data, and
 * keeping them out of the user message keeps attached files unambiguous.
 */
export function renderSkills(skills: readonly LoadedSkill[]): string {
  if (skills.length === 0) return "";
  return skills
    .map((skill) => `<skill name="${skill.name}">\n${skill.body}\n</skill>`)
    .join("\n\n");
}
