// Unit tests for authority gating — defense-in-depth on top of field extraction.
// Proves that even when a high-impact skill WOULD score, it is blocked unless
// the objective affirmatively authorizes that capability, and that negated
// phrases ("do not deploy") never count as authorization.

import { test, expect } from "bun:test";
import { skillCategory, isAuthorizedFor } from "../extensions/auto-skills/authority.ts";
import { parsePrompt } from "../extensions/auto-skills/contract.ts";
import type { IndexedSkill } from "../extensions/auto-skills/types.ts";

function skill(name: string, description: string): IndexedSkill {
  return { name, description, filePath: `/s/${name}/SKILL.md`, baseDir: `/s/${name}`, disableModelInvocation: false, mtimeMs: 0, source: "t" };
}

const DEPLOY = skill("ak-deploy", "Deploy projects to any platform. Use when user says deploy, publish, ship, go live.");
const GIT = skill("ak-git", "Git operations: staging, committing, pushing, PRs, merges.");
const HARNESS_INSTALL = skill("install-repository-harness", "Install and wire up the repository-harness. Use to add, install, set up, refresh, or repair the harness.");
const DOCS_SYNC = skill("sync-repository-harness", "Sync repository harness docs from code and completed work. Existing-harness documentation synchronization only.");
const DEBUG = skill("ak-debug", "Debug systematically with root cause analysis. Use for bugs, test failures, performance issues.");

test("skillCategory classifies high-impact capabilities", () => {
  expect(skillCategory(DEPLOY)).toBe("deploy");
  expect(skillCategory(GIT)).toBe("git");
  expect(skillCategory(HARNESS_INSTALL)).toBe("harness-install");
  expect(skillCategory(DOCS_SYNC)).toBeUndefined();
  expect(skillCategory(DEBUG)).toBeUndefined();
});

test("non-high-impact skills are always authorized", () => {
  const p = parsePrompt("contract: mik-target-v1\nobjective: anything\n");
  expect(isAuthorizedFor(DEBUG, p)).toBe(true);
  expect(isAuthorizedFor(DOCS_SYNC, p)).toBe(true);
});

test("deploy skill blocked when objective is debug (no deploy authorization)", () => {
  const p = parsePrompt("contract: mik-target-v1\nobjective: Fix the login bug.\nforbidden_scope:\n  - Do not deploy.\n");
  expect(isAuthorizedFor(DEPLOY, p)).toBe(false);
});

test("deploy skill allowed when objective affirmatively says deploy", () => {
  const p = parsePrompt("contract: mik-target-v1\nobjective: Deploy the application to production.\n");
  expect(isAuthorizedFor(DEPLOY, p)).toBe(true);
});

test("negated deploy in objective does NOT authorize deploy", () => {
  // Regression: "do not deploy" must not satisfy the deploy auth pattern.
  const p = parsePrompt("contract: mik-target-v1\nobjective: Fix the bug; do not deploy or push to production.\n");
  expect(isAuthorizedFor(DEPLOY, p)).toBe(false);
});

test("harness install/repair blocked even when objective mentions harness docs", () => {
  const p = parsePrompt("contract: mik-target-v1\nobjective: Sync existing Harness documentation; do not install or repair the Harness.\nallowed_scope:\n  - Modify docs/harness only.\n");
  expect(isAuthorizedFor(HARNESS_INSTALL, p)).toBe(false); // install blocked
  expect(isAuthorizedFor(DOCS_SYNC, p)).toBe(true); // docs sync is not high-impact -> allowed
});

test("git skill blocked for read-only review objective", () => {
  const p = parsePrompt("contract: mik-target-v1\nmode: review\nobjective: Review pending changes for correctness; do not modify, commit, or push.\n");
  expect(isAuthorizedFor(GIT, p)).toBe(false);
});

test("ordinary (non-contract) prompt is not authority-gated as a Mik contract", () => {
  // A plain interactive "deploy my app" is the user's explicit wording, not a
  // bounded assignment; authority gating defers to the user here.
  const p = parsePrompt("please deploy my app to the cloud");
  expect(p.isContract).toBe(false);
  expect(isAuthorizedFor(DEPLOY, p)).toBe(true);
});
