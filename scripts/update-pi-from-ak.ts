#!/usr/bin/env bun
/**
 * Post-`ak update` repair/conversion so AgentKit's Claude-Code-flavored assets
 * work under Pi. Two independent, idempotent steps, both safe to re-run:
 *
 * 1. Skill name repair — AgentKit writes namespaced `name: ak:<skill>` into
 *    every `~/.claude/skills/<dir>/SKILL.md`. Pi implements the Agent Skills
 *    standard, whose name grammar is `[a-z0-9]([a-z0-9-]*[a-z0-9])?` — a colon
 *    is invalid, so those skills load with `invalid-name` diagnostics and
 *    their `/skill:<name>` commands break. This rewrites offending names to
 *    the hyphenated form (`ak:debug` -> `ak-debug`), matching the on-disk
 *    directory names AgentKit already creates.
 *
 * 2. Agent conversion — AgentKit ships subagents as Claude Code agent
 *    definitions in `~/.claude/agents/*.md` (Capitalized tool names like
 *    `Glob, Grep, Bash`, Claude model aliases like `opus`/`sonnet`/`haiku`).
 *    Pi's subagent loader (`~/.pi/agent/agents/*.md`) expects lowercase Pi
 *    tool ids and Pi model ids. This converts each source agent into a Pi
 *    agent definition, dropping tools/fields Pi has no equivalent for and
 *    remapping known models, so AgentKit's agents become usable via Pi's
 *    `subagent` tool without hand-editing.
 *
 * Safety contract (both steps):
 *  - No-ops when the target is already valid/up to date (idempotent).
 *  - Creates a reversible backup before writing; `--restore` rolls back.
 *  - Reports collisions/drops instead of silently guessing.
 *
 * Usage (from any cwd):
 *   bun run /path/to/pi-extensions/scripts/update-pi-from-ak.ts             # apply both steps
 *   bun run /path/to/pi-extensions/scripts/update-pi-from-ak.ts --check     # dry-run
 *   bun run /path/to/pi-extensions/scripts/update-pi-from-ak.ts --restore   # rollback both
 *   bun run ... --skip-skills / --skip-agents                              # run one step only
 *   bun run ... --root ~/.claude/skills --root ~/.codex/skills             # override skill roots
 *   bun run ... --agents-root ~/.claude/agents                             # override agent source
 *   bun run ... --agents-out ~/.pi/agent/agents                            # override agent target
 *   bun run ... --update                      # run `ak update --global --yes` first, then repair
 *   bun run ... --update -- --global --target codex --yes   # override the `ak update` args
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

const BACKUP_SUFFIX = ".skill-name-backup";
const AGENT_BACKUP_SUFFIX = ".ak-agent-backup";
/** `ak update` exit codes that leave the install in a consistent state. */
const AK_OK_EXIT_CODES = new Set([0, 3]);
/**
 * Default `ak update` scope: global/user kits only. Project-level refreshes are
 * intentionally excluded — they rewrite files inside whatever repo happens to be
 * the cwd, which is not this script's business.
 */
const AK_UPDATE_DEFAULT_ARGS = ["--global", "--yes"];
const MAX_NAME_LENGTH = 64;
const MAX_SCAN_DEPTH = 6;

/** Agent Skills name grammar as enforced by Pi. */
const VALID_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
/** `name: value` on its own line inside the frontmatter block. */
const NAME_LINE_RE = /^name:[ \t]*(.+?)[ \t]*$/m;

// ─────────────────────────────────────────────────────────────────────────
// Step 1: skill name repair
// ─────────────────────────────────────────────────────────────────────────

/** Skill directories Pi can be pointed at, in scan order. */
export function defaultSkillRoots(): string[] {
  const home = homedir();
  return [
    join(home, ".claude", "skills"),
    join(home, ".codex", "skills"),
    join(home, ".agents", "skills"),
    join(home, ".pi", "agent", "skills"),
  ];
}

/** Extract the frontmatter block of a SKILL.md, or null when absent. */
export function frontmatterOf(content: string): string | null {
  if (!content.startsWith("---")) return null;
  const end = content.indexOf("\n---", 3);
  return end < 0 ? null : content.slice(0, end);
}

/** Read the declared skill name from SKILL.md content, or null. */
export function readName(content: string): string | null {
  const front = frontmatterOf(content);
  if (!front) return null;
  const match = front.match(NAME_LINE_RE);
  return match ? (match[1] ?? null) : null;
}

/** Coerce an arbitrary declared name into the Pi/Agent Skills grammar. */
export function normalizeName(name: string): string {
  return name
    .trim()
    .replace(/^["']|["']$/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_NAME_LENGTH)
    .replace(/-+$/, "");
}

export type SkillStatus =
  | { kind: "valid"; path: string; name: string }
  | { kind: "repairable"; path: string; name: string; fixed: string; collidesWith?: string }
  | { kind: "unrepairable"; path: string; name: string | null; reason: string };

/** Classify one SKILL.md without touching the filesystem. */
export function analyzeContent(content: string, path = "<memory>"): SkillStatus {
  const name = readName(content);
  if (name === null) {
    return {
      kind: "unrepairable",
      path,
      name: null,
      reason: "no `name:` key in the leading frontmatter block",
    };
  }
  const bare = name.replace(/^["']|["']$/g, "");
  if (VALID_NAME_RE.test(bare) && bare.length <= MAX_NAME_LENGTH) {
    return { kind: "valid", path, name: bare };
  }
  const fixed = normalizeName(name);
  if (!fixed) {
    return {
      kind: "unrepairable",
      path,
      name,
      reason: `\`${name}\` has no alphanumeric characters to build a valid name from`,
    };
  }
  return { kind: "repairable", path, name: bare, fixed };
}

/** Return content with the frontmatter `name:` replaced by `fixed`. */
export function applyPatch(content: string, fixed: string): string {
  const front = frontmatterOf(content);
  if (!front) return content;
  const patchedFront = front.replace(NAME_LINE_RE, `name: ${fixed}`);
  return patchedFront + content.slice(front.length);
}

/** Recursively collect files matching `fileName` under a root directory. */
export function findFiles(root: string, fileName: string, depth = MAX_SCAN_DEPTH): string[] {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    if (entry.startsWith(".") || entry === "node_modules") continue;
    const path = join(root, entry);
    let isDir: boolean;
    try {
      isDir = statSync(path).isDirectory();
    } catch {
      continue;
    }
    if (isDir) {
      if (depth > 0) found.push(...findFiles(path, fileName, depth - 1));
    } else if (entry === fileName) {
      found.push(path);
    }
  }
  return found.sort();
}

/** Recursively collect SKILL.md paths under a root directory. */
export function findSkillFiles(root: string, depth = MAX_SCAN_DEPTH): string[] {
  return findFiles(root, "SKILL.md", depth);
}

export type SkillRepairResult = {
  statuses: SkillStatus[];
  patched: string[];
  restored: string[];
};

export type SkillRepairOptions = {
  roots?: string[];
  check?: boolean;
  restore?: boolean;
};

function ensureBackup(path: string, suffix: string): string {
  const backup = path + suffix;
  if (!existsSync(backup)) copyFileSync(path, backup);
  return backup;
}

/** Scan the roots and repair every invalid skill name. */
export function repairSkillNames(options: SkillRepairOptions = {}): SkillRepairResult {
  const roots = (options.roots ?? defaultSkillRoots()).map((r) => resolve(r));
  const files = roots.flatMap((root) => findSkillFiles(root));

  if (options.restore) {
    const restored: string[] = [];
    for (const path of files) {
      const backup = path + BACKUP_SUFFIX;
      if (!existsSync(backup)) continue;
      copyFileSync(backup, path);
      restored.push(path);
    }
    return { statuses: [], patched: [], restored };
  }

  // Names already taken by valid skills — a repair must not shadow them.
  const taken = new Map<string, string>();
  const analyzed = files.map((path) => {
    const status = analyzeContent(readFileSync(path, "utf8"), path);
    if (status.kind === "valid") taken.set(status.name, path);
    return status;
  });

  const statuses: SkillStatus[] = [];
  const patched: string[] = [];
  for (const status of analyzed) {
    if (status.kind !== "repairable") {
      statuses.push(status);
      continue;
    }
    const owner = taken.get(status.fixed);
    if (owner && owner !== status.path) status.collidesWith = owner;
    else taken.set(status.fixed, status.path);
    statuses.push(status);
    if (options.check) continue;

    const content = readFileSync(status.path, "utf8");
    const next = applyPatch(content, status.fixed);
    if (next === content) continue;
    const backup = ensureBackup(status.path, BACKUP_SUFFIX);
    writeFileSync(status.path, next, "utf8");
    const verify = analyzeContent(readFileSync(status.path, "utf8"), status.path);
    if (verify.kind !== "valid") {
      copyFileSync(backup, status.path);
      statuses[statuses.length - 1] = {
        kind: "unrepairable",
        path: status.path,
        name: status.name,
        reason: `post-patch verification failed (${verify.kind}); rolled back`,
      };
      continue;
    }
    patched.push(status.path);
  }

  return { statuses, patched, restored: [] };
}

// ─────────────────────────────────────────────────────────────────────────
// Step 2: Claude Code -> Pi agent conversion
// ─────────────────────────────────────────────────────────────────────────

/** Claude Code tool name -> Pi tool id. Tools with no Pi equivalent are dropped. */
const TOOL_MAP: Record<string, string | null> = {
  Glob: "glob",
  Grep: "grep",
  Read: "read",
  Write: "write",
  Edit: "edit",
  MultiEdit: "edit",
  NotebookEdit: "edit",
  Bash: "bash",
  WebFetch: "web_fetch",
  WebSearch: "web_search",
  TodoWrite: "todo",
  TodoRead: "todo",
  // No Pi equivalent: cross-agent messaging/task-queue and Claude-only tools.
  TaskCreate: null,
  TaskGet: null,
  TaskUpdate: null,
  TaskList: null,
  SendMessage: null,
  BashOutput: null,
  KillBash: null,
  ListMcpResourcesTool: null,
  ReadMcpResourceTool: null,
  LS: null,
};

/** Claude Code model alias -> Pi model id. Unknown aliases pass through unmapped (warn). */
const MODEL_MAP: Record<string, string | undefined> = {
  opus: "claude-opus-5",
  sonnet: "claude-sonnet-5",
  haiku: "claude-haiku-5",
  fable: "gpt-5.6-sol",
  inherit: undefined, // Pi has no "inherit"; drop the field so the caller's model applies.
};

/**
 * Minimal YAML-frontmatter reader for agent definitions: only understands
 * top-level scalar keys, quoted scalars, and block scalars (`>`, `>-`, `|`,
 * `|-`) — enough for Claude Code agent files (name/description/tools/model),
 * without pulling in a full YAML parser or the whole pi-coding-agent runtime.
 */
export function parseAgentFrontmatter(content: string): {
  frontmatter: Record<string, string>;
  body: string;
} {
  const normalized = content.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (lines[0] !== "---") return { frontmatter: {}, body: normalized };

  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") {
      end = i;
      break;
    }
  }
  if (end < 0) return { frontmatter: {}, body: normalized };

  const frontmatter: Record<string, string> = {};
  const front = lines.slice(1, end);
  let i = 0;
  while (i < front.length) {
    const line = front[i] ?? "";
    const match = line.match(/^([A-Za-z0-9_-]+):[ \t]?(.*)$/);
    if (!match) {
      i++;
      continue;
    }
    const key = match[1] as string;
    let value = (match[2] ?? "").trim();
    i++;

    if (value === ">-" || value === ">" || value === ">+" || value === "|" || value === "|-" || value === "|+") {
      const literal = value.startsWith("|");
      const blockLines: string[] = [];
      while (i < front.length) {
        const next = front[i] ?? "";
        if (next.trim() !== "" && !/^[ \t]/.test(next)) break; // next top-level key
        blockLines.push(next.replace(/^[ \t]+/, ""));
        i++;
      }
      while (blockLines.length && blockLines[blockLines.length - 1] === "") blockLines.pop();
      value = literal ? blockLines.join("\n") : foldYamlLines(blockLines);
    } else if (value === "") {
      // Plain (indicator-less) multi-line scalar: fold like `>`.
      const blockLines: string[] = [];
      while (i < front.length) {
        const next = front[i] ?? "";
        if (next.trim() !== "" && !/^[ \t]/.test(next)) break;
        if (next.trim() !== "") blockLines.push(next.replace(/^[ \t]+/, ""));
        i++;
      }
      value = foldYamlLines(blockLines);
    } else if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    frontmatter[key] = value;
  }

  return { frontmatter, body: lines.slice(end + 1).join("\n").trim() };
}

/** YAML folded-scalar rule: blank line -> newline, otherwise join with a space. */
function foldYamlLines(blockLines: string[]): string {
  const parts: string[] = [];
  let buffer: string[] = [];
  for (const line of blockLines) {
    if (line === "") {
      parts.push(buffer.join(" "));
      buffer = [];
      parts.push("");
    } else {
      buffer.push(line);
    }
  }
  if (buffer.length) parts.push(buffer.join(" "));
  return parts.join("\n").replace(/\n{2,}/g, "\n\n").trim();
}

export function defaultAgentSourceRoots(): string[] {
  return [join(homedir(), ".claude", "agents")];
}

export function defaultAgentOutRoot(): string {
  return join(homedir(), ".pi", "agent", "agents");
}

/** `Task(name)` -> `subagent`; drop the parenthesized target, Pi has one generic subagent tool. */
function mapTaskTool(raw: string): string | null {
  return raw.startsWith("Task(") ? "subagent" : null;
}

export type ToolConversion = {
  tools: string[] | undefined;
  dropped: string[];
};

/** Convert a comma-separated Claude Code `tools:` list into Pi tool ids. */
export function convertTools(rawTools: string | undefined): ToolConversion {
  if (!rawTools) return { tools: undefined, dropped: [] };
  const seen = new Set<string>();
  const dropped: string[] = [];
  for (const raw of rawTools.split(",").map((t) => t.trim()).filter(Boolean)) {
    const mapped = raw in TOOL_MAP ? TOOL_MAP[raw] : mapTaskTool(raw);
    if (mapped) seen.add(mapped);
    else dropped.push(raw);
  }
  return { tools: seen.size ? Array.from(seen).sort() : undefined, dropped };
}

export type ModelConversion = {
  model: string | undefined;
  unmapped: string | undefined;
};

/** Convert a Claude Code `model:` alias into a Pi model id. */
export function convertModel(rawModel: string | undefined): ModelConversion {
  const trimmed = rawModel?.trim();
  if (!trimmed) return { model: undefined, unmapped: undefined };
  if (trimmed in MODEL_MAP) return { model: MODEL_MAP[trimmed], unmapped: undefined };
  // Already a Pi-shaped id (e.g. "provider/model" or an unknown-but-passable id): keep as-is.
  return { model: trimmed, unmapped: trimmed };
}

function yamlScalar(value: string): string {
  return /[:#{}\[\],&*!|>'"%@`\n]/.test(value) || value !== value.trim()
    ? JSON.stringify(value)
    : value;
}

export type AgentConversion =
  | {
      kind: "converted";
      path: string;
      name: string;
      outPath: string;
      content: string;
      droppedTools: string[];
      unmappedModel: string | undefined;
    }
  | { kind: "unconvertible"; path: string; reason: string };

/** Convert one Claude Code agent definition's raw content into a Pi agent definition. */
export function convertAgentContent(content: string, path = "<memory>"): AgentConversion {
  const { frontmatter, body } = parseAgentFrontmatter(content);
  const name = (frontmatter.name ?? "").trim();
  const description = frontmatter.description ?? "";
  if (!name || !description) {
    return { path, kind: "unconvertible", reason: "missing `name` or `description`" };
  }

  const { tools, dropped } = convertTools(frontmatter.tools);
  const { model, unmapped } = convertModel(frontmatter.model);

  const lines = ["---", `name: ${yamlScalar(name)}`, `description: ${yamlScalar(description)}`];
  if (tools) lines.push(`tools: ${tools.join(", ")}`);
  if (model) lines.push(`model: ${yamlScalar(model)}`);
  lines.push("---", "", body.trim(), "");

  return {
    kind: "converted",
    path,
    name,
    outPath: "",
    content: lines.join("\n"),
    droppedTools: dropped,
    unmappedModel: unmapped,
  };
}

export type AgentConvertResult = {
  conversions: AgentConversion[];
  written: string[];
  restored: string[];
};

export type AgentConvertOptions = {
  sourceRoots?: string[];
  outRoot?: string;
  check?: boolean;
  restore?: boolean;
};

/** Scan Claude Code agent sources and write/refresh Pi agent definitions. */
export function convertAgents(options: AgentConvertOptions = {}): AgentConvertResult {
  const sourceRoots = (options.sourceRoots ?? defaultAgentSourceRoots()).map((r) => resolve(r));
  const outRoot = resolve(options.outRoot ?? defaultAgentOutRoot());
  const mdFiles = sourceRoots.flatMap((root) => {
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      return [];
    }
    return entries
      .filter((e) => e.endsWith(".md"))
      .map((e) => join(root, e))
      .filter((p) => {
        try {
          return statSync(p).isFile();
        } catch {
          return false;
        }
      });
  });

  if (options.restore) {
    const restored: string[] = [];
    for (const src of mdFiles.sort()) {
      const outPath = join(outRoot, basename(src));
      const backup = outPath + AGENT_BACKUP_SUFFIX;
      if (!existsSync(backup)) continue;
      copyFileSync(backup, outPath);
      restored.push(outPath);
    }
    return { conversions: [], written: [], restored };
  }

  const conversions: AgentConversion[] = [];
  const written: string[] = [];
  for (const src of mdFiles.sort()) {
    const result = convertAgentContent(readFileSync(src, "utf8"), src);
    if (result.kind !== "converted") {
      conversions.push(result);
      continue;
    }
    const outPath = join(outRoot, basename(src));
    const finalResult: AgentConversion = { ...result, outPath };
    conversions.push(finalResult);
    if (options.check) continue;

    const existing = existsSync(outPath) ? readFileSync(outPath, "utf8") : null;
    if (existing === finalResult.content) continue; // already up to date

    if (!existsSync(outRoot)) mkdirSync(outRoot, { recursive: true });
    if (existing !== null) ensureBackup(outPath, AGENT_BACKUP_SUFFIX);
    writeFileSync(outPath, finalResult.content, "utf8");
    written.push(outPath);
  }

  return { conversions, written, restored: [] };
}

// ─────────────────────────────────────────────────────────────────────────
// `ak update` runner shared by both steps
// ─────────────────────────────────────────────────────────────────────────

/** Spawns a command with inherited stdio so `ak`'s wizard stays interactive. */
export type CommandRunner = (cmd: string[]) => number;

const spawnInherit: CommandRunner = (cmd) =>
  Bun.spawnSync(cmd, { stdio: ["inherit", "inherit", "inherit"] }).exitCode;

/**
 * Run `ak update <passthrough>` before repairing. Returns the exit code to
 * propagate, or null when the update finished cleanly enough to repair.
 */
export function runAkUpdate(
  passthrough: string[],
  run: CommandRunner = spawnInherit,
): number | null {
  const cmd = ["ak", "update", ...passthrough];
  console.log(`update-pi-from-ak: running \`${cmd.join(" ")}\`…`);
  const exitCode = run(cmd);
  if (AK_OK_EXIT_CODES.has(exitCode)) return null;
  console.error(`update-pi-from-ak: \`${cmd.join(" ")}\` exited ${exitCode}; skipping repair.`);
  return exitCode;
}

// ─────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────

function arg(name: string): boolean {
  return process.argv.includes(name);
}

/** Args after a bare `--`, forwarded verbatim to `ak update` (else the default scope). */
function passthroughArgs(): string[] {
  const index = process.argv.indexOf("--");
  const explicit = index < 0 ? [] : process.argv.slice(index + 1);
  return explicit.length ? explicit : AK_UPDATE_DEFAULT_ARGS;
}

function argValues(name: string): string[] {
  const values: string[] = [];
  process.argv.forEach((value, index) => {
    if (value === name && process.argv[index + 1]) {
      values.push(process.argv[index + 1] as string);
    }
  });
  return values;
}

function argValue(name: string): string | undefined {
  return argValues(name)[0];
}

function runSkillStep(check: boolean, restore: boolean): number {
  const rootArgs = argValues("--root");
  const result = repairSkillNames({
    roots: rootArgs.length ? rootArgs : undefined,
    check,
    restore,
  });

  if (restore) {
    console.log(
      `update-pi-from-ak: skills — restored ${result.restored.length} file(s) from ${BACKUP_SUFFIX}.`,
    );
    return 0;
  }

  const repairable = result.statuses.filter((s) => s.kind === "repairable");
  const blocked = result.statuses.filter((s) => s.kind === "unrepairable");

  for (const status of repairable) {
    if (status.kind !== "repairable") continue;
    const dup = status.collidesWith ? ` [also declared by ${status.collidesWith}]` : "";
    console.log(`  ${status.name} -> ${status.fixed}  (${status.path})${dup}`);
  }
  for (const status of blocked) {
    if (status.kind !== "unrepairable") continue;
    console.error(`  SKIP ${status.path}: ${status.reason}`);
  }

  if (!repairable.length) {
    console.log("update-pi-from-ak: skills — all names valid, no-op.");
  } else if (check) {
    console.log(
      `update-pi-from-ak: skills — ${repairable.length} invalid name(s) (dry-run, no changes).`,
    );
  } else {
    console.log(
      `update-pi-from-ak: skills — rewrote ${result.patched.length} SKILL.md name(s).\n` +
        `Backups written next to each file as *${BACKUP_SUFFIX}; roll back with --restore.\n` +
        `Restart Pi to reload the skill list.`,
    );
  }

  return blocked.length ? 1 : 0;
}

function runAgentStep(check: boolean, restore: boolean): number {
  const sourceRootArgs = argValues("--agents-root");
  const outRoot = argValue("--agents-out");
  const result = convertAgents({
    sourceRoots: sourceRootArgs.length ? sourceRootArgs : undefined,
    outRoot,
    check,
    restore,
  });

  if (restore) {
    console.log(
      `update-pi-from-ak: agents — restored ${result.restored.length} file(s) from ${AGENT_BACKUP_SUFFIX}.`,
    );
    return 0;
  }

  const converted = result.conversions.filter((c) => c.kind === "converted");
  const skipped = result.conversions.filter((c) => c.kind === "unconvertible");

  for (const c of converted) {
    if (c.kind !== "converted") continue;
    const dropNote = c.droppedTools.length ? ` [dropped: ${c.droppedTools.join(", ")}]` : "";
    const modelNote = c.unmappedModel ? ` [model "${c.unmappedModel}" passed through unmapped]` : "";
    console.log(`  ${c.name}  (${c.path} -> ${c.outPath})${dropNote}${modelNote}`);
  }
  for (const c of skipped) {
    if (c.kind !== "unconvertible") continue;
    console.error(`  SKIP ${c.path}: ${c.reason}`);
  }

  if (!converted.length) {
    console.log("update-pi-from-ak: agents — no source agents found, no-op.");
  } else if (check) {
    console.log(`update-pi-from-ak: agents — ${converted.length} agent(s) would convert (dry-run).`);
  } else {
    console.log(
      `update-pi-from-ak: agents — wrote ${result.written.length} agent definition(s) to ` +
        `${resolve(argValue("--agents-out") ?? defaultAgentOutRoot())}.\n` +
        `Backups written next to changed files as *${AGENT_BACKUP_SUFFIX}; roll back with --restore.`,
    );
  }

  return 0;
}

function main(): number {
  if (arg("--update")) {
    const failed = runAkUpdate(passthroughArgs());
    if (failed !== null) return failed;
  }

  const check = arg("--check");
  const restore = arg("--restore");
  const skipSkills = arg("--skip-skills");
  const skipAgents = arg("--skip-agents");

  let exit = 0;
  if (!skipSkills) exit = Math.max(exit, runSkillStep(check, restore));
  if (!skipAgents) exit = Math.max(exit, runAgentStep(check, restore));
  return exit;
}

if (import.meta.main) {
  process.exit(main());
}
