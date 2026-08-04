// Extension-load smoke test: imports the real entry factory and exercises it
// against a mock ExtensionAPI with injected deps (fake parser + settings), so
// the real @earendil-works/pi-coding-agent package is never resolved at test
// time. Verifies the factory wires events/commands correctly and that the
// core behaviors hold: explicit-invocation precedence, no-match injects
// nothing, and a relevant match injects the selected-skills block.

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isExplicitSkillInvocation, parseExplicitSkillName } from "../extensions/auto-skills/router.ts";
import autoSkills, { type AutoSkillsDeps } from "../extensions/auto-skills/index.ts";
import type { SkillRef } from "../extensions/auto-skills/types.ts";

type Handler = (event: any, ctx: any) => Promise<any>;

interface MockAPI {
  handlers: Map<string, Handler>;
  commands: Map<string, { handler: (args: string, ctx: any) => Promise<void> }>;
  status: Map<string, string | undefined>;
  on(event: string, h: Handler): void;
  registerCommand(name: string, opts: { handler: (args: string, ctx: any) => Promise<void> }): void;
}

function makeAPI(): MockAPI {
  return {
    handlers: new Map(),
    commands: new Map(),
    status: new Map(),
    on(event, h) {
      this.handlers.set(event, h);
    },
    registerCommand(name, opts) {
      this.commands.set(name, opts);
    },
  };
}

const SKILLS: SkillRef[] = [
  { name: "deploy", description: "Deploy apps to cloud platforms like Vercel and Cloudflare", filePath: "/s/deploy/SKILL.md", baseDir: "/s/deploy", disableModelInvocation: false },
  { name: "pdf", description: "Extract text and tables from PDF files", filePath: "/s/pdf/SKILL.md", baseDir: "/s/pdf", disableModelInvocation: false },
  { name: "ak-advise", description: "Interview-driven advisory skill", filePath: "/s/ak-advise/SKILL.md", baseDir: "/s/ak-advise", disableModelInvocation: true },
];

let tmpAgent: string;
beforeEach(() => {
  tmpAgent = mkdtempSync(join(tmpdir(), "as-agent-"));
});
afterEach(() => {
  rmSync(tmpAgent, { recursive: true, force: true });
});

const deps: AutoSkillsDeps = {
  parseDir: () => [], // no on-disk skills; test skills come via systemPromptOptions
  readSettings: () => ({ autoSkills: { enabled: true, threshold: 1.5, maxSelected: 3 } }),
  agentDir: () => tmpAgent,
};

function ctxWith(cwd: string, api: MockAPI) {
  return {
    cwd,
    ui: { setStatus: (k: string, v: string | undefined) => api.status.set(k, v) },
  };
}

async function fire(api: MockAPI, event: string, ev: any, ctxCwd = "/proj") {
  const h = api.handlers.get(event);
  if (!h) throw new Error(`no handler for ${event}`);
  return h(ev, ctxWith(ctxCwd, api));
}

test("factory registers all lifecycle handlers and the /askills command", () => {
  const api = makeAPI();
  autoSkills(api as any, deps);
  for (const e of ["session_start", "input", "before_agent_start", "session_shutdown"]) {
    expect(api.handlers.has(e)).toBe(true);
  }
  expect(api.commands.has("askills")).toBe(true);
});

test("explicit /skill: invocation bypasses routing (wins)", async () => {
  const api = makeAPI();
  autoSkills(api as any, deps);
  await fire(api, "session_start", { reason: "startup" });
  await fire(api, "input", { text: "/skill:deploy something", source: "interactive" });
  const res = await fire(api, "before_agent_start", {
    prompt: "deploy something", // post-expansion prompt would be skill body; still must NOT inject
    systemPrompt: "BASE",
    systemPromptOptions: { skills: SKILLS },
  });
  // Explicit invocation => no auto-injected block.
  expect(res).toBeUndefined();
});

test("skill-loader transformed /skill: invocation still bypasses routing", async () => {
  const api = makeAPI();
  autoSkills(api as any, deps);
  await fire(api, "session_start", { reason: "startup" });
  await fire(api, "input", { text: " /skill:deploy something", source: "interactive" });
  const res = await fire(api, "before_agent_start", {
    prompt: " /skill:deploy something",
    systemPrompt: "BASE",
    systemPromptOptions: { skills: SKILLS },
  });
  expect(res).toBeUndefined();
});

test("ordinary no-match request injects nothing and updates status", async () => {
  const api = makeAPI();
  autoSkills(api as any, deps);
  await fire(api, "session_start", { reason: "startup" });
  await fire(api, "input", { text: "tell me a joke about cats", source: "interactive" });
  const res = await fire(api, "before_agent_start", {
    prompt: "tell me a joke about cats",
    systemPrompt: "BASE",
    systemPromptOptions: { skills: SKILLS },
  });
  expect(res).toBeUndefined();
  expect(api.status.get("auto-skills")).toContain("auto-skills: -");
});

test("relevant match injects selected-skills block into system prompt", async () => {
  const api = makeAPI();
  autoSkills(api as any, deps);
  await fire(api, "session_start", { reason: "startup" });
  await fire(api, "input", { text: "please deploy my app to the cloud", source: "interactive" });
  const res = await fire(api, "before_agent_start", {
    prompt: "please deploy my app to the cloud",
    systemPrompt: "BASE",
    systemPromptOptions: { skills: SKILLS },
  });
  expect(res).toBeTruthy();
  expect(res.systemPrompt).toContain("BASE");
  expect(res.systemPrompt).toContain("<auto-skills>");
  expect(res.systemPrompt).toContain("deploy");
  expect(api.status.get("auto-skills")).toContain("deploy");
});

test("disabled (via command) suppresses routing", async () => {
  const api = makeAPI();
  autoSkills(api as any, deps);
  await fire(api, "session_start", { reason: "startup" });
  // Run the disable command.
  await api.commands.get("askills")!.handler("disable", {
    cwd: "/proj",
    ui: { setStatus: (k: string, v: string | undefined) => api.status.set(k, v), notify: () => {} },
  } as any);
  await fire(api, "input", { text: "deploy my app", source: "interactive" });
  const res = await fire(api, "before_agent_start", {
    prompt: "deploy my app",
    systemPrompt: "BASE",
    systemPromptOptions: { skills: SKILLS },
  });
  expect(res).toBeUndefined();
  expect(api.status.get("auto-skills")).toContain("off");
});

test("/askills test dry-run reports selected skill and score", async () => {
  const api = makeAPI();
  autoSkills(api as any, deps);
  await fire(api, "session_start", { reason: "startup" });
  // Seed the index with the Pi catalog (normally populated from real skill dirs
  // at session start; here it arrives via systemPromptOptions on first turn).
  await fire(api, "input", { text: "seed", source: "interactive" });
  await fire(api, "before_agent_start", {
    prompt: "seed",
    systemPrompt: "BASE",
    systemPromptOptions: { skills: SKILLS },
  });
  const notes: string[] = [];
  await api.commands.get("askills")!.handler("test deploy to cloud", {
    cwd: "/proj",
    ui: { setStatus: () => {}, notify: (_m: string) => notes.push(_m) },
  } as any);
  expect(notes.join(" ")).toContain("deploy");
});

test("explicit /skill: invocation of a disable-model-invocation skill injects hint", async () => {
  const api = makeAPI();
  autoSkills(api as any, deps);
  await fire(api, "session_start", { reason: "startup" });
  // Seed the index so ak-advise is known.
  await fire(api, "input", { text: "seed", source: "interactive" });
  await fire(api, "before_agent_start", {
    prompt: "seed",
    systemPrompt: "BASE",
    systemPromptOptions: { skills: SKILLS },
  });
  // Now explicitly invoke the hidden skill.
  await fire(api, "input", { text: "/skill:ak-advise", source: "interactive" });
  const res = await fire(api, "before_agent_start", {
    prompt: " /skill:ak-advise",
    systemPrompt: "BASE",
    systemPromptOptions: { skills: SKILLS },
  });
  expect(res).toBeTruthy();
  expect(res.systemPrompt).toContain("<explicit-skill-hint>");
  expect(res.systemPrompt).toContain("ak-advise");
});

test("explicit /skill: invocation of a normal skill does NOT inject hint", async () => {
  const api = makeAPI();
  autoSkills(api as any, deps);
  await fire(api, "session_start", { reason: "startup" });
  await fire(api, "input", { text: "seed", source: "interactive" });
  await fire(api, "before_agent_start", {
    prompt: "seed",
    systemPrompt: "BASE",
    systemPromptOptions: { skills: SKILLS },
  });
  await fire(api, "input", { text: "/skill:deploy", source: "interactive" });
  const res = await fire(api, "before_agent_start", {
    prompt: " /skill:deploy",
    systemPrompt: "BASE",
    systemPromptOptions: { skills: SKILLS },
  });
  expect(res).toBeUndefined();
});

test("explicit /skill: of hidden skill injects hint even when input handler skipped (skill-loader transform)", async () => {
  const api = makeAPI();
  autoSkills(api as any, deps);
  await fire(api, "session_start", { reason: "startup" });
  // Seed the index so ak-advise is known.
  await fire(api, "input", { text: "seed", source: "interactive" });
  await fire(api, "before_agent_start", {
    prompt: "seed",
    systemPrompt: "BASE",
    systemPromptOptions: { skills: SKILLS },
  });
  // Simulate skill-loader transform: input re-fired with source: "extension",
  // which auto-skills skips. The prompt in before_agent_start still has the
  // /skill: prefix, so the fallback detection must catch it.
  await fire(api, "input", { text: " /skill:ak-advise", source: "extension" });
  const res = await fire(api, "before_agent_start", {
    prompt: " /skill:ak-advise",
    systemPrompt: "BASE",
    systemPromptOptions: { skills: SKILLS },
  });
  expect(res).toBeTruthy();
  expect(res.systemPrompt).toContain("<explicit-skill-hint>");
  expect(res.systemPrompt).toContain("ak-advise");
});

test("parseExplicitSkillName extracts name from /skill: and /ak: invocations", () => {
  expect(parseExplicitSkillName("/skill:ak-advise")).toBe("ak-advise");
  expect(parseExplicitSkillName("  /skill:ak-advise some args")).toBe("ak-advise");
  expect(parseExplicitSkillName("/ak:plan my feature")).toBe("plan");
  expect(parseExplicitSkillName("please deploy")).toBeUndefined();
});
