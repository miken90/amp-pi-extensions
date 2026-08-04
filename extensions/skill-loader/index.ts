import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type SkillEntry = {
  name: string;
  description: string;
  filePath: string;
};

const loadedBySession = new WeakMap<object, Set<string>>();

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function stripFrontmatter(content: string): string {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}

export function parseSkillEntries(systemPrompt: string): SkillEntry[] {
  const block = systemPrompt.match(/<available_skills>([\s\S]*?)<\/available_skills>/)?.[1];
  if (!block) return [];

  const entries: SkillEntry[] = [];
  for (const match of block.matchAll(/<skill>([\s\S]*?)<\/skill>/g)) {
    const body = match[1] ?? "";
    const name = body.match(/<name>([\s\S]*?)<\/name>/)?.[1]?.trim();
    const description = body.match(/<description>([\s\S]*?)<\/description>/)?.[1]?.trim();
    const filePath = body.match(/<location>([\s\S]*?)<\/location>/)?.[1]?.trim();
    if (name && description !== undefined && filePath) {
      entries.push({
        name: decodeXml(name),
        description: decodeXml(description),
        filePath: decodeXml(filePath),
      });
    }
  }
  return entries;
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function distance(left: string, right: string): number {
  const row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    let diagonal = row[0] ?? 0;
    row[0] = i;
    for (let j = 1; j <= right.length; j++) {
      const previous = row[j] ?? 0;
      row[j] = Math.min(
        (row[j] ?? 0) + 1,
        (row[j - 1] ?? 0) + 1,
        diagonal + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
      diagonal = previous;
    }
  }
  return row[right.length] ?? left.length;
}

// `disable-model-invocation: true` skills are deliberately excluded from Pi's
// model-facing <available_skills> block (they must not be auto-selected), but
// they are still meant to work via an explicit `/skill:name` command. Because
// this extension routes lookups through the same prompt-derived entry list
// (see `execute` below), those skills silently 404 unless we also discover
// them straight off disk and merge them in. This mirrors, on-disk, exactly
// the locations Pi's own skill loader scans (see docs/skills.md "Locations").

function frontmatterBlock(content: string): string | null {
  if (!content.startsWith("---")) return null;
  const end = content.indexOf("\n---", 3);
  return end < 0 ? null : content.slice(0, end);
}

function frontmatterField(front: string, key: string): string | undefined {
  const match = front.match(new RegExp(`^${key}:[ \t]*(.+)$`, "m"));
  if (!match) return undefined;
  let value = (match[1] ?? "").trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return value;
}

function skillEntryFromFile(filePath: string): SkillEntry | undefined {
  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
  const front = frontmatterBlock(content);
  if (!front) return undefined;
  const name = frontmatterField(front, "name");
  if (!name) return undefined;
  return { name, description: frontmatterField(front, "description") ?? "", filePath };
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Directories containing a `SKILL.md`, found recursively under `root` (bounded depth). */
function findSkillMdDirs(root: string, depth = 4): string[] {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const found: string[] = [];
  if (entries.includes("SKILL.md") && !isDirectory(join(root, "SKILL.md"))) found.push(root);
  if (depth <= 0) return found;
  for (const entry of entries) {
    if (entry.startsWith(".") || entry === "node_modules") continue;
    const path = join(root, entry);
    if (isDirectory(path)) found.push(...findSkillMdDirs(path, depth - 1));
  }
  return found;
}

export type DiskSkillRoots = {
  /** Roots where root-level `.md` files are individual skills AND `SKILL.md` subdirs are scanned. */
  rootMdAndNested: readonly string[];
  /** Roots where only `SKILL.md` subdirs are scanned (root `.md` files are ignored). */
  nestedOnly: readonly string[];
};

/** Default disk roots, mirroring docs/skills.md "Locations" exactly. */
export function defaultDiskSkillRoots(cwd: string): DiskSkillRoots {
  return {
    rootMdAndNested: [join(homedir(), ".pi", "agent", "skills"), join(cwd, ".pi", "skills")],
    nestedOnly: [join(homedir(), ".agents", "skills"), join(cwd, ".agents", "skills")],
  };
}

/**
 * Scan Pi's global + project-local skill directories directly off disk, so
 * `disable-model-invocation` skills (invisible in the rendered system prompt)
 * can still be resolved by exact `/skill:name` invocation.
 */
export function discoverDiskSkills(roots: DiskSkillRoots): SkillEntry[] {
  const entries: SkillEntry[] = [];
  const seen = new Set<string>();
  const addFile = (filePath: string) => {
    if (seen.has(filePath)) return;
    const entry = skillEntryFromFile(filePath);
    if (entry) {
      seen.add(filePath);
      entries.push(entry);
    }
  };

  for (const dir of roots.rootMdAndNested) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      if (entry.endsWith(".md") && !isDirectory(join(dir, entry))) addFile(join(dir, entry));
    }
  }

  for (const root of [...roots.rootMdAndNested, ...roots.nestedOnly]) {
    for (const dir of findSkillMdDirs(root)) addFile(join(dir, "SKILL.md"));
  }

  return entries;
}

export function findSkill(query: string, entries: readonly SkillEntry[]): SkillEntry | undefined {
  const normalized = normalize(query);
  if (!normalized) return undefined;

  const exact = entries.find((entry) => entry.name.toLowerCase() === query.toLowerCase());
  if (exact) return exact;

  const equivalent = entries.find((entry) => normalize(entry.name) === normalized);
  if (equivalent) return equivalent;

  const partial = entries.filter((entry) => {
    const name = normalize(entry.name);
    return name.includes(normalized) || normalized.includes(name);
  });
  if (partial.length === 1) return partial[0];

  let closest: { entry: SkillEntry; distance: number } | undefined;
  for (const entry of entries) {
    const name = normalize(entry.name);
    const current = distance(normalized, name);
    const threshold = Math.max(2, Math.floor(name.length / 4));
    if (current <= threshold && (!closest || current < closest.distance)) {
      closest = { entry, distance: current };
    }
  }
  return closest?.entry;
}

function suggestionsFor(query: string, entries: readonly SkillEntry[]): SkillEntry[] {
  const normalized = normalize(query);
  return [...entries]
    .map((entry) => ({ entry, distance: distance(normalized, normalize(entry.name)) }))
    .sort((left, right) => left.distance - right.distance)
    .slice(0, 3)
    .map(({ entry }) => entry);
}

export function transformSkillCommand(text: string): string | undefined {
  return text.startsWith("/skill:") ? ` ${text}` : undefined;
}

function loadedSkillsFor(sessionManager: object): Set<string> {
  let loaded = loadedBySession.get(sessionManager);
  if (!loaded) {
    loaded = new Set<string>();
    loadedBySession.set(sessionManager, loaded);
  }
  return loaded;
}

export type SkillLoaderDeps = {
  /** Override disk skill discovery (tests inject a fixed root set). */
  discoverDiskSkills?: (cwd: string) => SkillEntry[];
};

export default function skillLoader(pi: ExtensionAPI, deps?: SkillLoaderDeps): void {
  const discoverDisk = deps?.discoverDiskSkills ?? ((cwd: string) => discoverDiskSkills(defaultDiskSkillRoots(cwd)));
  const clearSessionCache = (_event: unknown, ctx: { sessionManager: object }) => {
    loadedBySession.delete(ctx.sessionManager);
  };
  pi.on("session_compact", clearSessionCache);
  pi.on("session_tree", clearSessionCache);
  pi.on("input", (event) => {
    const transformed = transformSkillCommand(event.text);
    return transformed
      ? { action: "transform" as const, text: transformed }
      : { action: "continue" as const };
  });

  pi.registerTool({
    name: "skill",
    label: "skill",
    description:
      "Invoke and activate an installed skill by name. Use this tool whenever a user asks to load/use a skill or when their task matches a skill in <available_skills>. The result contains instructions to follow, not content to summarize. Do not use read on SKILL.md directly.",
    promptSnippet: "Invoke an installed skill",
    promptGuidelines: [
      "When a task matches an entry in <available_skills>, call the skill tool before acting.",
      "Treat skill tool output as active instructions: follow it and do not summarize it unless the user explicitly asks for a summary.",
      "Do not read SKILL.md directly; use the skill tool so invocation is tracked and rendered consistently.",
    ],
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          minLength: 1,
          description: 'Skill name from <available_skills>, such as "agent-browser" or "ak-debug".',
        },
      },
      required: ["name"],
      additionalProperties: false,
    },
    executionMode: "parallel",
    async execute(_id, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) throw new Error("Skill invocation aborted before execution.");

      const requestedName = params.name.trim();
      const visibleEntries = parseSkillEntries(ctx.getSystemPrompt());
      let skill = findSkill(requestedName, visibleEntries);
      // Not in the model-visible list: it may be a `disable-model-invocation`
      // skill, which Pi deliberately hides from <available_skills> but still
      // means to support via explicit `/skill:name`. Fall back to an on-disk
      // scan before giving up.
      const diskEntries = skill ? [] : discoverDisk(ctx.cwd);
      if (!skill) skill = findSkill(requestedName, diskEntries);
      const entries = [...visibleEntries, ...diskEntries];
      if (!skill) {
        const suggestions = suggestionsFor(requestedName, entries);
        return {
          content: [{
            type: "text" as const,
            text: entries.length === 0
              ? "No installed skills are visible in <available_skills>."
              : [
                  `Skill "${requestedName}" was not found.`,
                  suggestions.length ? "Did you mean:" : "",
                  ...suggestions.map((entry) => `- ${entry.name} — ${entry.description}`),
                ].filter(Boolean).join("\n"),
          }],
          details: { skillName: requestedName, filePath: "", isError: true },
        };
      }

      const loaded = loadedSkillsFor(ctx.sessionManager);
      if (loaded.has(skill.filePath)) {
        return {
          content: [{
            type: "text" as const,
            text: `Skill "${skill.name}" is already active in this session. Continue following its instructions without invoking it again.`,
          }],
          details: { skillName: skill.name, filePath: skill.filePath, alreadyLoaded: true },
        };
      }

      try {
        const body = stripFrontmatter(readFileSync(skill.filePath, "utf8")).trim();
        loaded.add(skill.filePath);
        return {
          content: [{
            type: "text" as const,
            text: [
              `Skill "${skill.name}" invoked. Follow these instructions for the current task; do not summarize them.`,
              `References are relative to ${dirname(skill.filePath)}.`,
              "",
              body,
            ].join("\n"),
          }],
          details: { skillName: skill.name, filePath: skill.filePath },
        };
      } catch (error) {
        return {
          content: [{
            type: "text" as const,
            text: `Failed to invoke skill "${skill.name}": ${error instanceof Error ? error.message : String(error)}`,
          }],
          details: { skillName: skill.name, filePath: skill.filePath, isError: true },
        };
      }
    },
  });
}
