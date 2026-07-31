// auto-skills: automatically select and load materially relevant installed
// skills from a natural-language user request. Skill metadata is refreshed
// (mtime-aware, add/modify/remove) before each turn, and a stable snapshot is
// kept for the active turn. Explicit /skill:name and /ak: invocation always
// wins and bypasses routing.
//
// Default export is a Pi extension factory. `deps` is optional and exists so
// the factory logic can be unit-tested with a fake parser and settings without
// importing the real pi-coding-agent package (which is only resolvable inside
// Pi at runtime).

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SkillIndex, defaultSkillDirs, type SkillParser } from "./discovery.ts";
import { scanSkillDir } from "./scanner.ts";
import { isExplicitSkillInvocation } from "./router.ts";
import { routePrompt } from "./pipeline.ts";
import { readConfig, readState, writeState, type RuntimeState } from "./config.ts";
import { buildSelectedBlock, formatStatus } from "./prompt.ts";
import type { AutoSkillsConfig, ScoredSkill, SkillRef } from "./types.ts";

export interface AutoSkillsDeps {
  /** Override the skill-directory parser (tests inject a fake). */
  parseDir?: SkillParser;
  /** Read settings.json (global + project) as a merged parsed object. */
  readSettings?: () => Record<string, unknown> | undefined;
  /** Override the agent config dir (default $HOME/.pi/agent). Tests inject a temp dir. */
  agentDir?: () => string;
}

export default function autoSkills(pi: ExtensionAPI, deps?: AutoSkillsDeps): void {
  const parseDir: SkillParser = deps?.parseDir ?? scanSkillDir;
  const index = new SkillIndex(parseDir);
  let config: AutoSkillsConfig | undefined;
  let state: RuntimeState = { enabled: true };
  let turnExplicit = false;

  const agentDir = (): string => deps?.agentDir?.() ?? defaultAgentDir();

  const readSettings = deps?.readSettings ?? (() => readSettingsFiles(agentDir()));
  const loadConfig = (): AutoSkillsConfig => readConfig(readSettings());

  pi.on("session_start", async (_event, ctx) => {
    config = loadConfig();
    state = readState(agentDir());
    refresh(ctx.cwd);
    ctx.ui.setStatus("auto-skills", formatStatus([], state.enabled, index.size()));
  });

  // Detect explicit skill invocations on the raw input (pre-expansion) so they
  // can bypass auto-routing. Set per turn; consumed in before_agent_start.
  pi.on("input", async (event) => {
    if (event.source === "extension") return { action: "continue" };
    turnExplicit = isExplicitSkillInvocation(event.text);
    return { action: "continue" };
  });

  pi.on("before_agent_start", async (event, ctx) => {
    config = loadConfig();
    if (!config.enabled || !state.enabled) {
      ctx.ui.setStatus("auto-skills", formatStatus([], false, index.size()));
      return;
    }
    if (turnExplicit) {
      // Explicit /skill: or /ak: invocation wins; Pi's native expansion owns
      // the turn. Record the reason for observability and skip auto-routing.
      turnExplicit = false;
      state = { ...state, lastSelected: [], lastReason: "explicit" };
      ctx.ui.setStatus("auto-skills", formatStatus([], true, index.size()));
      return;
    }

    // Refresh metadata before routing this turn; keep a stable snapshot.
    const extra = skillRefsFromOptions(event.systemPromptOptions);
    refresh(ctx.cwd, extra);

    const selected = routePrompt(event.prompt, index.snapshot(), config).selected;

    state = {
      ...state,
      lastRefreshAt: Date.now(),
      lastSelected: selected.map((s) => ({ name: s.skill.name, score: s.score })),
      lastReason: selected.length ? "auto" : "no-match",
    };
    writeState(agentDir(), state);

    ctx.ui.setStatus("auto-skills", formatStatus(selected, true, index.size()));

    if (selected.length === 0) return; // no relevant skills: inject nothing

    const block = buildSelectedBlock(selected, config);
    if (!block) return;
    return { systemPrompt: event.systemPrompt + "\n" + block };
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    ctx.ui.setStatus("auto-skills", undefined);
  });

  function refresh(cwd: string, extra: SkillRef[] = []): void {
    const dirs = defaultSkillDirs(agentDir(), cwd);
    if (config?.locations?.length) {
      for (const loc of config.locations) dirs.push({ dir: expandHome(loc), source: "config" });
    }
    index.refresh(dirs, extra);
  }

  // ---- Commands: /askills [status|reload|enable|disable|test <query>] ----
  pi.registerCommand("askills", {
    description: "auto-skills: status, reload, enable, disable, or test routing",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const [sub, ...rest] = args.trim().split(/\s+/);
      config = loadConfig();
      switch (sub) {
        case "":
        case "status": {
          const snap = index.snapshot();
          ctx.ui.notify(
            `auto-skills: ${state.enabled ? "on" : "off"} • ${snap.length} skills • last ${
              state.lastSelected?.length ?? 0
            } (${state.lastReason ?? "-"})`,
            "info",
          );
          break;
        }
        case "reload": {
          index.clear();
          refresh(ctx.cwd);
          ctx.ui.notify(`auto-skills: reloaded ${index.size()} skills`, "info");
          break;
        }
        case "enable": {
          state = { ...state, enabled: true };
          writeState(agentDir(), state);
          ctx.ui.notify("auto-skills: enabled", "info");
          break;
        }
        case "disable": {
          state = { ...state, enabled: false };
          writeState(agentDir(), state);
          ctx.ui.notify("auto-skills: disabled", "info");
          break;
        }
        case "test": {
          const query = rest.join(" ");
          if (!query) {
            ctx.ui.notify("usage: /askills test <query or full contract>", "info");
            break;
          }
          // routePrompt applies the same parse + authority pipeline as a real
          // turn, so dry-runs reflect actual selection (including Mik gates).
          const selected = routePrompt(query, index.snapshot(), config).selected;
          const summary =
            selected.length === 0
              ? `auto-skills test: none (threshold ${config.threshold}, authority ${config.enforceAuthority ? "on" : "off"})`
              : `auto-skills test: ${selected.map((s) => `${s.skill.name}(${s.score.toFixed(1)})`).join(", ")}`;
          ctx.ui.notify(summary, "info");
          break;
        }
        default:
          ctx.ui.notify("usage: /askills [status|reload|enable|disable|test <query>]", "info");
      }
    },
  });
}

function expandHome(p: string): string {
  if (p.startsWith("~")) return `${process.env.HOME ?? ""}${p.slice(1)}`;
  return p;
}

function defaultAgentDir(): string {
  const home = (typeof process !== "undefined" && process.env.HOME) || "~";
  return `${home}/.pi/agent`;
}

// Read global (~/.pi/agent/settings.json) and project (.pi/settings.json)
// settings, merging project over global. Best-effort; returns undefined if
// neither file is readable.
function readSettingsFiles(agentDir: string): Record<string, unknown> | undefined {
  const merged: Record<string, unknown> = {};
  let found = false;
  for (const file of [join(agentDir, "settings.json"), join(process.cwd(), ".pi", "settings.json")]) {
    if (!existsSync(file)) continue;
    try {
      const data = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      Object.assign(merged, data);
      found = true;
    } catch {
      // ignore malformed settings
    }
  }
  return found ? merged : undefined;
}

// Pull SkillRefs from Pi's loaded skill catalog without forcing a runtime
// import of the Skill type (structural compatibility is enough).
function skillRefsFromOptions(options: {
  skills?: Array<{ name: string; description: string; filePath: string; baseDir: string; disableModelInvocation?: boolean }>;
}): SkillRef[] {
  return (options.skills ?? []).map((s) => ({
    name: s.name,
    description: s.description,
    filePath: s.filePath,
    baseDir: s.baseDir,
    disableModelInvocation: s.disableModelInvocation ?? false,
  }));
}
