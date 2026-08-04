import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  analyzeContent,
  applyPatch,
  convertAgentContent,
  convertAgents,
  convertModel,
  convertTools,
  findSkillFiles,
  normalizeName,
  readName,
  repairSkillNames,
  runAkUpdate,
} from "../scripts/update-pi-from-ak.ts";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function skillMd(name: string, description = "Does a thing. Use when testing."): string {
  return `---\nname: ${name}\ndescription: ${description}\nkeywords: [a, b]\n---\n\n# Body\n\nname: ck:CI\n`;
}

function writeRoot(skills: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "skill-names-"));
  tempDirs.push(root);
  for (const [dir, content] of Object.entries(skills)) {
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, dir, "SKILL.md"), content, "utf8");
  }
  return root;
}

describe("name parsing", () => {
  test("reads the frontmatter name only", () => {
    expect(readName(skillMd("ak:debug"))).toBe("ak:debug");
  });

  test("ignores files without frontmatter", () => {
    expect(readName("# Just markdown\nname: nope\n")).toBeNull();
  });

  test("normalizes namespaced and messy names", () => {
    expect(normalizeName("ak:debug")).toBe("ak-debug");
    expect(normalizeName("ck:CI")).toBe("ck-ci");
    expect(normalizeName('"ak:ui-ux-pro-max"')).toBe("ak-ui-ux-pro-max");
    expect(normalizeName("Some_Skill Name.v2")).toBe("some-skill-name-v2");
    expect(normalizeName("-ak--debug-")).toBe("ak-debug");
  });

  test("truncates to 64 characters without trailing hyphen", () => {
    const fixed = normalizeName(`${"a".repeat(63)}:b`);
    expect(fixed.length).toBeLessThanOrEqual(64);
    expect(fixed.endsWith("-")).toBe(false);
  });
});

describe("analyzeContent", () => {
  test("valid names are left alone", () => {
    expect(analyzeContent(skillMd("ak-debug")).kind).toBe("valid");
  });

  test("colon names are repairable", () => {
    const status = analyzeContent(skillMd("ak:debug"));
    expect(status).toMatchObject({ kind: "repairable", name: "ak:debug", fixed: "ak-debug" });
  });

  test("missing name is unrepairable", () => {
    expect(analyzeContent("---\ndescription: x\n---\n").kind).toBe("unrepairable");
  });

  test("nameless-after-normalization is unrepairable", () => {
    expect(analyzeContent(skillMd("::")).kind).toBe("unrepairable");
  });
});

describe("applyPatch", () => {
  test("rewrites frontmatter name and leaves the body untouched", () => {
    const patched = applyPatch(skillMd("ak:debug"), "ak-debug");
    expect(patched).toContain("name: ak-debug");
    expect(patched).not.toContain("name: ak:debug");
    // The `name: ck:CI` line inside the body is an example, not frontmatter.
    expect(patched).toContain("name: ck:CI");
  });
});

describe("findSkillFiles", () => {
  test("finds nested skills and skips dotdirs", () => {
    const root = writeRoot({
      "ak-debug": skillMd("ak:debug"),
      "ak-document-skills/ak-pdf": skillMd("ak:pdf"),
      ".venv/pkg": skillMd("ak:hidden"),
    });
    const files = findSkillFiles(root);
    expect(files.length).toBe(2);
    expect(files.some((f) => f.includes(".venv"))).toBe(false);
  });

  test("missing root yields nothing", () => {
    expect(findSkillFiles(join(tmpdir(), "definitely-missing-root-xyz"))).toEqual([]);
  });
});

describe("runAkUpdate", () => {
  test("invokes `ak update` with the given args and allows the repair on success", () => {
    const calls: string[][] = [];
    const result = runAkUpdate(["--global", "--yes"], (cmd) => {
      calls.push(cmd);
      return 0;
    });
    expect(result).toBeNull();
    expect(calls).toEqual([["ak", "update", "--global", "--yes"]]);
  });

  test("treats preview-only (exit 3) as repairable", () => {
    expect(runAkUpdate([], () => 3)).toBeNull();
  });

  test("propagates a real failure so the repair is skipped", () => {
    expect(runAkUpdate([], () => 1)).toBe(1);
  });
});

describe("repairSkillNames", () => {
  test("patches invalid names and backs up originals", () => {
    const root = writeRoot({ "ak-debug": skillMd("ak:debug"), "plain": skillMd("plain") });
    const result = repairSkillNames({ roots: [root] });

    expect(result.patched.length).toBe(1);
    const target = join(root, "ak-debug", "SKILL.md");
    expect(readFileSync(target, "utf8")).toContain("name: ak-debug");
    expect(existsSync(target + ".skill-name-backup")).toBe(true);
  });

  test("--check reports without writing", () => {
    const root = writeRoot({ "ak-debug": skillMd("ak:debug") });
    const result = repairSkillNames({ roots: [root], check: true });

    expect(result.patched).toEqual([]);
    expect(result.statuses[0]?.kind).toBe("repairable");
    const target = join(root, "ak-debug", "SKILL.md");
    expect(readFileSync(target, "utf8")).toContain("name: ak:debug");
    expect(existsSync(target + ".skill-name-backup")).toBe(false);
  });

  test("is idempotent", () => {
    const root = writeRoot({ "ak-debug": skillMd("ak:debug") });
    repairSkillNames({ roots: [root] });
    const second = repairSkillNames({ roots: [root] });
    expect(second.patched).toEqual([]);
    expect(second.statuses.every((s) => s.kind === "valid")).toBe(true);
  });

  test("flags but still repairs a name already declared elsewhere", () => {
    const root = writeRoot({
      taken: skillMd("ak-debug"),
      "ak-debug": skillMd("ak:debug"),
    });
    const result = repairSkillNames({ roots: [root] });

    expect(result.patched.length).toBe(1);
    const repaired = result.statuses.find((s) => s.kind === "repairable");
    expect(repaired && "collidesWith" in repaired && repaired.collidesWith).toContain("taken");
    expect(readFileSync(join(root, "ak-debug", "SKILL.md"), "utf8")).toContain("name: ak-debug");
  });

  test("--restore rolls back from backups", () => {
    const root = writeRoot({ "ak-debug": skillMd("ak:debug") });
    repairSkillNames({ roots: [root] });
    const result = repairSkillNames({ roots: [root], restore: true });

    expect(result.restored.length).toBe(1);
    expect(readFileSync(join(root, "ak-debug", "SKILL.md"), "utf8")).toContain("name: ak:debug");
  });
});

function claudeAgentMd(opts: {
  name?: string;
  description?: string;
  tools?: string;
  model?: string;
  body?: string;
} = {}): string {
  const {
    name = "advisor",
    description = "Runs an interview-driven advisory workflow.",
    tools = "Glob, Grep, Read, Bash, WebFetch, WebSearch, TaskCreate, SendMessage, Task(Explore)",
    model = "opus",
    body = "You are the advisor.\n",
  } = opts;
  return `---\nname: ${name}\ndescription: ${description}\ntools: ${tools}\nmodel: ${model}\nmemory: project\n---\n\n${body}`;
}

function writeAgentRoot(agents: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "claude-agents-"));
  tempDirs.push(root);
  for (const [file, content] of Object.entries(agents)) {
    writeFileSync(join(root, `${file}.md`), content, "utf8");
  }
  return root;
}

describe("convertTools", () => {
  test("maps known Claude Code tools to Pi tool ids, deduped and sorted", () => {
    const { tools, dropped } = convertTools("Glob, Grep, Read, Edit, MultiEdit, Bash");
    expect(tools).toEqual(["bash", "edit", "glob", "grep", "read"]);
    expect(dropped).toEqual([]);
  });

  test("drops Claude-only tools and reports them", () => {
    const { tools, dropped } = convertTools("Read, TaskCreate, SendMessage");
    expect(tools).toEqual(["read"]);
    expect(dropped).toEqual(["TaskCreate", "SendMessage"]);
  });

  test("maps Task(name) to the generic subagent tool", () => {
    const { tools, dropped } = convertTools("Read, Task(Explore)");
    expect(tools).toEqual(["read", "subagent"]);
    expect(dropped).toEqual([]);
  });

  test("undefined input yields no tools list", () => {
    expect(convertTools(undefined)).toEqual({ tools: undefined, dropped: [] });
  });
});

describe("convertModel", () => {
  test("maps known Claude model aliases to Pi model ids", () => {
    expect(convertModel("opus").model).toBe("claude-opus-5");
    expect(convertModel("fable").model).toBe("gpt-5.6-sol");
  });

  test("drops `inherit` so the caller's model applies", () => {
    expect(convertModel("inherit")).toEqual({ model: undefined, unmapped: undefined });
  });

  test("passes through unknown aliases and flags them as unmapped", () => {
    expect(convertModel("gpt-5.6-luna")).toEqual({
      model: "gpt-5.6-luna",
      unmapped: "gpt-5.6-luna",
    });
  });
});

describe("convertAgentContent", () => {
  test("converts tools, model, and preserves the body", () => {
    const result = convertAgentContent(claudeAgentMd(), "advisor.md");
    expect(result.kind).toBe("converted");
    if (result.kind !== "converted") return;
    expect(result.content).toContain("name: advisor");
    expect(result.content).toContain("model: claude-opus-5");
    expect(result.content).toContain("tools: bash, glob, grep, read, subagent, web_fetch, web_search");
    expect(result.content).toContain("You are the advisor.");
    expect(result.droppedTools).toEqual(["TaskCreate", "SendMessage"]);
    expect(result.content).not.toContain("memory:");
  });

  test("handles YAML block-scalar descriptions", () => {
    const content = claudeAgentMd({
      description: ">-\n  Multi-line description\n  across two lines.",
    });
    const result = convertAgentContent(content, "advisor.md");
    expect(result.kind).toBe("converted");
    if (result.kind !== "converted") return;
    expect(result.content).toContain("Multi-line description across two lines.");
  });

  test("is unconvertible without a name or description", () => {
    expect(convertAgentContent("---\ntools: Read\n---\nbody").kind).toBe("unconvertible");
  });
});

describe("convertAgents", () => {
  test("writes converted agents and backs up on re-conversion", () => {
    const src = writeAgentRoot({ advisor: claudeAgentMd() });
    const out = mkdtempSync(join(tmpdir(), "pi-agents-"));
    tempDirs.push(out);

    const first = convertAgents({ sourceRoots: [src], outRoot: out });
    expect(first.written.length).toBe(1);
    const outPath = join(out, "advisor.md");
    expect(existsSync(outPath)).toBe(true);
    expect(existsSync(outPath + ".ak-agent-backup")).toBe(false);

    const second = convertAgents({ sourceRoots: [src], outRoot: out });
    expect(second.written).toEqual([]); // idempotent: content unchanged
  });

  test("--check reports without writing", () => {
    const src = writeAgentRoot({ advisor: claudeAgentMd() });
    const out = mkdtempSync(join(tmpdir(), "pi-agents-"));
    tempDirs.push(out);

    const result = convertAgents({ sourceRoots: [src], outRoot: out, check: true });
    expect(result.written).toEqual([]);
    expect(existsSync(join(out, "advisor.md"))).toBe(false);
    expect(result.conversions[0]?.kind).toBe("converted");
  });

  test("--restore rolls back a changed conversion from backup", () => {
    const src = writeAgentRoot({ advisor: claudeAgentMd({ model: "opus" }) });
    const out = mkdtempSync(join(tmpdir(), "pi-agents-"));
    tempDirs.push(out);

    convertAgents({ sourceRoots: [src], outRoot: out });
    const outPath = join(out, "advisor.md");
    const original = readFileSync(outPath, "utf8");

    writeFileSync(join(src, "advisor.md"), claudeAgentMd({ model: "sonnet" }), "utf8");
    convertAgents({ sourceRoots: [src], outRoot: out });
    expect(readFileSync(outPath, "utf8")).toContain("claude-sonnet-5");
    expect(existsSync(outPath + ".ak-agent-backup")).toBe(true);

    const restored = convertAgents({ sourceRoots: [src], outRoot: out, restore: true });
    expect(restored.restored).toEqual([outPath]);
    expect(readFileSync(outPath, "utf8")).toEqual(original);
  });
});
