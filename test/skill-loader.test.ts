import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import skillLoader, {
  collectClaudeSkillDirs,
  findSkill,
  parseSkillEntries,
  transformSkillCommand,
  type SkillEntry,
} from "../extensions/skill-loader/index.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const entries: SkillEntry[] = [
  { name: "agent-browser", description: "Automate browser tasks", filePath: "/skills/agent-browser/SKILL.md" },
  { name: "ak-debug", description: "Debug systematically", filePath: "/skills/ak-debug/SKILL.md" },
];

function registeredTool(): ToolDefinition {
  let tool: ToolDefinition | undefined;
  skillLoader({
    on(): void {},
    registerTool(def: ToolDefinition): void {
      tool = def;
    },
  } as unknown as ExtensionAPI);
  if (!tool) throw new Error("skill tool was not registered");
  return tool;
}

function context(systemPrompt: string, sessionManager: object): ExtensionContext {
  return { getSystemPrompt: () => systemPrompt, sessionManager } as ExtensionContext;
}

function makeSkill(): string {
  const dir = mkdtempSync(join(tmpdir(), "amp-skill-"));
  tempDirs.push(dir);
  const path = join(dir, "SKILL.md");
  writeFileSync(path, "---\nname: ak-debug\ndescription: Debug systematically\n---\n\n# Debug workflow\nFind the root cause first.\n");
  return path;
}

function skillPrompt(filePath: string): string {
  return `<available_skills><skill><name>ak-debug</name><description>Debug systematically</description><location>${filePath}</location></skill></available_skills>`;
}

describe("skill-loader discovery", () => {
  test("parses and matches skills", () => {
    expect(parseSkillEntries(`<available_skills><skill><name>ak-debug</name><description>Debug &amp; fix</description><location>/skills/ak-debug/SKILL.md</location></skill></available_skills>`)).toEqual([
      { name: "ak-debug", description: "Debug & fix", filePath: "/skills/ak-debug/SKILL.md" },
    ]);
    expect(findSkill("agent browser", entries)?.name).toBe("agent-browser");
    expect(findSkill("ak debug", entries)?.name).toBe("ak-debug");
    expect(findSkill("agent beowser", entries)?.name).toBe("agent-browser");
  });

  test("discovers ancestor and global Claude skill directories", () => {
    const root = mkdtempSync(join(tmpdir(), "amp-claude-skills-"));
    tempDirs.push(root);
    const home = join(root, "home");
    const repo = join(root, "repo");
    const nested = join(repo, "packages", "app");
    const globalSkills = join(home, ".claude", "skills");
    const repoSkills = join(repo, ".claude", "skills");
    const nestedSkills = join(nested, ".claude", "skills");
    for (const dir of [globalSkills, repoSkills, nestedSkills, join(repo, ".git")]) mkdirSync(dir, { recursive: true });

    expect(collectClaudeSkillDirs(nested, home, true)).toEqual([nestedSkills, repoSkills, globalSkills]);
    expect(collectClaudeSkillDirs(nested, home, false)).toEqual([globalSkills]);
  });

  test("bypasses Pi's native slash-command expansion", () => {
    expect(transformSkillCommand("/skill:ak-debug")).toBe(" /skill:ak-debug");
    expect(transformSkillCommand("load ak-debug")).toBeUndefined();
  });
});

describe("skill tool", () => {
  test("registers mandatory invocation guidance", () => {
    const tool = registeredTool();
    expect(tool.name).toBe("skill");
    expect(tool.executionMode).toBe("parallel");
    expect(tool.promptGuidelines).toContain("When a task matches an entry in <available_skills>, call the skill tool before acting.");
  });

  test("loads a skill once per session", async () => {
    const tool = registeredTool();
    const filePath = makeSkill();
    const prompt = skillPrompt(filePath);
    const session = {};

    const first = await tool.execute("1", { name: "ak debug" }, undefined, undefined, context(prompt, session));
    const repeated = await tool.execute("2", { name: "ak-debug" }, undefined, undefined, context(prompt, session));
    const otherSession = await tool.execute("3", { name: "ak-debug" }, undefined, undefined, context(prompt, {}));

    expect(first.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("# Debug workflow") });
    expect(repeated.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("already active in this session") });
    expect(otherSession.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("# Debug workflow") });
  });
});
