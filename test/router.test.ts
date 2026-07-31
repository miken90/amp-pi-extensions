import { test, expect } from "bun:test";
import { tokenize, selectSkills, isExplicitSkillInvocation, buildTerms } from "../extensions/auto-skills/router.ts";
import type { IndexedSkill } from "../extensions/auto-skills/types.ts";

function skill(name: string, description: string, filePath = `/s/${name}/SKILL.md`): IndexedSkill {
  return {
    name,
    description,
    filePath,
    baseDir: `/s/${name}`,
    disableModelInvocation: false,
    mtimeMs: 0,
    source: "test",
  };
}

test("tokenize lowercases, splits, drops stopwords and short tokens", () => {
  const t = tokenize("Please DO help me with the DB, ok?");
  // "help" is a stopword (generic verb); "ok" is filler; "db" survives.
  expect(t).toEqual(["db"]);
});

test("selectSkills matches a skill by name with high score", () => {
  const skills = [skill("deploy", "Deploy apps to cloud platforms")];
  const sel = selectSkills("please deploy my app to the cloud", skills, { threshold: 1.5, maxSelected: 5 });
  expect(sel.length).toBe(1);
  expect(sel[0].skill.name).toBe("deploy");
  expect(sel[0].score).toBeGreaterThanOrEqual(3);
});

test("selectSkills matches by description terms", () => {
  const skills = [skill("util", "Generate diagrams and flowcharts for architecture")];
  const sel = selectSkills("create an architecture diagram", skills, { threshold: 1.5, maxSelected: 5 });
  expect(sel.length).toBe(1);
  expect(sel[0].skill.name).toBe("util");
});

test("ordinary requests with no relevance select zero skills", () => {
  const skills = [
    skill("deploy", "Deploy apps to cloud platforms"),
    skill("pdf", "Extract text and tables from PDF files"),
  ];
  const sel = selectSkills("tell me a joke about the weather", skills, { threshold: 1.5, maxSelected: 5 });
  expect(sel.length).toBe(0);
});

test("maxSelected caps the result count", () => {
  const skills = [
    skill("test", "Run unit and e2e tests"),
    skill("testing", "Testing utilities and fixtures"),
    skill("tester", "Tester workflow helpers"),
    skill("qa", "QA testing reports"),
  ];
  const sel = selectSkills("write tests for testing", skills, { threshold: 1, maxSelected: 2 });
  expect(sel.length).toBe(2);
});

test("results are sorted by score descending", () => {
  const skills = [
    skill("low", "Used only when discussing migration topics"),
    skill("high", "Database query optimization and indexes"),
  ];
  const sel = selectSkills("optimize database query and indexes", skills, { threshold: 1, maxSelected: 5 });
  expect(sel.length).toBe(1);
  expect(sel[0].skill.name).toBe("high");
});

test("disableModelInvocation skills are excluded from auto-selection", () => {
  const skills = [{ ...skill("secret", "Secret admin operations"), disableModelInvocation: true }];
  const sel = selectSkills("run the secret admin operation", skills, { threshold: 1, maxSelected: 5 });
  expect(sel.length).toBe(0);
});

test("isExplicitSkillInvocation recognizes /skill: and /ak: prefixes", () => {
  expect(isExplicitSkillInvocation("/skill:deploy")).toBe(true);
  expect(isExplicitSkillInvocation("  /skill:deploy now")).toBe(true);
  expect(isExplicitSkillInvocation("/ak:plan my feature")).toBe(true);
  expect(isExplicitSkillInvocation("please deploy")).toBe(false);
  expect(isExplicitSkillInvocation("/askills status")).toBe(false);
});

test("buildTerms splits hyphenated names into stemmed parts", () => {
  const terms = buildTerms(skill("pdf-tools", "..."));
  expect(terms.nameTokens.has("pdf")).toBe(true);
  // "tools" stems to "tool"; matching stems both sides identically.
  expect(terms.nameTokens.has("tool")).toBe(true);
});

test("empty prompt or empty skills returns empty", () => {
  expect(selectSkills("", [skill("a", "b")], { threshold: 0, maxSelected: 5 }).length).toBe(0);
  expect(selectSkills("hello world", [], { threshold: 0, maxSelected: 5 }).length).toBe(0);
});
