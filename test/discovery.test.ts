import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillIndex, defaultSkillDirs, type SkillParser } from "../extensions/auto-skills/discovery.ts";
import type { SkillRef } from "../extensions/auto-skills/types.ts";

// Minimal Pi-compatible parser: walk a dir for SKILL.md, parse frontmatter.
const fakeParser: SkillParser = (dir, source) => {
  const refs: SkillRef[] = [];
  const root = dir;
  let entries: string[] = [];
  try {
    entries = require("node:fs").readdirSync(root, { withFileTypes: true }).map((d: any) => d.name);
  } catch {
    return refs;
  }
  for (const name of entries) {
    const skillMd = join(root, name, "SKILL.md");
    try {
      const raw = require("node:fs").readFileSync(skillMd, "utf8") as string;
      const fm = parseFrontmatter(raw);
      if (!fm.name || !fm.description) continue;
      refs.push({
        name: fm.name,
        description: fm.description,
        filePath: skillMd,
        baseDir: join(root, name),
        disableModelInvocation: fm["disable-model-invocation"] === true,
      });
    } catch {
      // not a skill dir
    }
  }
  void source;
  return refs;
};

function parseFrontmatter(raw: string): Record<string, unknown> {
  const m = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const out: Record<string, unknown> = {};
  for (const line of m[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const k = line.slice(0, idx).trim();
    const v = line.slice(idx + 1).trim();
    out[k] = v;
  }
  return out;
}

let root: string;
const dir = (n: string) => ({ dir: join(root, n), source: "test" });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "as-skills-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function makeSkill(name: string, desc: string) {
  const skillDir = join(root, "skills", name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${desc}\n---\n# ${name}\nbody\n`,
  );
  return join(skillDir, "SKILL.md");
}

function bumpMtime(file: string) {
  // Set a distinct future mtime so the change is detectable regardless of FS
  // timestamp resolution; no sleep needed since stat reads the set value.
  const future = (Date.now() / 1000) + 60;
  utimesSync(file, future, future);
}

test("refresh detects added skills", () => {
  const idx = new SkillIndex(fakeParser);
  makeSkill("deploy", "Deploy apps to cloud providers");
  const r1 = idx.refresh([dir("skills")]);
  expect(r1.added.length).toBe(1);
  expect(r1.added[0].name).toBe("deploy");
  expect(r1.snapshot.length).toBe(1);
});

test("second refresh with no changes is stable (empty delta)", () => {
  const idx = new SkillIndex(fakeParser);
  makeSkill("deploy", "Deploy apps to cloud providers");
  idx.refresh([dir("skills")]);
  const r2 = idx.refresh([dir("skills")]);
  expect(r2.added.length).toBe(0);
  expect(r2.modified.length).toBe(0);
  expect(r2.removed.length).toBe(0);
});

test("refresh detects modification via mtime", () => {
  const idx = new SkillIndex(fakeParser);
  const file = makeSkill("deploy", "Deploy apps");
  idx.refresh([dir("skills")]);
  writeFileSync(file, `---\nname: deploy\ndescription: Deploy apps to cloud\n---\n`);
  bumpMtime(file);
  const r = idx.refresh([dir("skills")]);
  expect(r.modified.length).toBe(1);
  expect(r.modified[0].description).toBe("Deploy apps to cloud");
});

test("refresh detects removed skills", () => {
  const idx = new SkillIndex(fakeParser);
  const file = makeSkill("deploy", "Deploy apps");
  idx.refresh([dir("skills")]);
  unlinkSync(file);
  const r = idx.refresh([dir("skills")]);
  expect(r.removed.length).toBe(1);
  expect(r.removed[0].name).toBe("deploy");
  expect(idx.size()).toBe(0);
});

test("refresh merges extra (Pi-provided) skills", () => {
  const idx = new SkillIndex(fakeParser);
  makeSkill("local", "A local skill");
  const extra: SkillRef[] = [
    { name: "pkg", description: "From a package", filePath: "/pkg/SKILL.md", baseDir: "/pkg", disableModelInvocation: false },
  ];
  const r = idx.refresh([dir("skills")], extra);
  expect(r.added.length).toBe(2);
  expect(idx.size()).toBe(2);
  expect(idx.get("/pkg/SKILL.md")?.source).toBe("pi");
});

test("a broken directory does not abort the whole refresh", () => {
  const throwing: SkillParser = () => {
    throw new Error("boom");
  };
  const idx = new SkillIndex(throwing);
  makeSkill("a", "A skill");
  const r = idx.refresh([dir("skills"), { dir: "/no/such", source: "x" }]);
  expect(r.snapshot.length).toBe(0); // parser throws for every dir here
});

test("defaultSkillDirs includes global + project paths", () => {
  const dirs = defaultSkillDirs("/home/u/.pi/agent", "/proj");
  const paths = dirs.map((d) => d.dir);
  expect(paths).toContain("/home/u/.pi/agent/skills");
  expect(paths).toContain("/proj/.pi/skills");
});
