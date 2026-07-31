// Pure end-to-end routing pipeline: parse the prompt, score the routing query,
// then enforce authority boundaries. Shared by the extension entry's
// before_agent_start handler and the /askills test command so dry-runs match
// real behavior exactly. Also the unit-test entry point for Mik contracts.

import { parsePrompt, type ParsedPrompt } from "./contract.ts";
import { isAuthorizedFor } from "./authority.ts";
import { selectSkills } from "./router.ts";
import type { AutoSkillsConfig, IndexedSkill, ScoredSkill } from "./types.ts";

export interface RouteResult {
  selected: ScoredSkill[];
  parsed: ParsedPrompt;
  /** Skills that scored well but were dropped by authority gating. */
  blockedByAuthority: ScoredSkill[];
}

export function routePrompt(
  prompt: string,
  skills: IndexedSkill[],
  cfg: Pick<AutoSkillsConfig, "threshold" | "maxSelected" | "enforceAuthority">,
): RouteResult {
  const parsed = parsePrompt(prompt);
  const scored = selectSkills(parsed.routingQuery, skills, {
    threshold: cfg.threshold,
    maxSelected: cfg.maxSelected,
  });
  if (!cfg.enforceAuthority) {
    return { selected: scored, parsed, blockedByAuthority: [] };
  }
  const selected: ScoredSkill[] = [];
  const blockedByAuthority: ScoredSkill[] = [];
  for (const s of scored) {
    if (isAuthorizedFor(s.skill, parsed)) selected.push(s);
    else blockedByAuthority.push(s);
  }
  return { selected, parsed, blockedByAuthority };
}
