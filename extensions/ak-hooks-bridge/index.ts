// ak-hooks-bridge: runs AgentKit's Claude Code hook scripts (~/.claude/hooks/*.cjs,
// registered in ~/.claude/settings.json) as Pi extension event handlers.
//
// Pi has no `hooks.json`/PreToolUse-style hook system — it has typed extension
// events (`pi.on(...)`). AgentKit's skills/agents assume the Claude Code hook
// contract runs alongside them (privacy/scout blocking, plan-format nudges,
// session-state tracking, etc.). Rather than reimplementing ~20 hook scripts in
// TypeScript, this extension is a generic bridge: it reads the same hook
// registry AgentKit already wrote for Claude Code, and for every Pi event that
// has a faithful Claude Code equivalent, spawns the matching hook script with
// a Claude Code-shaped JSON payload on stdin and applies its verdict.
//
// Mapping (see README for the full rationale and the events that have no
// equivalent, e.g. SubagentStart/SubagentStop):
//   PreToolUse      -> tool_call             (blocking)
//   PostToolUse     -> tool_result           (additionalContext only)
//   UserPromptSubmit-> before_agent_start    (blocking + additionalContext)
//   SessionStart    -> session_start         (additionalContext only)
//   PreCompact      -> session_before_compact(blocking)
//   Stop            -> agent_settled         (fire-and-forget)

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  claudeToolName,
  defaultHooksSettingsPath,
  loadHookConfig,
  matchesReason,
  matchesTool,
  type HookConfig,
  type HookEntry,
} from "./config.ts";
import { runHooks, type Spawner } from "./runner.ts";

export type BridgeSettings = {
  enabled: boolean;
  hooksSettingsPath: string;
  /** Hook script basenames (e.g. "session-init.cjs") to never run. */
  disabledHooks: string[];
};

function defaultSettingsFiles(): string[] {
  return [join(homedir(), ".pi", "agent", "settings.json"), join(process.cwd(), ".pi", "settings.json")];
}

function readBridgeSettings(settingsFiles: readonly string[]): BridgeSettings {
  const defaults: BridgeSettings = {
    enabled: false,
    hooksSettingsPath: defaultHooksSettingsPath(),
    disabledHooks: [],
  };
  for (const file of settingsFiles) {
    if (!existsSync(file)) continue;
    try {
      const block = (JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>)
        .akHooksBridge;
      if (block && typeof block === "object") {
        const b = block as Record<string, unknown>;
        if (typeof b.enabled === "boolean") defaults.enabled = b.enabled;
        if (typeof b.hooksSettingsPath === "string") {
          defaults.hooksSettingsPath = b.hooksSettingsPath.startsWith("~")
            ? join(homedir(), b.hooksSettingsPath.slice(1).replace(/^\//, ""))
            : b.hooksSettingsPath;
        }
        if (Array.isArray(b.disabledHooks)) {
          defaults.disabledHooks = b.disabledHooks.filter((v): v is string => typeof v === "string");
        }
      }
    } catch {
      // ignore malformed settings; keep defaults so far
    }
  }
  return defaults;
}

function filterDisabled(entries: readonly HookEntry[], disabled: readonly string[]): HookEntry[] {
  if (!disabled.length) return [...entries];
  const skip = new Set(disabled);
  return entries.filter((e) => !skip.has(e.id));
}

/** Pi session_start `reason` -> closest Claude Code `SessionStart` matcher token. */
const SESSION_START_REASON: Record<string, string> = {
  startup: "startup",
  resume: "resume",
  new: "clear",
  fork: "resume",
  reload: "startup",
};

/** Pi session_before_compact `reason` -> closest Claude Code `PreCompact` matcher token. */
const COMPACT_REASON: Record<string, string> = {
  manual: "manual",
  threshold: "auto",
  overflow: "auto",
};

export default function akHooksBridge(
  pi: ExtensionAPI,
  deps?: { spawn?: Spawner; settingsFiles?: readonly string[] },
): void {
  const settings = readBridgeSettings(deps?.settingsFiles ?? defaultSettingsFiles());
  if (!settings.enabled) return;

  const config: HookConfig = loadHookConfig(settings.hooksSettingsPath);
  const spawn = deps?.spawn;

  const preToolUse = filterDisabled(config.PreToolUse ?? [], settings.disabledHooks);
  const postToolUse = filterDisabled(config.PostToolUse ?? [], settings.disabledHooks);
  const userPromptSubmit = filterDisabled(config.UserPromptSubmit ?? [], settings.disabledHooks);
  const sessionStart = filterDisabled(config.SessionStart ?? [], settings.disabledHooks);
  const preCompact = filterDisabled(config.PreCompact ?? [], settings.disabledHooks);
  const stop = filterDisabled(config.Stop ?? [], settings.disabledHooks);

  if (preToolUse.length) {
    pi.on("tool_call", async (event, ctx) => {
      const matched = preToolUse.filter((e) => matchesTool(e.matcher, event.toolName));
      if (!matched.length) return;
      const outcome = await runHooks(
        matched,
        {
          hook_event_name: "PreToolUse",
          tool_name: claudeToolName(event.toolName),
          tool_input: event.input,
          cwd: ctx.cwd,
        },
        spawn,
      );
      if (outcome.kind === "block") return { block: true, reason: outcome.reason };
    });
  }

  if (postToolUse.length) {
    pi.on("tool_result", async (event, ctx) => {
      const matched = postToolUse.filter((e) => matchesTool(e.matcher, event.toolName));
      if (!matched.length) return;
      const outcome = await runHooks(
        matched,
        {
          hook_event_name: "PostToolUse",
          tool_name: claudeToolName(event.toolName),
          tool_input: event.input,
          tool_response: { content: event.content, isError: event.isError },
          cwd: ctx.cwd,
        },
        spawn,
      );
      if (outcome.kind === "allow" && outcome.additionalContext) {
        return {
          content: [
            ...(Array.isArray(event.content) ? event.content : []),
            { type: "text" as const, text: `\n[ak-hooks-bridge] ${outcome.additionalContext}` },
          ],
        };
      }
    });
  }

  if (userPromptSubmit.length) {
    pi.on("before_agent_start", async (event, ctx) => {
      const outcome = await runHooks(
        userPromptSubmit,
        {
          hook_event_name: "UserPromptSubmit",
          prompt: event.prompt,
          cwd: ctx.cwd,
        },
        spawn,
      );
      if (outcome.kind === "block") {
        // before_agent_start cannot block the turn outright; surface the reason
        // as injected context so the model sees it instead of proceeding blind.
        return {
          message: {
            customType: "ak-hooks-bridge",
            content: `[ak-hooks-bridge] blocked: ${outcome.reason}`,
            display: true,
          },
        };
      }
      if (outcome.additionalContext) {
        return {
          message: {
            customType: "ak-hooks-bridge",
            content: outcome.additionalContext,
            display: false,
          },
        };
      }
    });
  }

  if (sessionStart.length) {
    pi.on("session_start", async (event, ctx) => {
      const reason = SESSION_START_REASON[event.reason] ?? event.reason;
      const matched = sessionStart.filter((e) => matchesReason(e.matcher, reason));
      if (!matched.length) return;
      const outcome = await runHooks(
        matched,
        { hook_event_name: "SessionStart", source: reason, cwd: ctx.cwd },
        spawn,
      );
      if (outcome.kind === "allow" && outcome.additionalContext) {
        ctx.ui.notify(`ak-hooks-bridge: ${outcome.additionalContext}`, "info");
      }
    });
  }

  if (preCompact.length) {
    pi.on("session_before_compact", async (event, ctx) => {
      const reason = COMPACT_REASON[event.reason] ?? event.reason;
      const matched = preCompact.filter((e) => matchesReason(e.matcher, reason));
      if (!matched.length) return;
      const outcome = await runHooks(
        matched,
        { hook_event_name: "PreCompact", trigger: reason, cwd: ctx.cwd },
        spawn,
      );
      if (outcome.kind === "block") return { cancel: true };
    });
  }

  if (stop.length) {
    pi.on("agent_settled", async (_event, ctx) => {
      // Fire-and-forget: Stop hooks in AgentKit only ever emit reminders/telemetry.
      await runHooks(stop, { hook_event_name: "Stop", cwd: ctx.cwd }, spawn);
    });
  }
}
