import type { HookEntry } from "./config.ts";

/** Claude Code hook stdin payload, built per Pi event. Fields are best-effort — every
 * AgentKit hook script tolerates missing fields (fail-open by construction). */
export type HookPayload = {
  hook_event_name: string;
  session_id?: string;
  cwd?: string;
  transcript_path?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
  prompt?: string;
  source?: string;
  trigger?: string;
};

export type HookOutcome =
  | { kind: "allow"; additionalContext?: string }
  | { kind: "block"; reason: string };

/** Parse one hook's stdout + exit code into an allow/block outcome. */
export function parseHookOutcome(stdout: string, exitCode: number, stderr = ""): HookOutcome {
  // Legacy convention: exit 2 = block, reason on stderr (or stdout as a fallback).
  if (exitCode === 2) {
    return { kind: "block", reason: (stderr || stdout).trim() || "blocked by ak hook" };
  }
  if (exitCode !== 0) {
    // Non-zero, non-2 exit: treat as a crashed hook and fail open (matches each
    // script's own top-level try/catch fail-open behavior).
    return { kind: "allow" };
  }

  const trimmed = stdout.trim();
  if (!trimmed) return { kind: "allow" };

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { kind: "allow" };
  }

  const decision = parsed.permissionDecision ?? parsed.decision;
  if (decision === "deny" || decision === "block") {
    const reason =
      (typeof parsed.reason === "string" && parsed.reason) ||
      (typeof parsed.permissionDecisionReason === "string" && parsed.permissionDecisionReason) ||
      "blocked by ak hook";
    return { kind: "block", reason };
  }

  const additionalContext =
    (typeof parsed.additionalContext === "string" && parsed.additionalContext) ||
    (typeof parsed.systemMessage === "string" && parsed.systemMessage) ||
    undefined;
  return additionalContext ? { kind: "allow", additionalContext } : { kind: "allow" };
}

export type SpawnResult = { stdout: string; stderr: string; exitCode: number };
export type Spawner = (
  command: string,
  args: readonly string[],
  input: string,
  cwd?: string,
) => Promise<SpawnResult>;

/** Default spawner: runs the hook's interpreter/script with the Claude Code JSON payload on stdin. */
export const bunSpawner: Spawner = async (command, args, input, cwd) => {
  const proc = Bun.spawn([command, ...args], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    cwd,
    env: { ...process.env, CI: process.env.CI ?? "" },
  });
  proc.stdin.write(input);
  await proc.stdin.end();
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
};

const DEFAULT_TIMEOUT_MS = 5_000;

/** Run one hook entry with the given payload, with a hard timeout (fail-open on timeout). */
export async function runHook(
  entry: HookEntry,
  payload: HookPayload,
  spawn: Spawner = bunSpawner,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<HookOutcome> {
  const input = JSON.stringify(payload);
  try {
    const result = await Promise.race([
      spawn(entry.command, entry.args, input, payload.cwd),
      new Promise<SpawnResult>((resolve) =>
        setTimeout(() => resolve({ stdout: "", stderr: "timeout", exitCode: 0 }), timeoutMs),
      ),
    ]);
    return parseHookOutcome(result.stdout, result.exitCode, result.stderr);
  } catch {
    return { kind: "allow" }; // fail-open: a bridge/spawn error must never block the agent
  }
}

/** Run every entry in order; stop at the first block. Concatenate additionalContext. */
export async function runHooks(
  entries: readonly HookEntry[],
  payload: HookPayload,
  spawn: Spawner = bunSpawner,
  timeoutMs?: number,
): Promise<HookOutcome> {
  const contexts: string[] = [];
  for (const entry of entries) {
    const outcome = await runHook(entry, payload, spawn, timeoutMs);
    if (outcome.kind === "block") return outcome;
    if (outcome.additionalContext) contexts.push(outcome.additionalContext);
  }
  return contexts.length ? { kind: "allow", additionalContext: contexts.join("\n\n") } : { kind: "allow" };
}
