// Shared types for the auto-skills extension.
// Mirrors the subset of Pi's Skill shape we depend on, so this file has no
// runtime dependency on the pi-coding-agent package and can be unit-tested
// in isolation. The real Pi Skill is structurally compatible.

export interface SkillRef {
  /** Skill name (frontmatter `name`). */
  name: string;
  /** Short description (frontmatter `description`). */
  description: string;
  /** Absolute path to the SKILL.md file. */
  filePath: string;
  /** Skill root directory (dirname of SKILL.md). */
  baseDir: string;
  /** True if frontmatter `disable-model-invocation: true`. */
  disableModelInvocation: boolean;
}

/** Index entry: a parsed skill plus filesystem metadata used for refresh. */
export interface IndexedSkill extends SkillRef {
  /** mtimeMs of the SKILL.md file at last parse. */
  mtimeMs: number;
  /** Source label, e.g. "global", "project", "pi". */
  source: string;
}

/** Result of an incremental refresh. */
export interface RefreshDelta {
  added: IndexedSkill[];
  modified: IndexedSkill[];
  removed: IndexedSkill[];
  /** Stable snapshot for the current turn. */
  snapshot: IndexedSkill[];
}

/** A scored skill from the router. */
export interface ScoredSkill {
  skill: IndexedSkill;
  score: number;
  matchedTerms: string[];
}

export interface AutoSkillsConfig {
  enabled: boolean;
  /** Maximum skills to surface per turn. Default 2 aligns with Mik's
   * "smallest useful set" guidance (simple: 0–1, cross-domain: 2–3). */
  maxSelected: number;
  /** Minimum score to consider a skill materially relevant. */
  threshold: number;
  /** Pre-load the full SKILL.md body of selected skills into the prompt. */
  preload: boolean;
  /** Per-skill body byte cap when preloading. */
  maxBodyBytes: number;
  /** Total preloaded byte cap per turn. */
  maxTotalBytes: number;
  /** Extra skill directories to scan (absolute or home-relative). */
  locations: string[];
  /** When true (default), block auto-selecting high-impact capabilities
   * (deploy/git/harness-install/external) unless the objective authorizes
   * them. Matches Mik chief-of-staff §10. */
  enforceAuthority: boolean;
}

export const DEFAULT_CONFIG: AutoSkillsConfig = {
  enabled: true,
  maxSelected: 2,
  // 1.0 = at least one description match (or better). Safe at this level
  // because contract routing scores only the objective+context (boilerplate
  // is excluded) and high-impact skills are authority-gated.
  threshold: 1.0,
  preload: true,
  maxBodyBytes: 8192,
  maxTotalBytes: 28672,
  locations: [],
  enforceAuthority: true,
};
