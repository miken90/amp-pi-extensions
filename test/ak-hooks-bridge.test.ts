// Unit tests for ak-hooks-bridge: config parsing, hook-output interpretation,
// and event wiring, all with a fake spawner so no real AgentKit hook runs.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { matchesReason, matchesTool, parseHookConfig } from "../extensions/ak-hooks-bridge/config.ts";
import { parseHookOutcome, runHook, runHooks, type Spawner } from "../extensions/ak-hooks-bridge/runner.ts";
import akHooksBridge from "../extensions/ak-hooks-bridge/index.ts";

const tempFiles: string[] = [];
afterEach(() => {
  for (const f of tempFiles.splice(0)) rmSync(f, { recursive: true, force: true });
});

describe("parseHookConfig", () => {
  test("flattens matcher groups per event, in order", () => {
    const config = parseHookConfig({
      PreToolUse: [
        { matcher: "Write", hooks: [{ command: "/usr/bin/node", args: ["/hooks/a.cjs"] }] },
        { matcher: "Bash", hooks: [{ command: "/usr/bin/node", args: ["/hooks/b.cjs"] }] },
      ],
    });
    expect(config.PreToolUse).toEqual([
      { matcher: "Write", command: "/usr/bin/node", args: ["/hooks/a.cjs"], id: "a.cjs" },
      { matcher: "Bash", command: "/usr/bin/node", args: ["/hooks/b.cjs"], id: "b.cjs" },
    ]);
  });

  test("parses the legacy quoted shell-command shape (~/.codex/hooks.json)", () => {
    const config = parseHookConfig({
      Stop: [{ matcher: "*", hooks: [{ command: "node '/hooks/session-state.cjs'" }] }],
    });
    expect(config.Stop).toEqual([
      { matcher: "*", command: "node", args: ["/hooks/session-state.cjs"], id: "session-state.cjs" },
    ]);
  });

  test("de-duplicates identical (matcher, command, args) entries", () => {
    const config = parseHookConfig({
      Stop: [
        { matcher: "*", hooks: [{ command: "/usr/bin/node", args: ["/hooks/a.cjs"] }] },
        { matcher: "*", hooks: [{ command: "/usr/bin/node", args: ["/hooks/a.cjs"] }] },
      ],
    });
    expect(config.Stop?.length).toBe(1);
  });

  test("ignores malformed input", () => {
    expect(parseHookConfig(null)).toEqual({});
    expect(parseHookConfig("not an object")).toEqual({});
  });
});

describe("matchesTool", () => {
  test("`*` matches every tool", () => {
    expect(matchesTool("*", "bash")).toBe(true);
  });

  test("maps Pi tool ids to their Claude Code matcher names", () => {
    expect(matchesTool("Write|Edit", "edit")).toBe(true);
    expect(matchesTool("Write|Edit", "bash")).toBe(false);
    expect(matchesTool("Bash", "bash")).toBe(true);
  });

  test("MultiEdit in a matcher also covers Pi's single `edit` tool", () => {
    expect(matchesTool("MultiEdit", "edit")).toBe(true);
  });
});

describe("matchesReason", () => {
  test("`*` matches every reason", () => {
    expect(matchesReason("*", "startup")).toBe(true);
  });

  test("matches one of several pipe-separated reasons", () => {
    expect(matchesReason("startup|resume|clear|compact", "clear")).toBe(true);
    expect(matchesReason("manual|auto", "threshold")).toBe(false);
  });
});

describe("parseHookOutcome", () => {
  test("exit 2 blocks with the stderr reason", () => {
    expect(parseHookOutcome("", 2, "nope")).toEqual({ kind: "block", reason: "nope" });
  });

  test("exit 0 with no stdout allows", () => {
    expect(parseHookOutcome("", 0)).toEqual({ kind: "allow" });
  });

  test("JSON permissionDecision: deny blocks", () => {
    const outcome = parseHookOutcome(
      JSON.stringify({ permissionDecision: "deny", reason: "blocked path" }),
      0,
    );
    expect(outcome).toEqual({ kind: "block", reason: "blocked path" });
  });

  test("additionalContext is surfaced on allow", () => {
    const outcome = parseHookOutcome(JSON.stringify({ continue: true, additionalContext: "note" }), 0);
    expect(outcome).toEqual({ kind: "allow", additionalContext: "note" });
  });

  test("a crashed hook (non-zero, non-2 exit) fails open", () => {
    expect(parseHookOutcome("", 1)).toEqual({ kind: "allow" });
  });

  test("unparsable stdout fails open", () => {
    expect(parseHookOutcome("not json", 0)).toEqual({ kind: "allow" });
  });
});

function fakeSpawner(
  script: (payload: Record<string, unknown>) => { stdout?: string; exitCode?: number; stderr?: string },
): Spawner {
  return async (_command, _args, input) => {
    const payload = JSON.parse(input);
    const result = script(payload);
    return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", exitCode: result.exitCode ?? 0 };
  };
}

describe("runHook / runHooks", () => {
  const entry = { matcher: "*", command: "node", args: ["hook.cjs"], id: "hook.cjs" };

  test("runs the spawner with the given payload and returns its outcome", async () => {
    const spawn = fakeSpawner((payload) => ({
      exitCode: payload.tool_name === "Bash" ? 2 : 0,
    }));
    expect((await runHook(entry, { hook_event_name: "PreToolUse", tool_name: "Bash" }, spawn)).kind).toBe(
      "block",
    );
    expect((await runHook(entry, { hook_event_name: "PreToolUse", tool_name: "Read" }, spawn)).kind).toBe(
      "allow",
    );
  });

  test("a spawner rejection fails open", async () => {
    const spawn: Spawner = async () => {
      throw new Error("boom");
    };
    expect(await runHook(entry, { hook_event_name: "Stop" }, spawn)).toEqual({ kind: "allow" });
  });

  test("stops at the first blocking hook and does not run the rest", async () => {
    const calls: string[] = [];
    const entries = [
      { ...entry, id: "first.cjs" },
      { ...entry, id: "second.cjs" },
    ];
    const spawn: Spawner = async (_c, args) => {
      calls.push(args[0] as string);
      return { stdout: "", stderr: "blocked", exitCode: 2 };
    };
    const outcome = await runHooks(entries, { hook_event_name: "PreToolUse" }, spawn);
    expect(outcome).toEqual({ kind: "block", reason: "blocked" });
    expect(calls).toEqual(["hook.cjs"]);
  });

  test("concatenates additionalContext across multiple allowing hooks", async () => {
    let call = 0;
    const entries = [entry, { ...entry, id: "second.cjs" }];
    const spawn: Spawner = async () => {
      call += 1;
      return { stdout: JSON.stringify({ additionalContext: `note-${call}` }), stderr: "", exitCode: 0 };
    };
    const outcome = await runHooks(entries, { hook_event_name: "Stop" }, spawn);
    expect(outcome).toEqual({ kind: "allow", additionalContext: "note-1\n\nnote-2" });
  });
});

// ── Extension wiring ────────────────────────────────────────────────────────

type Handler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;

function harness() {
  const handlers = new Map<string, Handler>();
  const pi = { on: (event: string, fn: Handler) => handlers.set(event, fn) };
  return { pi: pi as never, handlers };
}

function writeSettings(hooks: unknown, bridge: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "ak-bridge-settings-"));
  tempFiles.push(dir);
  const piDir = join(dir, ".pi");
  mkdirSync(piDir, { recursive: true });
  const file = join(piDir, "settings.json");
  const hooksFile = join(dir, "hooks.json");
  writeFileSync(hooksFile, JSON.stringify({ hooks }), "utf8");
  writeFileSync(
    file,
    JSON.stringify({ akHooksBridge: { ...bridge, hooksSettingsPath: hooksFile } }),
    "utf8",
  );
  return dir;
}

const ORIGINAL_CWD = process.cwd();

describe("akHooksBridge extension", () => {
  test("does nothing when disabled (default)", () => {
    // settingsFiles: [] isolates from the real machine's settings.json files,
    // which may have akHooksBridge.enabled: true.
    const { pi, handlers } = harness();
    akHooksBridge(pi, { settingsFiles: [] });
    expect(handlers.size).toBe(0);
  });

  test("registers tool_call and blocks per the hook's verdict", async () => {
    const dir = writeSettings(
      { PreToolUse: [{ matcher: "Bash", hooks: [{ command: "node", args: ["scout-block.cjs"] }] }] },
      { enabled: true },
    );
    process.chdir(dir);
    try {
      const { pi, handlers } = harness();
      const spawn: Spawner = async (_c, _a, input) => {
        const payload = JSON.parse(input);
        return { stdout: "", stderr: "blocked dir", exitCode: payload.tool_name === "Bash" ? 2 : 0 };
      };
      akHooksBridge(pi, { spawn });

      const bashResult = await handlers.get("tool_call")?.(
        { toolName: "bash", input: { command: "cat node_modules/x" } },
        { cwd: dir },
      );
      expect(bashResult).toEqual({ block: true, reason: "blocked dir" });

      const readResult = await handlers.get("tool_call")?.({ toolName: "read", input: {} }, { cwd: dir });
      expect(readResult).toBeUndefined();
    } finally {
      process.chdir(ORIGINAL_CWD);
    }
  });

  test("does not register a Pi event when no hooks target it", () => {
    const dir = writeSettings({ PreToolUse: [{ matcher: "Bash", hooks: [{ command: "node", args: ["x.cjs"] }] }] }, {
      enabled: true,
    });
    process.chdir(dir);
    try {
      const { pi, handlers } = harness();
      akHooksBridge(pi, { spawn: async () => ({ stdout: "", stderr: "", exitCode: 0 }) });
      expect(handlers.has("tool_call")).toBe(true);
      expect(handlers.has("agent_settled")).toBe(false);
    } finally {
      process.chdir(ORIGINAL_CWD);
    }
  });

  test("disabledHooks filters a hook out by basename", async () => {
    const dir = writeSettings(
      { Stop: [{ matcher: "*", hooks: [{ command: "node", args: ["session-state.cjs"] }] }] },
      { enabled: true, disabledHooks: ["session-state.cjs"] },
    );
    process.chdir(dir);
    try {
      const { pi, handlers } = harness();
      akHooksBridge(pi, { spawn: async () => ({ stdout: "", stderr: "", exitCode: 0 }) });
      expect(handlers.has("agent_settled")).toBe(false);
    } finally {
      process.chdir(ORIGINAL_CWD);
    }
  });

  test("expands a `~/...` hooksSettingsPath override", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ak-bridge-settings-"));
    tempFiles.push(dir);
    const piDir = join(dir, ".pi");
    mkdirSync(piDir, { recursive: true });
    const relHome = `.ak-bridge-test-${process.pid}`;
    const homeHooksDir = join(require("node:os").homedir(), relHome);
    mkdirSync(homeHooksDir, { recursive: true });
    tempFiles.push(homeHooksDir);
    writeFileSync(
      join(homeHooksDir, "hooks.json"),
      JSON.stringify({ hooks: { Stop: [{ matcher: "*", hooks: [{ command: "node", args: ["x.cjs"] }] }] } }),
      "utf8",
    );
    writeFileSync(
      join(piDir, "settings.json"),
      JSON.stringify({
        akHooksBridge: { enabled: true, hooksSettingsPath: `~/${relHome}/hooks.json` },
      }),
      "utf8",
    );

    process.chdir(dir);
    try {
      const { pi, handlers } = harness();
      akHooksBridge(pi, { spawn: async () => ({ stdout: "", stderr: "", exitCode: 0 }) });
      expect(handlers.has("agent_settled")).toBe(true);
    } finally {
      process.chdir(ORIGINAL_CWD);
    }
  });

  test("before_agent_start surfaces a block as injected context instead of throwing", async () => {
    const dir = writeSettings(
      { UserPromptSubmit: [{ matcher: "*", hooks: [{ command: "node", args: ["simplify-gate.cjs"] }] }] },
      { enabled: true },
    );
    process.chdir(dir);
    try {
      const { pi, handlers } = harness();
      akHooksBridge(pi, {
        spawn: async () => ({ stdout: "", stderr: "too complex", exitCode: 2 }),
      });
      const result = await handlers.get("before_agent_start")?.(
        { prompt: "rewrite the whole app" },
        { cwd: dir },
      );
      expect(result).toEqual({
        message: {
          customType: "ak-hooks-bridge",
          content: "[ak-hooks-bridge] blocked: too complex",
          display: true,
        },
      });
    } finally {
      process.chdir(ORIGINAL_CWD);
    }
  });
});
