import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** One concrete hook invocation: an interpreter + script (or a raw shell command) plus its matcher. */
export type HookEntry = {
  readonly matcher: string;
  readonly command: string;
  readonly args: readonly string[];
  /** Basename of the script, used for allow/deny lists and logging (e.g. "privacy-block.cjs"). */
  readonly id: string;
};

/** Claude Code hook event name -> its configured entries, in registration order. */
export type HookConfig = Readonly<Record<string, readonly HookEntry[]>>;

function basenameOf(command: string, args: readonly string[]): string {
  const target = args[args.length - 1] ?? command;
  const parts = target.split(/[\\/]/);
  return parts[parts.length - 1] ?? target;
}

/**
 * Naive shell-arg split for the legacy `command: "node '/path/to/hook.cjs'"` shape
 * (seen in `~/.codex/hooks.json`). Handles single/double-quoted segments only —
 * sufficient for the fixed `node '<path>'` commands AgentKit generates.
 */
function splitShellCommand(command: string): { command: string; args: string[] } {
  const tokens: string[] = [];
  const re = /'([^']*)'|"([^"]*)"|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(command))) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  const [first, ...rest] = tokens;
  return { command: first ?? command, args: rest };
}

type RawHookGroup = {
  matcher?: string;
  hooks?: ReadonlyArray<{ command?: string; args?: readonly string[]; type?: string }>;
};

/** Parse the `hooks` block from a Claude Code-shaped `settings.json` (or `hooks.json`). */
export function parseHookConfig(raw: unknown): HookConfig {
  const config: Record<string, HookEntry[]> = {};
  if (!raw || typeof raw !== "object") return config;

  for (const [eventName, groups] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(groups)) continue;
    const entries: HookEntry[] = [];
    for (const group of groups as RawHookGroup[]) {
      const matcher = group?.matcher ?? "*";
      for (const hook of group?.hooks ?? []) {
        if (!hook?.command) continue;
        const { command, args } = hook.args
          ? { command: hook.command, args: hook.args }
          : splitShellCommand(hook.command);
        if (!command) continue;
        entries.push({ matcher, command, args, id: basenameOf(command, args) });
      }
    }
    // De-duplicate: AgentKit's Claude+Codex sync sometimes registers the exact
    // same (matcher, command, args) pair twice across merged config sources.
    const seen = new Set<string>();
    config[eventName] = entries.filter((entry) => {
      const key = `${entry.matcher}\u0000${entry.command}\u0000${entry.args.join("\u0000")}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  return config;
}

export function defaultHooksSettingsPath(): string {
  return join(homedir(), ".claude", "settings.json");
}

/** Load and parse the hook registry. Returns an empty config when the file is missing/invalid. */
export function loadHookConfig(settingsPath = defaultHooksSettingsPath()): HookConfig {
  if (!existsSync(settingsPath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, "utf8"));
    return parseHookConfig(parsed?.hooks ?? parsed);
  } catch {
    return {};
  }
}

/** Pi tool id -> Claude Code tool name(s) a hook `matcher` is written against. */
const PI_TOOL_TO_CLAUDE_NAMES: Record<string, readonly string[]> = {
  bash: ["Bash"],
  read: ["Read"],
  write: ["Write"],
  edit: ["Edit", "MultiEdit"],
  grep: ["Grep"],
  glob: ["Glob"],
  web_fetch: ["WebFetch"],
  web_search: ["WebSearch"],
  todo: ["TodoWrite", "TodoRead"],
  subagent: ["Task"],
};

/** Whether a Claude Code hook `matcher` string (e.g. `"Write|Edit"`, `"*"`) matches a Pi tool id. */
export function matchesTool(matcher: string, piToolName: string): boolean {
  if (!matcher || matcher === "*") return true;
  const claudeNames = PI_TOOL_TO_CLAUDE_NAMES[piToolName] ?? [piToolName];
  const patterns = matcher.split("|").map((p) => p.trim());
  return patterns.some((pattern) => claudeNames.includes(pattern));
}

/** Pi tool id -> the Claude Code tool name AgentKit hook scripts expect in `tool_name`. */
export function claudeToolName(piToolName: string): string {
  const [primary] = PI_TOOL_TO_CLAUDE_NAMES[piToolName] ?? [];
  return primary ?? piToolName.charAt(0).toUpperCase() + piToolName.slice(1);
}

/** Whether a `matcher` string (e.g. session-start's `"startup|resume|clear|compact"`) matches a reason. */
export function matchesReason(matcher: string, reason: string): boolean {
  if (!matcher || matcher === "*") return true;
  return matcher.split("|").map((p) => p.trim()).includes(reason);
}
