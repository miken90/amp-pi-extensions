---
title: "Phase 2: prompt-editor"
status: completed
---

# Phase 2: prompt-editor

## Overview

Port `darkamenosa/pi-setup`'s `extensions/prompt-editor.ts` (1333 lines,
Apache-2.0) into `extensions/prompt-editor/index.ts`, registering a `/mode`
command plus two keyboard shortcuts (`ctrl+shift+m`, `ctrl+space`) that let
the user define, switch, and persist named "modes" — each a
(provider, modelId, thinkingLevel, editor-border color) tuple — stored in
`modes.json` (global: `~/.pi/agent/modes.json`; project: `.pi/modes.json`).

This phase touches disk (a new `modes.json` file with its own file-locking
scheme) and interacts with model/thinking-level selection, so it must be
verified not to conflict with this repo's existing `pinnedModel` extension,
which already owns "what model does a session start on" semantics.

## Requirements

### Functional

- [ ] Register `/mode` command (reference: `extensions/prompt-editor.ts:1232`;
      confirmed non-colliding with hd-agent's `usage-hdwebsoft`/`tps`/`clear`/
      `exit` or this repo's `askills` — see plan.md collision check).
- [ ] Register shortcuts `ctrl+shift+m` and `ctrl+space` (reference:
      `extensions/prompt-editor.ts:1274,1281`; confirmed no existing
      `registerShortcut` call anywhere in hd-agent or this repo as of this
      plan — re-verify at implementation time).
- [ ] Support mode CRUD: create/rename/delete named modes; only `"default"`
      is a forced built-in (reference: `DEFAULT_MODE_ORDER`,
      `CUSTOM_MODE_NAME` — `extensions/prompt-editor.ts:33-34`).
- [ ] Persist modes to `modes.json` with the schema
      `{ version: 1, currentMode: ModeName, modes: Record<ModeName, ModeSpec> }`
      (reference: `extensions/prompt-editor.ts:26-30`), at both global
      (`~/.pi/agent/modes.json`) and project (`.pi/modes.json`) scope, project
      overriding global (reference: `getGlobalModesPath`/`getProjectModesPath`
      — `extensions/prompt-editor.ts:50-56`).
- [ ] Use the reference's cross-process file-locking scheme
      (`withFileLock`, `getLockPathForFile`, stale-lock breaking after 30s —
      `extensions/prompt-editor.ts:84-120`) to avoid corrupting `modes.json`
      under concurrent Pi sessions.
- [ ] Reuse Pi SDK's `CustomEditor` and `ModelSelectorComponent` for the
      interactive mode editor UI (confirmed exported —
      `dist/modes/interactive/components/{custom-editor,model-selector}.d.ts`).

### Non-functional

- [ ] **No interference with `pinnedModel`.** This repo's
      `extensions/pinned-model/index.ts` resets `/new` sessions to a pinned
      model via a separate `pinnedModel` settings block that "Pi never
      overwrites" (per `README.md`'s pinned-model section). `prompt-editor`'s
      `modes.json` and mode-switching must not write to
      `~/.pi/agent/settings.json`'s `pinnedModel` key, `defaultProvider`, or
      `defaultModel` fields, and must not fire on `session_start` with
      reason `"new"` in a way that races or overrides `pinned-model`'s own
      `session_start` handler. If a genuine interaction is unavoidable
      (e.g. both extensions want to set the model on the same event), this
      must be flagged as an open decision for the user before
      implementation, not resolved unilaterally by priority-ordering hacks.
- [ ] `getGlobalAgentDir()` in the reference duplicates (does not import)
      Pi's own `getAgentDir()` (reference comment:
      "Mirror pi-coding-agent's getAgentDir() behavior (best-effort)" —
      `extensions/prompt-editor.ts:42-48`). Since this repo's SDK already
      exports `getAgentDir` (`dist/index.d.ts:2`), the port must call the
      real `getAgentDir()` instead of reimplementing it, removing the
      "best-effort" duplication risk the reference carries.
- [ ] Apache-2.0 attribution header citing
      `https://github.com/darkamenosa/pi-setup/blob/main/extensions/prompt-editor.ts`.

## Architecture

- New directory: `extensions/prompt-editor/` (directory convention, matching
  this repo's existing extensions).
- Suggested module split: `modes-store.ts` (file I/O + locking + schema),
  `modes.ts` (pure CRUD logic over `ModesFile`, unit-testable without disk),
  `index.ts` (Pi extension entry: command, shortcuts, TUI wiring).
- No `package.json` changes needed (auto-discovered).

## Related Code Files

- Create: `extensions/prompt-editor/index.ts` (+ split modules per
  Architecture above)
- Create: `test/prompt-editor.test.ts` (unit tests for `ModesFile` CRUD,
  file-locking behavior with a temp dir, and — critically — a regression
  test asserting `prompt-editor` never writes `pinnedModel`,
  `defaultProvider`, or `defaultModel` keys into a shared `settings.json`
  fixture)
- Modify: `README.md` (add `### prompt-editor` feature section, `## Layout`
  entry, attribution entry; cross-reference the existing `### pinned-model`
  section to document the non-interference boundary)

## Implementation Steps

1. Fetch and fully read the reference file (1333 lines; paginate reads)
   before coding, to capture the complete mode-editor TUI flow, shortcut
   behaviors, and any settings-file interaction not covered by the excerpt
   read during planning (lines 1-120 only).
2. Re-verify Pi 0.83.0 SDK exports (`CustomEditor`, `ModelSelectorComponent`,
   `SettingsManager`, `getAgentDir`) are unchanged from the plan-time grep
   evidence.
3. Re-read this repo's `extensions/pinned-model/index.ts` in full and
   enumerate every settings key and event handler it owns
   (`session_start` with `reason: "new"`, the `pinnedModel` settings block)
   so the port can provably avoid touching them.
4. Implement `modes-store.ts`/`modes.ts` first with unit tests (schema
   round-trip, project-over-global precedence, lock contention, stale-lock
   recovery) before wiring the TUI.
5. Port the TUI (`CustomEditor`/`ModelSelectorComponent` usage), `/mode`
   command, and the two shortcuts.
6. Write the pinned-model non-interference regression test described in
   Related Code Files.
7. Add Apache-2.0 attribution headers.
8. Update `README.md`.
9. Run `bun test`; confirm 0 regressions against the running baseline
   (137 + Phase 1's new tests).
10. Smoke-test: `pi -e ./extensions/prompt-editor` starts cleanly; manually
    exercise `/mode` create/switch/delete against a temp `HOME` to avoid
    touching the real `~/.pi/agent/modes.json` during verification.

## Success Criteria

- [ ] `/mode` and both shortcuts registered with zero collisions
      (re-verified at implementation time).
- [ ] `modes.json` round-trips correctly at both global and project scope,
      project overriding global.
- [ ] Proven (by test) zero writes to `pinnedModel`/`defaultProvider`/
      `defaultModel` settings keys.
- [ ] `bun test` green, no regressions.
- [ ] Apache-2.0 attribution present.

## Risk Assessment

- **Risk:** the reference's mode-switching may implicitly call something
  equivalent to Pi's `setModel` on session events that overlaps with
  `pinned-model`'s own `session_start` hook, creating a race or
  last-writer-wins bug invisible until a user has both extensions active
  (the common case here, since this repo already ships `pinned-model`).
  **Mitigation:** Implementation Step 3 mandates a full read of
  `pinned-model` before writing any event-handler code in this phase, and
  Step 6 mandates a regression test proving non-interference. If the full
  reference read (Step 1) reveals an unavoidable overlap, stop and surface
  the exact conflicting event/handler pair to the user rather than picking
  an arbitrary resolution.
- **Risk:** duplicated `getAgentDir()`-mirroring logic in the reference is a
  known upstream code smell (their own comment flags it "best-effort"); if
  ported verbatim it silently drifts if Pi's real `getAgentDir()` logic
  changes. **Mitigation:** requirement above mandates calling the real
  SDK export instead.
- **Rollback:** delete `extensions/prompt-editor/`, `test/prompt-editor.test.ts`,
  the `modes.json` files it may have created during manual testing (never
  the real ones — testing must use a temp `HOME`), and revert the `README.md`
  section.
