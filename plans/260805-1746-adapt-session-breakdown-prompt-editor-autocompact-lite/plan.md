---
title: "Adapt session-breakdown, prompt-editor, autocompact-lite"
description: "Port session-breakdown and prompt-editor from darkamenosa/pi-setup; build a minimal Pi-0.83-native autocompact-lite. Plan-only; no application code in this operation."
status: completed
priority: P1
effort: "M"
tags: ["extensions", "pi-setup-adapt", "review-approved"]
created: 2026-08-05
---

# Adapt session-breakdown, prompt-editor, autocompact-lite

## Overview

Following the read-only comparison review (`mik-20260805T1032Z-r7k2`), the user
approved three slices from `darkamenosa/pi-setup` (main, Apache-2.0,
https://github.com/darkamenosa/pi-setup) for adaptation into this repo
(`pi-extensions` / `amp-pi`, MIT), in this order:

1. **session-breakdown** — read-only session-history analytics TUI (`/session-breakdown`).
2. **prompt-editor** — interactive mode/model/thinking-level editor (`/mode` + 2 shortcuts).
3. **autocompact-lite** — a *minimal Pi-0.83-native reimplementation* of proactive
   context-overflow recovery, **not** a near-verbatim port of the reference
   `autocompact.ts` (which also does OpenAI-native remote-compaction
   checkpointing, subagent capability negotiation, and goal-extension
   coordination — out of scope here).

This plan is the sole deliverable of the current operation
(`mik-20260805T1048Z-p4n8`). It authorizes no application-code changes; it only
documents what a later `/ak:cook` (or equivalent) dispatch must build, verify,
and roll back on.

## Source evidence (re-established this session, not assumed from prior review)

- `gh repo view darkamenosa/pi-setup --json licenseInfo` → Apache License 2.0 confirmed.
- Reference files fetched via `gh api repos/darkamenosa/pi-setup/contents/...` and
  read locally under `/tmp/{session-breakdown,prompt-editor,autocompact}.ts`:
  - `extensions/session-breakdown.ts` — 1707 lines.
  - `extensions/prompt-editor.ts` — 1333 lines.
  - `extensions/autocompact.ts` — 1837 lines (confirms scope for a "lite" reimplementation, not a port).
- Current repo baseline: `bun test` → **137 pass, 0 fail, 283 expect() calls, 10 files**
  (re-run this session; matches prior review's reported baseline).
- Current repo extensions: `auto-skills/`, `skill-loader/`, `pinned-model/`, `ak-hooks-bridge/`
  (`ls extensions/`). Only registered command found: `askills`
  (`extensions/auto-skills/index.ts:139`).
- hd-agent (`git:github.com/tuong-nguyen-vn/hd-agent`, loaded per
  `~/.pi/agent/settings.json`) registered commands found by grep:
  `usage-hdwebsoft`, `tps`, `clear`, `exit`
  (`src/extensions/{provider/hdwebsoft-proxy,tps,_init}/index.ts`). No
  `registerShortcut` calls found in hd-agent's extension tree.
- Pi SDK (`@earendil-works/pi-coding-agent` 0.83.0, installed at
  `~/.bun/install/global/node_modules/@earendil-works/pi-coding-agent`) confirmed
  to export every symbol the three reference extensions import:
  - Compaction primitives (`compact`, `shouldCompact`, `CompactionSettings`,
    `CompactionResult`, `DEFAULT_COMPACTION_SETTINGS`, `getLastAssistantUsage`,
    `estimateTokens`) — `dist/core/compaction/compaction.d.ts`, re-exported from
    `dist/index.d.ts`.
  - Event types `SessionBeforeCompactEvent`, `ContextUsage`, `TurnEndEvent`,
    `ContextEvent` — `dist/core/extensions/index.d.ts` (re-exported).
  - UI components `BorderedLoader`, `CustomEditor`, `ModelSelectorComponent` —
    `dist/modes/interactive/components/{bordered-loader,custom-editor,model-selector}.d.ts`.
  - `SettingsManager`, `getAgentDir` — `dist/core/settings-manager.d.ts`,
    `dist/config.ts` re-export.
  - `ExtensionAPI.registerCommand(name, opts)` and
    `ExtensionAPI.registerShortcut(shortcut, opts)` —
    `dist/core/extensions/types.d.ts:892,894`.
- Command/keybinding collision check: `session-breakdown` (reference
  `extensions/session-breakdown.ts:1620`), `mode` (reference
  `extensions/prompt-editor.ts:1232`), shortcuts `ctrl+shift+m` and
  `ctrl+space` (reference `extensions/prompt-editor.ts:1274,1281`) — **none**
  match any command/shortcut found in hd-agent or this repo's existing
  extensions (see prior bullet). No settings-level keybinding overrides found
  in `~/.pi/agent/settings.json`.

## Non-goals (explicit)

- No implementation of the three extensions in this operation — plan only.
- No Codex search, Codex vision, or Grok search/vision (excluded by contract).
- No reference-repo *skills* (`librarian`, `summarize`, `tmux`, `pi-share`) —
  reviewed separately per contract.
- `autocompact-lite` explicitly excludes: OpenAI-native remote-compaction
  checkpointing (`remote_compaction_v2` protocol, Codex OAuth calls),
  subagent capability-negotiation channels, and goal-extension coordination
  (`TRANSIENT_GOAL_CONTEXT_TYPES` handling) present in the reference
  `autocompact.ts`. These are Pi-core/goal-extension concerns this repo does
  not currently own.
- No global `~/.pi/agent/settings.json` edits, package installs, or extension
  registration in `settings.json` — a later cook dispatch installs/enables
  these under the existing local-package pattern (`package.json` →
  `pi.extensions: ["./extensions"]`), which already auto-discovers new
  subdirectories without a settings change.
- No credential setup (none of these three extensions require external auth).

## Licensing / attribution requirement

Source repo is Apache-2.0; this repo is MIT. Apache-2.0 §4 requires: (a) give
recipients a copy of the License, (b) state prominently that files were
changed, (c) retain copyright/attribution notices in the Source form. Every
adapted file must carry a header naming the origin, the license, and a summary
of what changed (full port vs. reimplementation), and the repo must gain a
`NOTICE`/attribution entry (either a top-level `NOTICE` file or a dedicated
`## Third-party attribution` section in `README.md`) covering the borrowed
lines. Do not relicense the borrowed code as MIT; the header states it remains
Apache-2.0-derived. Legal-substance question (relicensing scope, header
wording) is flagged as an open risk in each phase and must be resolved before
merge, not silently assumed.

## Goals

| # | Goal | Priority |
|---|------|----------|
| 1 | Ship `/session-breakdown` as a read-only analytics TUI with zero write side effects and zero command/keybinding conflicts | P1 |
| 2 | Ship `/mode` (prompt-editor) for provider/model/thinking-level switching without touching `pinnedModel` semantics or `~/.pi/agent/settings.json` schema owned by other extensions | P1 |
| 3 | Ship a minimal `autocompact-lite` that proactively compacts using Pi 0.83's own `compact()`/`shouldCompact()` primitives, with no OpenAI-native/Codex/goal-extension coupling | P1 |
| 4 | Preserve this repo's testing bar: every new extension ships with `bun test` coverage; full suite stays green | P1 |
| 5 | Satisfy Apache-2.0 attribution obligations for every adapted line | P1 |

## Phases

| # | Phase | Status |
|---|-------|--------|
| 1 | [Phase 1: session-breakdown](./phase-01-start.md) | Pending |
| 2 | [Phase 2: prompt-editor](./phase-02-prompt-editor.md) | Pending |
| 3 | [Phase 3: autocompact-lite](./phase-03-autocompact-lite.md) | Pending |

Phases are ordered and independently verifiable; each must pass its own
acceptance gate (below) before the next starts. A later cook dispatch may
still choose to implement them as three separate PRs/commits.

## Cross-cutting acceptance criteria (apply to every phase)

- `bun test` passes with **0 regressions** against the 137-test baseline
  established this session (new tests only add, never replace, existing
  passing tests).
- `pi -e ./extensions/<new-dir>` loads without a startup error, and
  `pi --mode json -p '...' --no-session` smoke-checks the registered
  command/tool exists in the JSON event stream.
- No new `registerCommand`/`registerShortcut` name collides with anything
  enumerated in "Command/keybinding collision check" above; re-verify against
  the *current* hd-agent + repo state at implementation time (upstream
  packages can change between plan and cook).
- No new extension writes to Pi's session JSONL, `~/.pi/agent/settings.json`,
  or another extension's state file (`auto-skills.json`, `fast-mode.json`,
  etc.) without an explicit, separately-approved settings key.
- Every adapted/reimplemented file carries the Apache-2.0 attribution header
  described above; `README.md`/`NOTICE` gains the corresponding entry.
- `README.md`'s feature list and `## Layout` tree are updated to document the
  new extension(s) (matches this repo's existing documentation convention,
  see current `README.md` structure for `auto-skills`/`ak-hooks-bridge`).

## Rollback / stop conditions (whole plan)

- **Rollback:** each phase lives in its own `extensions/<name>/` directory
  with no cross-phase file edits; removing the directory (and its `test/*`
  file, and its README section) fully reverts that phase with no residual
  state, because `pi.extensions: ["./extensions"]` auto-discovers directories
  and nothing else references them by path.
- **Stop and return to the user, do not proceed, if at cook time:**
  - Pi's installed SDK version has changed and any symbol listed in "Source
    evidence" no longer exports from `@earendil-works/pi-coding-agent` (re-run
    the same grep-based verification before writing code).
  - A command name or shortcut collision is newly detected against hd-agent or
    this repo (upstream may have added commands since this plan was written).
  - Attribution wording/scope is unresolved (legal-substance ambiguity is
    explicitly out of this operation's authority).
  - `bun test` cannot be kept green without weakening an existing passing test.

## Success Criteria

- [ ] `plans/260805-1746-adapt-session-breakdown-prompt-editor-autocompact-lite/`
      contains `plan.md` + 3 phase files, all passing `ak plan validate`.
- [ ] Each phase file has: overview, functional/non-functional requirements,
      exact related files (create-only — no modify/delete of existing repo
      files outside `README.md` and `package.json`'s discovery pattern, which
      needs no edit), step-by-step implementation steps referencing exact
      reference-repo line ranges, a per-phase acceptance gate, and a
      phase-scoped risk/rollback note.
- [ ] No application code changed by this operation (verified: `git status`
      shows only additions under `plans/`).

<!-- slug: adapt-session-breakdown-prompt-editor-autocompact-lite -->
