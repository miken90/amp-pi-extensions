// Skill discovery with mtime-aware incremental refresh.
//
// Pure logic (no runtime import of the pi package). The real frontmatter
// parser is injected via `SkillParser`; tests pass a fake, and production
// wiring supplies the self-contained `scanSkillDir` from scanner.ts.

import { statSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import type { IndexedSkill, RefreshDelta, SkillRef } from "./types.ts";

/** Parses skill frontmatter from a directory tree, Pi-compatible subset. */
export type SkillParser = (dir: string, source: string) => SkillRef[];

/** Immutable index of skills keyed by filePath, with mtime tracking. */
export class SkillIndex {
  private entries = new Map<string, IndexedSkill>();

  constructor(private parse: SkillParser) {}

  size(): number {
    return this.entries.size;
  }

  snapshot(): IndexedSkill[] {
    return [...this.entries.values()];
  }

  get(filePath: string): IndexedSkill | undefined {
    return this.entries.get(filePath);
  }

  /**
   * Re-scan the given directories and merge with `extra` (skills supplied by
   * Pi's own catalog, e.g. from npm packages). Detects add/modify/remove by
   * comparing file mtimes; only re-parses changed or new files.
   *
   * Directories are always re-walked (cheap) so deleted files are detected
   * even mid-session, satisfying the reliable-before-each-turn requirement.
   */
  refresh(dirs: Array<{ dir: string; source: string }>, extra: SkillRef[] = []): RefreshDelta {
    const added: IndexedSkill[] = [];
    const modified: IndexedSkill[] = [];
    const removed: IndexedSkill[] = [];

    const seen = new Set<string>();

    for (const { dir, source } of dirs) {
      if (!dir || !existsSync(dir)) continue;
      let parsed: SkillRef[] = [];
      try {
        parsed = this.parse(dir, source);
      } catch {
        // A broken skill directory must not abort the whole refresh.
        continue;
      }
      for (const ref of parsed) {
        const filePath = ref.filePath;
        seen.add(filePath);
        const mtimeMs = safeMtime(filePath);
        const prev = this.entries.get(filePath);
        const entry: IndexedSkill = { ...ref, mtimeMs, source };
        if (!prev) {
          added.push(entry);
        } else if (prev.mtimeMs !== mtimeMs || !sameSkill(prev, entry)) {
          modified.push(entry);
        }
        this.entries.set(filePath, entry);
      }
    }

    // Merge extras (Pi-provided skills we can't stat, e.g. from packages).
    for (const ref of extra) {
      const filePath = ref.filePath;
      if (seen.has(filePath)) continue;
      seen.add(filePath);
      const mtimeMs = safeMtime(filePath); // 0 if non-existent
      const prev = this.entries.get(filePath);
      const entry: IndexedSkill = { ...ref, mtimeMs, source: "pi" };
      if (!prev) {
        added.push(entry);
      } else if (prev.mtimeMs !== mtimeMs || !sameSkill(prev, entry)) {
        modified.push(entry);
      }
      this.entries.set(filePath, entry);
    }

    // Remove entries whose files vanished.
    for (const [filePath, entry] of this.entries) {
      if (seen.has(filePath)) continue;
      this.entries.delete(filePath);
      removed.push(entry);
    }

    return { added, modified, removed, snapshot: this.snapshot() };
  }

  clear(): void {
    this.entries.clear();
  }
}

function sameSkill(a: IndexedSkill, b: IndexedSkill): boolean {
  return (
    a.name === b.name &&
    a.description === b.description &&
    a.disableModelInvocation === b.disableModelInvocation
  );
}

function safeMtime(filePath: string): number {
  try {
    return statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

/** Standard Pi skill directories for the given cwd and agent config dir. */
export function defaultSkillDirs(agentDir: string, cwd: string): Array<{ dir: string; source: string }> {
  const home = homedir();
  return [
    { dir: `${agentDir}/skills`, source: "global" },
    { dir: `${home}/.agents/skills`, source: "user-agents" },
    { dir: `${cwd}/.pi/skills`, source: "project-pi" },
    { dir: `${cwd}/.agents/skills`, source: "project-agents" },
  ];
}
