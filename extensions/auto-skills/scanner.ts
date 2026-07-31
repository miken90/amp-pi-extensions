// Self-contained SKILL.md discovery + frontmatter parser.
//
// We deliberately do NOT import loadSkillsFromDir from the pi package at
// runtime: under Pi's jiti loader, runtime imports of
// @earendil-works/pi-coding-agent resolve the package's .d.ts and fail on
// internal specifiers. Pi's own examples use `import type` only. This scanner
// re-implements the small subset of Pi's discovery rules we need, using only
// node built-ins, so it works under jiti/bun and is unit-testable.
//
// Discovery rules mirrored from Pi (see docs/skills.md):
//  - if a directory contains SKILL.md, treat it as a skill root (do not recurse)
//  - otherwise recurse into subdirectories to find SKILL.md
//  - in ~/.pi/agent/skills and .pi/skills, direct root .md files are also skills

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { SkillRef } from "./types.ts";

/** Pi-compatible directory parser (matches the SkillParser signature). */
export function scanSkillDir(dir: string, source: string): SkillRef[] {
  if (!existsSync(dir)) return [];
  const out: SkillRef[] = [];

  const trySkillFile = (file: string, baseDir: string) => {
    const parsed = parseFrontmatter(readFileSafe(file));
    if (!parsed.name || !parsed.description) return; // Pi skips missing description
    out.push({
      name: parsed.name,
      description: parsed.description,
      filePath: file,
      baseDir,
      disableModelInvocation: parsed["disable-model-invocation"] === true,
    });
  };

  const walk = (d: string, allowRootMd: boolean) => {
    let entries: ReturnType<typeof readdirSync>;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }

    const skillMd = join(d, "SKILL.md");
    if (existsSync(skillMd)) {
      trySkillFile(skillMd, d);
      return; // skill root: do not recurse further
    }

    for (const ent of entries) {
      const full = join(d, ent.name);
      if (ent.isDirectory()) {
        walk(full, false);
      } else if (allowRootMd && ent.isFile() && ent.name.endsWith(".md") && ent.name !== "SKILL.md") {
        trySkillFile(full, d);
      }
    }
  };

  walk(dir, allowRootMdFor(source));
  return out;
}

// Root .md files are only treated as skills in these two locations, per Pi.
function allowRootMdFor(source: string): boolean {
  return source === "global" || source === "project-pi";
}

function readFileSafe(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/** Parse YAML frontmatter (the simple `key: value` subset Pi skills use). */
export function parseFrontmatter(raw: string): Record<string, string | boolean> {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const out: Record<string, string | boolean> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (!key) continue;
    out[key] = value === "true" ? true : value === "false" ? false : value;
  }
  return out;
}
