// Builds the "selected skills" block injected into the system prompt for a
// turn. When preloading is enabled, reads the selected SKILL.md bodies
// (capped) so the model has them without an extra read round-trip.

import { readFileSync } from "node:fs";
import type { AutoSkillsConfig, ScoredSkill } from "./types.ts";

/** Format the auto-skills observability line for the footer status. */
export function formatStatus(selected: ScoredSkill[], enabled: boolean, indexSize: number): string {
  if (!enabled) return `auto-skills: off (${indexSize})`;
  if (selected.length === 0) return `auto-skills: - (${indexSize})`;
  const names = selected.map((s) => s.skill.name).slice(0, 3).join(",");
  const more = selected.length > 3 ? `+${selected.length - 3}` : "";
  return `auto-skills: ${names}${more} (${indexSize})`;
}

/**
 * Build the system-prompt addition listing selected skills. Optionally
 * includes their SKILL.md bodies up to the configured byte caps.
 *
 * Bodies are loaded lazily here (only for selected skills), never eagerly for
 * the whole catalog.
 */
export function buildSelectedBlock(selected: ScoredSkill[], cfg: AutoSkillsConfig): string {
  if (selected.length === 0) return "";

  const lines: string[] = [
    "",
    "<auto-skills>",
    "The following installed skills were assessed as materially relevant to the user's current request. Prefer these. Load full instructions only if you did not already receive them below.",
  ];

  let total = 0;
  let bodyBudget = cfg.maxTotalBytes;

  for (const { skill, score } of selected) {
    lines.push(
      `- skill: ${skill.name} (relevance ${score.toFixed(1)}) — ${truncate(skill.description, 160)} (path: ${skill.filePath})`,
    );
    if (!cfg.preload) continue;

    const body = readBody(skill.filePath);
    if (!body) continue;

    const cap = Math.min(cfg.maxBodyBytes, bodyBudget);
    if (cap <= 0) continue;
    const sliced = body.length > cap ? body.slice(0, cap) + "\n...[truncated]" : body;
    bodyBudget -= sliced.length;
    total += sliced.length;
    lines.push(`\n----- ${skill.name} SKILL.md -----\n${sliced}\n----- end ${skill.name} -----`);
  }

  lines.push(`</auto-skills>`);
  return lines.join("\n");
}

function readBody(filePath: string): string | null {
  try {
    const raw = readFileSync(filePath, "utf8");
    // Strip frontmatter delimiters to avoid duplicating metadata already
    // shown in the bullet line.
    return raw.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
  } catch {
    return null;
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
