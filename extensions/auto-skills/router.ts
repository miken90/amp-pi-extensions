// Skill selection router: scores skills against a user request and returns the
// materially relevant ones. Pure and deterministic; no LLM calls, no network.

import type { IndexedSkill, ScoredSkill } from "./types.ts";

const STOPWORDS = new Set([
  "a","an","the","and","or","but","if","then","else","when","at","by","for","with","about","to","of","in","on","is","are","be","been","being","was","were","do","does","did","doing","have","has","had","i","me","my","we","our","you","your","it","its","this","that","these","those","can","could","should","would","may","might","will","shall","please","help","use","using","used","get","make","made","want","need","like","into","from","as","how","what","which","who","whom","whose","not","no","so","than","too","very","just","also","up","out","over","under","again","more","most","some","any","each",
  // filler / acknowledgment tokens
  "ok","okay","yes","yeah","sure","now","stuff","things","thing","way","ways","etc",
]);

/**
 * Light suffix stemmer so singular/plural and a few tense variants match.
 * Applied identically to prompt and skill text, so recall improves without
 * hurting precision (both sides normalize the same way).
 */
function stem(t: string): string {
  if (t.length > 4 && t.endsWith("ing")) return t.slice(0, -3);
  if (t.length > 4 && t.endsWith("ed")) return t.slice(0, -2);
  if (t.length > 4 && t.endsWith("es")) return t.slice(0, -2);
  if (t.length > 3 && t.endsWith("s")) return t.slice(0, -1);
  return t;
}

/** Tokenize free text into normalized lowercase stemmed terms. */
export function tokenize(text: string): string[] {
  const raw = text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const out: string[] = [];
  for (const t of raw) {
    if (t.length < 2) continue;
    if (STOPWORDS.has(t)) continue;
    out.push(stem(t));
  }
  return out;
}

/** Name + description tokens precomputed per skill for fast matching. */
export interface SkillTerms {
  filePath: string;
  nameTokens: Set<string>; // includes hyphen-split parts
  descTokens: Set<string>;
}

export function buildTerms(skill: IndexedSkill): SkillTerms {
  // Name tokens: split on non-alphanumerics then stem, so "pdf-tools" yields
  // {pdf, tool} matching "tools" in a prompt.
  const nameParts = new Set<string>();
  for (const part of tokenize(skill.name)) nameParts.add(part);
  return {
    filePath: skill.filePath,
    nameTokens: nameParts,
    descTokens: new Set(tokenize(skill.description)),
  };
}

/**
 * Detect an explicit user skill invocation that must bypass auto-routing.
 * Pi expands `/skill:name` natively; we also recognize common harness
 * conventions (`/ak:...`) so explicit invocation always wins.
 */
export function isExplicitSkillInvocation(text: string): boolean {
  const t = text.trimStart();
  if (t.startsWith("/skill:")) return true;
  if (/^\/ak:[a-z]/i.test(t)) return true;
  return false;
}

/**
 * Score skills against prompt tokens. Weights favor name matches over
 * description matches and reward multi-token coverage of a skill. Returns
 * skills above `threshold`, sorted by score, capped at `maxSelected`.
 *
 * "Ordinary requests may select zero skills": if nothing clears the
 * threshold, returns [].
 */
export function selectSkills(
  prompt: string,
  skills: IndexedSkill[],
  opts: { threshold: number; maxSelected: number },
): ScoredSkill[] {
  const promptTokens = tokenize(prompt);
  if (promptTokens.length === 0 || skills.length === 0) return [];

  const uniqTokens = new Set(promptTokens);
  const scored: ScoredSkill[] = [];

  for (const skill of skills) {
    if (skill.disableModelInvocation) continue;
    const terms = buildTerms(skill);
    let score = 0;
    const matched: string[] = [];
    for (const tok of uniqTokens) {
      if (terms.nameTokens.has(tok)) {
        score += 3;
        matched.push(tok);
      } else if (terms.descTokens.has(tok)) {
        score += 1;
        matched.push(tok);
      }
    }
    if (score <= 0) continue;
    // Light normalization to avoid penalizing terse descriptions too hard,
    // while still rewarding focused relevance.
    const coverageBonus = matched.length >= 2 ? 0.5 : 0;
    score += coverageBonus;
    if (score >= opts.threshold) scored.push({ skill, score, matchedTerms: matched });
  }

  scored.sort((a, b) => b.score - a.score || b.matchedTerms.length - a.matchedTerms.length);
  return scored.slice(0, opts.maxSelected);
}
