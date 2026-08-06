---
title: "Phase 1: session-breakdown"
status: completed
---

# Phase 1: session-breakdown

## Overview

Port `darkamenosa/pi-setup`'s `extensions/session-breakdown.ts` (1707 lines,
Apache-2.0) into `extensions/session-breakdown/index.ts` in this repo,
registering a `/session-breakdown` command that renders a read-only
GitHub-contributions-style TUI over `~/.pi/agent/sessions/**/*.jsonl`
(sessions/messages/tokens/cost per day, 7/30/90-day windows, model/cwd/
day-of-week/time-of-day breakdown views).

This is the lowest-risk of the three phases: **read-only** analysis of
existing files, no writes, no new settings keys, no session-storage mutation.

## Requirements

### Functional

- [ ] Register `/session-breakdown` command (matches reference exactly;
      confirmed non-colliding — see plan.md "Command/keybinding collision
      check").
- [ ] Recursively scan `~/.pi/agent/sessions/**/*.jsonl` (reference:
      `extensions/session-breakdown.ts:1-32` header comment + `os`/`path`/
      `fs/promises` imports) and parse per-session: start time, day (local),
      day-of-week bucket, time-of-day bucket, models used, message count,
      token count, cost by model.
- [ ] Render calendar heatmap (weeks × weekdays), hue = model-weighted color
      mix, brightness = log-scaled selected metric (reference:
      `sliceByColumn`, `DOW_NAMES`, `TOD_BUCKETS`, `todBucketForHour` —
      `extensions/session-breakdown.ts:40-105`).
- [ ] Support view toggles: model / cwd / day-of-week / time-of-day
      (`BreakdownView` type, `extensions/session-breakdown.ts:38`).
- [ ] Support 7/30/90-day window switching via keybindings scoped to the
      command's own TUI overlay (not global shortcuts) — read the full
      reference file (`start=121` onward via the read tool) at implementation
      time to enumerate the exact in-TUI key handling before writing code.

### Non-functional

- [ ] **Zero filesystem writes.** The extension must only `readdir`/`stat`/
      stream-read `*.jsonl`; no `writeFile`, no `unlink`, no lock files. This
      is a stronger guarantee than prompt-editor/autocompact-lite and must be
      enforced by a unit test that fails if any `fs` write API is invoked.
- [ ] No new persisted state file under `~/.pi/agent/` (unlike `auto-skills`'s
      `auto-skills.json` or `fast-mode`'s `fast-mode.json` in the reference
      repo) — view/window toggles are in-memory/session-scoped only.
- [ ] Must not import or depend on `@earendil-works/pi-ai` cost-calculation
      internals beyond what the reference already inlines; if the reference
      relies on a cost field already present in session JSONL entries, reuse
      it as-is rather than reimplementing pricing tables.
- [ ] Apache-2.0 attribution header at the top of
      `extensions/session-breakdown/index.ts` citing
      `https://github.com/darkamenosa/pi-setup/blob/main/extensions/session-breakdown.ts`,
      the Apache-2.0 license, and a one-line summary of any changes made
      (directory restructuring, import path adjustments, anything beyond a
      verbatim port).

## Architecture

- New directory: `extensions/session-breakdown/` (mirrors this repo's
  existing per-extension-directory convention seen in `extensions/auto-skills/`,
  `extensions/ak-hooks-bridge/`, `extensions/pinned-model/`,
  `extensions/skill-loader/` — each a directory, not a loose file, unlike the
  reference repo's flat `extensions/*.ts` layout).
- Split the single 1707-line reference file into logical modules following
  this repo's existing pattern (e.g. `discovery.ts` for the JSONL scan/parse,
  `breakdown.ts` for the aggregation math, `render.ts` for the TUI component,
  `index.ts` for the Pi extension entry + command registration) — exact
  module boundaries are an implementation-time decision, not fixed by this
  plan, but must preserve unit-testability (pure functions separated from
  `ExtensionAPI`/TUI wiring), matching `auto-skills`'s `pipeline.ts`/
  `router.ts`/`discovery.ts` separation.
- No changes to `package.json` — `pi.extensions: ["./extensions"]` already
  auto-discovers the new subdirectory.

## Related Code Files

- Create: `extensions/session-breakdown/index.ts` (+ split modules per
  Architecture above)
- Create: `test/session-breakdown.test.ts` (unit tests for the pure
  parse/aggregate functions using synthetic JSONL fixtures — no real
  `~/.pi/agent/sessions` access in tests, matching this repo's existing
  pattern of injectable deps seen in `test/pinned-model.test.ts:9-36`)
- Modify: `README.md` (add a `### session-breakdown` feature section
  matching the existing style for `### auto-skills`/`### ak-hooks-bridge`,
  plus a `## Layout` tree entry and a `## Third-party attribution` /
  `NOTICE` entry per plan.md's licensing requirement)

## Implementation Steps

1. Fetch the full reference file (`gh api
   repos/darkamenosa/pi-setup/contents/extensions/session-breakdown.ts`) and
   read it completely (1707 lines exceed one read call's cap — paginate with
   `start`/`end`) before writing any code, to capture the exact TUI key
   handling, cost/token aggregation, and color-mixing logic omitted from this
   plan's summary.
2. Verify current Pi 0.83.0 SDK still exports `BorderedLoader`, `Key`,
   `matchesKey`, `type Component`, `type TUI`, `truncateToWidth`,
   `visibleWidth` from `@earendil-works/pi-tui` / `@earendil-works/pi-coding-agent`
   (re-run the grep-based check from plan.md; do not assume the plan-time
   result still holds).
3. Design the module split (Architecture section) and write pure,
   dependency-injectable parse/aggregate functions first; write
   `test/session-breakdown.test.ts` against synthetic fixtures before wiring
   the TUI.
4. Port the TUI rendering and command registration, preserving the reference
   behavior (calendar heatmap, view toggles, window toggles) while adapting
   only import paths and directory structure.
5. Add the Apache-2.0 attribution header to every new/ported source file.
6. Update `README.md` (feature section, `## Layout` tree, attribution entry).
7. Run `bun test`; confirm 137 baseline tests still pass plus new
   `session-breakdown` tests, with 0 regressions.
8. Smoke-test: `pi -e ./extensions/session-breakdown` starts without error;
   `pi --mode json -p 'run /session-breakdown' --no-session` (or equivalent
   direct command invocation supported by Pi's JSON mode) confirms the
   command is registered and does not throw when `~/.pi/agent/sessions`
   is empty or missing (edge case: fresh install with zero session history).

## Success Criteria

- [ ] `/session-breakdown` renders without touching disk except read-only
      `fs` calls (enforced by a test double or mock verifying no write API
      is called).
- [ ] Zero collisions with hd-agent/repo commands or shortcuts (re-verified,
      not just plan-time asserted).
- [ ] `bun test` green, no regressions against the 137-test baseline.
- [ ] Works correctly with zero, one, and many session files (edge cases
      explicitly tested).
- [ ] Apache-2.0 attribution present in source header + README/NOTICE.

## Risk Assessment

- **Risk:** the reference file's exact TUI keybinding scheme and cost/token
  aggregation formulas are not fully captured in this plan (only the first
  120 of 1707 lines were read during planning). **Mitigation:** Implementation
  Step 1 mandates reading the complete file before coding; this plan
  intentionally defers exact byte-for-byte behavior transcription to
  implementation time rather than guessing.
- **Risk:** cost calculation may depend on a pricing table or model registry
  shape that has since changed upstream in `@earendil-works/pi-ai`.
  **Mitigation:** reuse whatever cost/token fields the session JSONL entries
  already contain (Pi core already computes and stores these) rather than
  reimplementing pricing; if the reference computes cost independently,
  flag this as a decision point for the implementer rather than silently
  diverging.
- **Rollback:** delete `extensions/session-breakdown/`,
  `test/session-breakdown.test.ts`, and revert the `README.md` section —
  no other file depends on this phase.
