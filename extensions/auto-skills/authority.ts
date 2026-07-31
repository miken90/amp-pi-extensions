// Authority gating for high-impact skills.
//
// Mik (chief-of-staff §10): "Never invoke onboarding, Harness improvement,
// deployment, commit, push, or external-action skills without matching user
// authority." Auto-routing must not inject instructions for these capabilities
// unless the assignment explicitly authorizes them in the objective.
//
// This is defense-in-depth on top of contract-aware routing: even if a
// forbidden-scope phrase leaked into the routing query, a high-impact skill is
// only selected when the *objective* asks for that capability.
//
// "Skills are procedures, not authorization" (§9): selecting a skill never
// broadens the assignment's authority; the injected block says to honor scope.

import type { ParsedPrompt } from "./contract.ts";
import type { SkillRef } from "./types.ts";

export type Capability =
  | "deploy"
  | "git"
  | "harness-install"
  | "external"
  | "security-audit";

interface CategoryDef {
  /** Matched against the skill name + lowercased description. */
  skillPattern: RegExp;
  /** A skill in this category is auto-selectable only if the objective matches. */
  authPattern: RegExp;
}

const CATEGORIES: Record<Exclude<Capability, never>, CategoryDef> = {
  // Shipping / releasing to production or a hosting platform.
  deploy: {
    skillPattern: /\b(deploy|publish|ship|release|host|go[\s-]?live|push[\s-]to[\s-]production|rollback)\b/i,
    authPattern: /\b(deploy|publish|ship|release|host|go[\s-]?live|rollback|production|prod)\b/i,
  },
  // Commit / push / PR / merge — VCS write actions.
  git: {
    skillPattern: /\b(commit|push|pull[\s-]request|merge[\s-]request|\bpr\b|\bvcs\b|\bgit\b)\b/i,
    authPattern: /\b(commit|push|pull[\s-]request|merge[\s-]request|\bpr\b|\bvcs\b)\b/i,
  },
  // Harness install / setup / repair / refresh — mutating the harness itself.
  // Deliberately distinct from harness *documentation* sync, which is not here.
  "harness-install": {
    skillPattern: /\b(install|harness[\s-](install|setup|repair|refresh|repair)|set[\s-]up|repair|reinstall)\b.*\b(harness)\b|\b(harness)\b.*\b(install|setup|repair|refresh|reinstall)\b/i,
    authPattern: /\b(install|set[\s-]up|repair|refresh|reinstall)\b.*\b(harness)\b|\b(harness)\b.*\b(install|setup|repair|refresh|reinstall)\b/i,
  },
  // External communication / network / credentials.
  external: {
    skillPattern: /\b(webhook|send[\s-]message|external[\s-]communication|notify[\s-]slack|email|sms|outbound)\b/i,
    authPattern: /\b(webhook|send|external[\s-]communication|notify|email|sms)\b/i,
  },
  // Active security attack / red-team — distinct from passive review.
  "security-audit": {
    skillPattern: /\b(red[\s-]?team|penetration|exploit|attack[\s-]simulat)\b/i,
    authPattern: /\b(red[\s-]?team|penetration|exploit|attack[\s-]simulat)\b/i,
  },
};

/** Classify a skill's high-impact capability, if any. */
export function skillCategory(skill: SkillRef): Capability | undefined {
  const text = `${skill.name} ${skill.description}`;
  for (const [key, def] of Object.entries(CATEGORIES) as Array<[Capability, CategoryDef]>) {
    if (def.skillPattern.test(text)) return key;
  }
  return undefined;
}

/**
 * Decide whether a skill may be auto-selected for this assignment.
 *
 * - Non-high-impact skills: always allowed.
 * - High-impact skills: allowed only when the objective (or explicit
 *   allowed-scope wording) authorizes that specific capability. We check the
 *   objective primarily; allowed-scope is a fallback for cases where authority
 *   is stated as a scope permission rather than the goal.
 */
export function isAuthorizedFor(skill: SkillRef, prompt: ParsedPrompt): boolean {
  const cap = skillCategory(skill);
  if (!cap) return true;

  // Non-contract (ordinary) prompts: defer to the user's own wording. The model
  // and the user see what is injected; ordinary interactive requests are not
  // bounded Mik assignments, so we don't second-guess explicit asks.
  if (!prompt.isContract) return true;

  const def = CATEGORIES[cap];
  const authText = stripNegated(`${prompt.objective} ${prompt.allowedScope}`);
  return def.authPattern.test(authText);
}

// Remove negated spans so prohibitions do not read as authorization.
// "do not install or repair the Harness" / "do not modify, commit, or push"
// must NOT satisfy an auth pattern. A negation consumes its whole clause up
// to a sentence/clause boundary (. or ;) so comma-lists under the negation
// are removed together; only affirmative mentions remain.
const NEGATED = /\b(?:do\s+not|don't|must\s+not|cannot|can't|without|never|not|forbidden|no)\b[^.;]*/gi;
function stripNegated(text: string): string {
  return text.replace(NEGATED, " ");
}
