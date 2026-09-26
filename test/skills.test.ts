import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  discoverSkills,
  filterSkills,
  loadSkill,
  MAX_SKILL_BYTES,
  parseFrontMatter,
  rankSkill,
  renderSkills,
  resolveSkill,
  skillSearchPaths,
  SkillResolutionError,
  type SkillSummary,
} from "../src/skills.ts";

async function skillDir(
  skills: Record<string, string>,
): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "ask-skills-"));
  for (const [name, body] of Object.entries(skills)) {
    await mkdir(path.join(root, name), { recursive: true });
    await writeFile(path.join(root, name, "SKILL.md"), body);
  }
  return root;
}

function summary(name: string, description: string): SkillSummary {
  return { name, description, file: `/skills/${name}/SKILL.md`, root: "/skills", bytes: 100 };
}

test("front matter is parsed, and its absence is tolerated", () => {
  const withFront = parseFrontMatter(
    '---\nname: code-review\ndescription: "Review a diff. Use when asked to review."\n---\n\n# Body\n\nDo the thing.\n',
  );
  assert.equal(withFront.name, "code-review");
  assert.equal(withFront.description, "Review a diff. Use when asked to review.");
  assert.equal(withFront.body, "# Body\n\nDo the thing.");

  // No front matter: still usable, the directory name will be used.
  const bare = parseFrontMatter("# Just instructions\n");
  assert.equal(bare.name, null);
  assert.equal(bare.description, "");
  assert.equal(bare.body, "# Just instructions");

  // Unknown keys ignored, single quotes stripped, colons in values preserved.
  const extra = parseFrontMatter("---\nname: 'x'\nlicense: MIT\ndescription: a: b\n---\nbody\n");
  assert.equal(extra.name, "x");
  assert.equal(extra.description, "a: b");
});

test("search paths are ordered, with ASK_SKILLS_DIR first", () => {
  const paths = skillSearchPaths("/repo", {
    ASK_SKILLS_DIR: `/custom/one${path.delimiter}/custom/two`,
    XDG_CONFIG_HOME: "/cfg",
    HOME: "/home/x",
  });
  assert.deepEqual(paths.slice(0, 4), [
    "/custom/one",
    "/custom/two",
    path.join("/repo", ".ask", "skills"),
    path.join("/repo", ".agents", "skills"),
  ]);
  assert.ok(paths.includes(path.join("/cfg", "ask", "skills")));
});

test("discovery reads every SKILL.md, sorted by name", async () => {
  const root = await skillDir({
    beta: "---\nname: beta\ndescription: second\n---\nB\n",
    alpha: "---\nname: alpha\ndescription: first\n---\nA\n",
    "no-front": "just text\n",
  });

  const found = await discoverSkills([root]);
  assert.deepEqual(
    found.map((skill) => skill.name),
    ["alpha", "beta", "no-front"],
  );
  assert.equal(found[0]?.description, "first");
  assert.equal(found[2]?.name, "no-front", "directory name used when unnamed");
  assert.ok((found[0]?.bytes ?? 0) > 0);
});

test("a directory without SKILL.md is not a skill, and absent roots are fine", async () => {
  const root = await skillDir({ real: "---\nname: real\n---\nR\n" });
  await mkdir(path.join(root, "assets-only"));
  await writeFile(path.join(root, "assets-only", "notes.md"), "not a skill");

  const found = await discoverSkills([root, "/does/not/exist"]);
  assert.deepEqual(
    found.map((skill) => skill.name),
    ["real"],
  );
});

test("an earlier directory shadows a later one of the same name", async () => {
  const local = await skillDir({ review: "---\nname: review\ndescription: local\n---\nlocal\n" });
  const global = await skillDir({ review: "---\nname: review\ndescription: global\n---\nglobal\n" });

  const found = await discoverSkills([local, global]);
  assert.equal(found.length, 1);
  assert.equal(found[0]?.description, "local", "repository-local wins");
});

test("ranking prefers names over descriptions", () => {
  const skill = summary("bmad-code-review", "Review a diff for regressions");
  assert.equal(rankSkill(skill, "bmad-code-review"), 0);
  assert.equal(rankSkill(skill, "bmad"), 1);
  assert.equal(rankSkill(skill, "code-review"), 2);
  assert.equal(rankSkill(skill, "regressions"), 3, "description match ranks last");
  assert.equal(rankSkill(skill, "nothing"), null);
  assert.equal(rankSkill(skill, "BMAD-CODE-REVIEW"), 0, "case-insensitive");
});

test("filtering returns everything when the term is empty", () => {
  const skills = [summary("a", "first"), summary("b", "second")];
  assert.equal(filterSkills(skills, "").length, 2);
  assert.deepEqual(
    filterSkills(skills, "second").map((skill) => skill.name),
    ["b"],
  );
  assert.deepEqual(filterSkills(skills, "zzz"), []);
});

test("an exact name always wins over a search", () => {
  const skills = [summary("review", "x"), summary("review-extended", "y")];
  // "review" is a prefix of both, but one is an exact name.
  assert.equal(resolveSkill("review", skills).name, "review");
});

test("an ambiguous term lists the candidates instead of guessing", () => {
  const skills = [summary("code-review", "x"), summary("code-quality", "y")];
  const error = (() => {
    try {
      resolveSkill("code-", skills);
      return null;
    } catch (caught) {
      return caught;
    }
  })();

  assert.ok(error instanceof SkillResolutionError);
  assert.match(error.message, /matches 2 skills equally well/);
  assert.deepEqual(error.candidates, ["code-quality", "code-review"]);
});

test("unmatched and empty terms are reported clearly", () => {
  const skills = [summary("review", "x")];
  assert.throws(() => resolveSkill("nope", skills), /no skill matches "nope"/);
  assert.throws(() => resolveSkill("", skills), /needs a name/);
  assert.throws(() => resolveSkill("review", []), /no skills found/);
});

test("loading strips front matter and records how it matched", async () => {
  const root = await skillDir({
    review: "---\nname: review\ndescription: d\n---\n\nOnly the body matters.\n",
  });
  const [found] = await discoverSkills([root]);
  const loaded = await loadSkill(found!, "search");

  assert.equal(loaded.body, "Only the body matters.");
  assert.equal(loaded.matched, "search");
  assert.equal(loaded.body.includes("description:"), false, "front matter is not sent");
});

test("an oversized skill is refused rather than blowing the context", async () => {
  const root = await skillDir({ huge: `---\nname: huge\n---\n${"x".repeat(MAX_SKILL_BYTES + 10)}` });
  const [found] = await discoverSkills([root]);
  await assert.rejects(() => loadSkill(found!, "name"), /over the \d+ KB skill limit/);
});

test("rendering wraps each skill and nothing when there are none", async () => {
  const root = await skillDir({
    one: "---\nname: one\n---\nfirst instructions\n",
    two: "---\nname: two\n---\nsecond instructions\n",
  });
  const found = await discoverSkills([root]);
  const loaded = [await loadSkill(found[0]!, "name"), await loadSkill(found[1]!, "name")];

  assert.equal(
    renderSkills(loaded),
    '<skill name="one">\nfirst instructions\n</skill>\n\n<skill name="two">\nsecond instructions\n</skill>',
  );
  assert.equal(renderSkills([]), "", "no skills, no wrapper");
});
