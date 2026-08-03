import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import skillLoader, {
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

function makeAPI(): { handlers: Map<string, (...args: any[]) => any>; tools: ToolDefinition[]; on(event: string, h: (...args: any[]) => any): void; registerTool(def: ToolDefinition): void } {
  const handlers = new Map<string, (...args: any[]) => any>();
  return {
    handlers,
    tools: [],
    on(event, h) { handlers.set(event, h); },
    registerTool(def) { this.tools.push(def); },
  };
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

  test("does NOT surface ~/.claude/skills or any resources_discover handler", () => {
    const api = makeAPI();
    skillLoader(api as unknown as ExtensionAPI);
    // No resources_discover handler is registered — Pi's built-in paths
    // (~/.pi/agent/skills and ~/.agents/skills) handle discovery instead.
    expect(api.handlers.has("resources_discover")).toBe(false);
  });

  test("bypasses Pi's native slash-command expansion", () => {
    expect(transformSkillCommand("/skill:ak-debug")).toBe(" /skill:ak-debug");
    expect(transformSkillCommand("load ak-debug")).toBeUndefined();
  });
});

describe("skill tool", () => {
  test("registers mandatory invocation guidance", () => {
    const api = makeAPI();
    skillLoader(api as unknown as ExtensionAPI);
    const tool = api.tools[0]!;
    expect(tool.name).toBe("skill");
    expect(tool.executionMode).toBe("parallel");
    expect(tool.promptGuidelines).toContain("When a task matches an entry in <available_skills>, call the skill tool before acting.");
  });

  test("loads a skill once per session", async () => {
    const api = makeAPI();
    skillLoader(api as unknown as ExtensionAPI);
    const tool = api.tools[0]!;
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
