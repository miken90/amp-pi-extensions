// Integration tests for Mik mik-target-v1 structured assignments.
//
// Exercises the full routePrompt pipeline (parse -> score -> authority) against
// a realistic catalog, using complete representative contracts. These are the
// regression tests for the routing/authority issues identified in the review:
// forbidden_scope / control boilerplate must never select deploy/git/harness
// capabilities, while authorized deploy and authorized existing-Harness
// documentation sync must still route correctly.

import { test, expect } from "bun:test";
import { routePrompt } from "../extensions/auto-skills/pipeline.ts";
import { skillCategory } from "../extensions/auto-skills/authority.ts";
import { parsePrompt } from "../extensions/auto-skills/contract.ts";
import { DEFAULT_CONFIG } from "../extensions/auto-skills/types.ts";
import type { IndexedSkill } from "../extensions/auto-skills/types.ts";

function skill(name: string, description: string): IndexedSkill {
  return {
    name,
    description,
    filePath: `/s/${name}/SKILL.md`,
    baseDir: `/s/${name}`,
    disableModelInvocation: false,
    mtimeMs: 0,
    source: "test",
  };
}

const CATALOG = [
  skill("ak-debug", "Debug systematically with root cause analysis before fixes. Use for bugs, test failures, unexpected behavior, performance issues, call stack tracing, multi-layer validation, log analysis, CI/CD failures, database diagnostics, system investigation."),
  skill("ak-code-review", "Review code quality with evidence-based rigor. Supports pending changes, PR number, commit hash, and codebase scan. Focuses on bugs, regressions, maintainability, reliability, and verification gaps."),
  skill("ak-frontend-development", "Build React/TypeScript frontends with modern patterns. Use for components, Suspense, lazy loading, MUI v7 styling, TanStack Router, performance optimization."),
  skill("ak-databases", "Design schemas, write queries for MongoDB and PostgreSQL. Use for database design, SQL/NoSQL queries, aggregation pipelines, indexes, migrations, replication, performance optimization, psql CLI."),
  skill("ak-deploy", "Deploy projects to any platform with auto-detection. Use when user says deploy, publish, ship, go live, push to production, or host this app. Auto-detects deployment target from config files."),
  skill("ak-git", "Git operations with conventional commits. Use for staging, committing, pushing, PRs, merges. Auto-splits commits by type/scope. Security scans for secrets."),
  skill("ak-security", "STRIDE + OWASP-based security audit with optional red-team persona discovery loop and auto-fix. Scans code for vulnerabilities from multiple attacker perspectives."),
  skill("ak-test", "Run unit, integration, e2e, and UI tests. Use for test execution, coverage analysis, build verification, visual regression, and QA reports."),
  skill("install-repository-harness", "Install and wire up the repository-harness into a project. Use whenever the user wants to add, install, set up, refresh, or repair the harness convention in a repo."),
  skill("sync-repository-harness", "Sync repository harness docs from current code and completed work; dedupe stale docs and validate links. Use for existing-harness documentation synchronization only."),
  skill("ak-docs", "Analyze codebase and manage project documentation. Use for doc initialization, updates, summaries, codebase analysis."),
];

const CFG = DEFAULT_CONFIG;
const names = (r: { skill: IndexedSkill }[]) => r.map((s) => s.skill.name);

// ---- mik-target-v1 contracts (realistic shape per chief-of-staff §7) ----

const DEBUG = `contract: mik-target-v1
operation_id: mik-x-debug
cwd: /repo
mode: implement
objective: Fix the login bug where users see a 500 error after submitting credentials.
context:
  - The error started after the auth refactor.
  - Tests pass locally so it may be environment-specific.
allowed_scope:
  - Modify files under src/auth only.
forbidden_scope:
  - Do not commit, push, or deploy.
  - Do not install, refresh, repair, or modify the Harness.
control:
  - Dynamically select only materially relevant skills from the current runtime catalog.
  - Do not install, refresh, repair, or modify Harness unless explicitly authorized.
verification:
  authority: specified
  checks:
    - Run the auth test suite.
completion_condition: Login no longer 500s and tests pass.
post_work_synchronization:
  mode: disabled
  scope: existing-harness-documentation-only
result:
  operation_id: mik-x-debug
  status: completed`;

const REVIEW = `contract: mik-target-v1
operation_id: mik-x-review
cwd: /repo
mode: review
objective: Review pending changes in the pull request for correctness, security, and regressions.
context:
  - Focus on src/api routes.
allowed_scope:
  - Read-only review; do not modify files.
control:
  - Dynamically select only materially relevant skills from the current runtime catalog.
verification:
  authority: none`;

const FRONTEND = `contract: mik-target-v1
operation_id: mik-x-fe
cwd: /repo
mode: implement
objective: Add a responsive React dashboard page with a data table and charts.
context:
  - Use the existing design system.
allowed_scope:
  - Modify files under src/pages/dashboard.
control:
  - Dynamically select only materially relevant skills from the current runtime catalog.`;

const DATABASE = `contract: mik-target-v1
operation_id: mik-x-db
cwd: /repo
mode: implement
objective: Add a PostgreSQL index and optimize the slow user search query.
context:
  - The users table has 2M rows.
allowed_scope:
  - Modify migrations and src/db/queries.ts.
control:
  - Dynamically select only materially relevant skills from the current runtime catalog.`;

const SIMPLE = `contract: mik-target-v1
operation_id: mik-x-simple
cwd: /repo
mode: inspect
objective: Describe what the function calculateTotal in src/utils.ts does.
control:
  - Dynamically select only materially relevant skills from the current runtime catalog.`;

const AUTHORIZED_DEPLOY = `contract: mik-target-v1
operation_id: mik-x-deploy
cwd: /repo
mode: implement
objective: Deploy the application to production using the existing pipeline.
context:
  - Use the blue-green strategy.
allowed_scope:
  - Run the deploy pipeline and rollback if health checks fail.
control:
  - Dynamically select only materially relevant skills from the current runtime catalog.`;

const HARNESS_DOCS_SYNC = `contract: mik-target-v1
operation_id: mik-x-harnessdocs
cwd: /repo
mode: implement
objective: Sync existing Harness documentation with the completed work; do not install or repair the Harness.
context:
  - Only update docs that already exist.
allowed_scope:
  - Modify files under docs/harness only.
forbidden_scope:
  - Do not install, set up, refresh, or repair the Harness.
control:
  - Do not install, refresh, repair, or modify Harness unless explicitly authorized.`;

test("parsePrompt: contract routing query excludes forbidden/control/result sections", () => {
  const p = parsePrompt(DEBUG);
  expect(p.isContract).toBe(true);
  expect(p.objective).toContain("login bug");
  // routing query has objective+context but NOT forbidden/control boilerplate
  expect(p.routingQuery).not.toContain("Do not commit");
  expect(p.routingQuery).not.toContain("runtime catalog");
  expect(p.routingQuery).not.toContain("operation_id");
  expect(p.forbiddenScope).toContain("commit");
});

test("DEBUG assignment: selects ak-debug, suppresses deploy/git/harness", () => {
  const r = routePrompt(DEBUG, CATALOG, CFG);
  const sel = names(r.selected);
  expect(sel).toContain("ak-debug");
  // High-impact capabilities forbidden by this assignment must be absent.
  // Field extraction keeps forbidden-scope/control terms out of the routing
  // query, so these never score; authority gating is defense-in-depth.
  expect(sel).not.toContain("ak-deploy");
  expect(sel).not.toContain("ak-git");
  expect(sel).not.toContain("install-repository-harness");
});

test("DEBUG assignment: blocked skills are exactly the high-impact ones", () => {
  const r = routePrompt(DEBUG, CATALOG, CFG);
  for (const s of r.blockedByAuthority) {
    expect(skillCategory(s.skill)).toBeDefined();
  }
});

test("REVIEW assignment (read-only): selects code-review, suppresses deploy/git", () => {
  const r = routePrompt(REVIEW, CATALOG, CFG);
  const sel = names(r.selected);
  expect(sel).toContain("ak-code-review");
  expect(sel).not.toContain("ak-deploy");
  expect(sel).not.toContain("ak-git");
});

test("FRONTEND assignment: selects frontend-development, suppresses deploy/git", () => {
  const r = routePrompt(FRONTEND, CATALOG, CFG);
  const sel = names(r.selected);
  expect(sel).toContain("ak-frontend-development");
  expect(sel).not.toContain("ak-deploy");
  expect(sel).not.toContain("ak-git");
});

test("DATABASE assignment: selects databases, suppresses harness-install/deploy", () => {
  const r = routePrompt(DATABASE, CATALOG, CFG);
  const sel = names(r.selected);
  expect(sel).toContain("ak-databases");
  expect(sel).not.toContain("install-repository-harness");
  expect(sel).not.toContain("ak-deploy");
});

test("SIMPLE assignment: selects zero skills", () => {
  const r = routePrompt(SIMPLE, CATALOG, CFG);
  expect(r.selected.length).toBe(0);
});

test("AUTHORIZED DEPLOY: objective authorizes deploy, skill is selected", () => {
  const r = routePrompt(AUTHORIZED_DEPLOY, CATALOG, CFG);
  const sel = names(r.selected);
  expect(sel).toContain("ak-deploy");
  // git/commit is NOT authorized by a deploy objective -> still suppressed
  expect(sel).not.toContain("ak-git");
  expect(sel).not.toContain("install-repository-harness");
});

test("AUTHORIZED existing-Harness docs-sync: docs-sync allowed, install/repair blocked", () => {
  const r = routePrompt(HARNESS_DOCS_SYNC, CATALOG, CFG);
  const sel = names(r.selected);
  // Documentation synchronization is the authorized capability.
  expect(sel).toContain("sync-repository-harness");
  // Harness install/repair is explicitly forbidden and must stay blocked.
  expect(sel).not.toContain("install-repository-harness");
  expect(r.blockedByAuthority.some((s) => s.skill.name === "install-repository-harness")).toBe(true);
});

test("forbidden_scope mentioning deploy never selects deploy when objective is debug", () => {
  // Hardened regression for the review's F1 finding.
  const r = routePrompt(DEBUG, CATALOG, CFG);
  expect(names(r.selected)).not.toContain("ak-deploy");
});

test("default maxSelected aligns with Mik (<=3)", () => {
  expect(DEFAULT_CONFIG.maxSelected).toBeLessThanOrEqual(3);
  expect(DEFAULT_CONFIG.enforceAuthority).toBe(true);
});

test("ordinary natural-language prompt (non-contract) still routes and is not authority-gated as a contract", () => {
  // A plain interactive request that literally says deploy is not a bounded
  // Mik assignment; the user's explicit wording is respected.
  const r = routePrompt("please deploy my app to the cloud", CATALOG, CFG);
  expect(names(r.selected)).toContain("ak-deploy");
  expect(r.parsed.isContract).toBe(false);
});
