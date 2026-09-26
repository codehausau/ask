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
 * Where to look for skills, highest priority first. `ASK_SKILLS_DIR` may list
 * several directories separated by the platform path delimiter.
 */
export function skillSearchPaths(
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const explicit = (env["ASK_SKILLS_DIR"] ?? "")
    .split(path.delimiter)
    .filter((entry) => entry.trim().length > 0)
    .map((entry) => path.resolve(entry));

  const xdg = env["XDG_CONFIG_HOME"];
  return [
    ...explicit,
    path.join(cwd, ".ask", "skills"),
    path.join(cwd, ".agents", "skills"),
    xdg ? path.join(path.resolve(xdg), "ask", "skills") : path.join(homedir(), ".config", "ask", "skills"),
    path.join(homedir(), ".claude", "skills"),
  ];
}

/**
 * Every skill found, deduplicated by name with earlier directories winning, so
 * a repository-local skill shadows a personal one of the same name.
 */
export async function discoverSkills(roots: readonly string[]): Promise<SkillSummary[]> {
  const byName = new Map<string, SkillSummary>();

  for (const root of roots) {
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch {
      continue; // absent search paths are normal
    }
    entries.sort((a, b) => a.localeCompare(b));

    for (const entry of entries) {
      const file = path.join(root, entry, "SKILL.md");
      const info = await stat(file).catch(() => null);
      if (!info?.isFile()) continue;

      let front: FrontMatter;
      try {
        front = parseFrontMatter(await readFile(file, "utf8"));
      } catch {
        continue;
      }
      const name = front.name ?? entry;
      if (byName.has(name)) continue; // first directory wins

      byName.set(name, {
        name,
        description: front.description,
        file,
        root,
        bytes: info.size,
      });
    }
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
