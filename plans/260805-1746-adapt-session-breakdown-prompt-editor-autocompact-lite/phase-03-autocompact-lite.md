---
title: "Phase 3: autocompact-lite"
status: completed
---

# Phase 3: autocompact-lite

## Overview

Build `extensions/autocompact-lite/index.ts` as a **minimal, Pi-0.83-native
reimplementation** of proactive context-overflow recovery — inspired by, but
explicitly **not** a port of, `darkamenosa/pi-setup`'s `extensions/autocompact.ts`
(1837 lines, Apache-2.0). Scope is deliberately narrowed to: detect approaching
context overflow between model turns using Pi's own `shouldCompact()` +
`compact()` primitives, and trigger a proactive compaction before the next
model request, using only Pi core's portable text-summary compaction path.

Because this is a reimplementation rather than a port, most of the reference
file's scope is **out of scope by design** (see Non-goals). This phase's
"related code" section therefore does not enumerate reference line ranges the
way Phases 1-2 do — instead it names the reference concepts consulted for
inspiration and the Pi-core primitives that replace them.

## Non-goals (phase-specific, in addition to plan.md's)

- No OpenAI-native remote-compaction checkpointing
  (`remote_compaction_v2` protocol, `NATIVE_COMPACTION_FEATURE`,
  `NativeCompactionError`, Codex OAuth calls — reference
  `extensions/autocompact.ts:14-54,149-`). This entire subsystem depends on
  Codex OAuth credentials, which the contract excludes.
- No subagent capability-negotiation channel handling
  (`CAPABILITY_REQUEST_CHANNEL`/`CAPABILITY_RESPONSE_CHANNEL` — reference
  `:52-54`). hd-agent's `subagent` extension already owns subagent
  orchestration in this setup; autocompact-lite must not introduce a second,
  competing capability-negotiation protocol.
- No goal-extension coordination
  (`TRANSIENT_GOAL_CONTEXT_TYPES` — reference `:55`). The reference repo's
  `goal.ts` extension was reviewed and marked ADAPT-candidate separately (not
  in this plan's three approved slices); autocompact-lite must not assume its
  presence or special-case its message types.
- No continuation-message replay machinery for reasoning-truncation recovery
  (`CONTINUATION_MESSAGE_TYPE`, `PROACTIVE_CONTINUATION_MARKER_CONTENT` —
  reference `:33-36`) — this overlaps with the reference's separate
  `keep-thinking.ts` extension (rejected in the prior review as
  GPT-5.5-specific) and is out of scope for a model-agnostic lite version.
- No buffered-input replay across compaction boundaries
  (`BUFFERED_INPUT_*` — reference `:36-37,77-87`) in v1; if proactive
  compaction mid-turn is later found to drop in-flight user input, this is an
  explicit follow-up decision, not silently solved by copying the reference's
  mechanism.

## Requirements

### Functional

- [ ] On `turn_end` (or the nearest Pi-0.83 event exposing post-turn context
      usage — confirmed available: `TurnEndEvent`, `ContextEvent` from
      `dist/core/extensions/index.d.ts`), compute context usage via Pi's own
      `getLastAssistantUsage()` + `estimateTokens()`/`calculateContextTokens`
      (all confirmed exported, `dist/index.d.ts:5`) and call `shouldCompact()`
      with the session's actual `CompactionSettings` (read via
      `SettingsManager`, not reimplemented).
- [ ] If `shouldCompact()` returns true, proactively invoke Pi's own
      `compact()` (confirmed signature:
      `compact(preparation, model, apiKey, headers?, customInstructions?, signal?, thinkingLevel?, streamFn?, env?, retry?, callbacks?): Promise<CompactionResult>` —
      `dist/core/compaction/compaction.d.ts:136`) using `prepareCompaction()`
      to build the `CompactionPreparation`, before the next model turn starts
      — i.e., proactively, not only reactively after Pi core's own overflow
      handling already fires.
- [ ] Surface status via `ctx.ui.setStatus(...)` (matching this repo's
      existing pattern in `auto-skills/index.ts:49,65,79,117`) so the user
      can see when a proactive compaction ran and why.
- [ ] No new slash command required for v1 (this is a background behavior,
      like the reference's core mechanism) — if a manual "`/compact-lite now`"
      trigger is wanted, that is an explicit, separately-decided addition,
      not assumed here.

### Non-functional

- [ ] **Must not duplicate or override Pi core's own compaction triggering.**
      Pi 0.83 already owns compaction settings and its own overflow-retry
      path (per the reference file's own header comment: "Pi owns compaction
      settings, overflow retries, and session checkpoints" —
      `extensions/autocompact.ts:4-5`). autocompact-lite adds *earlier*,
      *proactive* triggering between turns; it must not fight Pi core's
      reactive path (e.g., must not disable or bypass Pi's built-in handling
      of `SessionBeforeCompactEvent`, only add an additional, compatible
      proactive trigger).
- [ ] No `openai-codex`/`openai-codex-responses`-specific branching
      (reference's `SUPPORTED_APIS`/`SUPPORTED_PROVIDERS`-style provider
      gating, seen in the related `fast.ts` extension, is a pattern to avoid
      re-introducing here — the lite version must be provider-agnostic,
      relying only on Pi core's `compact()`, which is already
      provider-agnostic).
- [ ] No new persisted state file; if a "last proactive compaction" timestamp
      needs to be tracked to avoid double-triggering within one turn, keep it
      in-memory (closure state), not disk-persisted — matching this repo's
      existing preference for minimal persisted state (only `auto-skills`
      persists `~/.pi/agent/auto-skills.json`, and that is an explicit,
      documented exception).
- [ ] Apache-2.0 attribution is **conceptual, not verbatim**: since this is a
      reimplementation and not a code port, the header must state "inspired
      by darkamenosa/pi-setup's autocompact.ts (Apache-2.0); no source lines
      copied — reimplemented against Pi 0.83's public compaction API" rather
      than the verbatim-port attribution language used in Phases 1-2. If, at
      implementation time, any line is in fact copied or closely paraphrased
      from the reference, it must be re-classified as a port and carry the
      full Phase-1/2-style attribution instead — this decision must be made
      honestly at implementation time, not decided in advance by this plan.

## Architecture

- New directory: `extensions/autocompact-lite/` (directory convention).
- Suggested module split: `usage.ts` (wraps `getLastAssistantUsage`/
  `estimateTokens`/`shouldCompact` with this extension's own thresholds),
  `trigger.ts` (the `turn_end` handler + proactive `compact()` invocation),
  `index.ts` (Pi extension entry).
- Explicitly **not** modeled on the reference's single 1837-line monolith —
  the whole point of "lite" is a small, auditable surface area (target: an
  order of magnitude smaller than the reference, driven by the Non-goals
  above, not by an arbitrary line-count budget).

## Related Code Files

- Create: `extensions/autocompact-lite/index.ts` (+ split modules per
  Architecture above)
- Create: `test/autocompact-lite.test.ts` (unit tests using injected fake
  `shouldCompact`/`compact`/`SettingsManager` — matching this repo's existing
  dependency-injection test pattern, e.g. `test/pinned-model.test.ts:9-36` —
  covering: below-threshold no-op, above-threshold triggers `compact()` once
  per turn, `compact()` failure is reported via `ctx.ui.notify` and does not
  crash the turn, and Pi core's own reactive compaction path is left
  untouched when this extension is disabled)
- Modify: `README.md` (add `### autocompact-lite` feature section explicitly
  distinguishing it from a full port, `## Layout` entry, and an attribution
  entry using the conceptual-inspiration wording above)

## Implementation Steps

1. Re-read the reference `extensions/autocompact.ts` header comment and the
   already-read lines 1-150 (this plan's evidence) to confirm the Non-goals
   boundary still matches upstream reality; do **not** read the full
   1837 lines in depth for this phase — the whole point of "lite" is to stop
   at the concept level and build against Pi's own public compaction API,
   not the reference's internal machinery.
2. Re-verify Pi 0.83.0 SDK still exports `compact`, `shouldCompact`,
   `prepareCompaction` (note: `prepareCompaction` was seen in the compaction
   module but is **not** in the curated `dist/index.d.ts` re-export list
   captured during planning — re-check at implementation time whether it
   must be imported from the deeper `core/compaction/compaction.ts` path or
   whether an equivalent top-level-exported helper should be used instead;
   resolve this import-path question before writing the trigger logic).
3. Enumerate Pi 0.83's exact `turn_end`/`ContextEvent` payload shape (via the
   installed `.d.ts` files, not assumption) to confirm what usage/token data
   is available without re-deriving it from raw session entries.
4. Implement `usage.ts` with unit tests against synthetic `Usage`/
   `CompactionSettings` fixtures (no real session I/O).
5. Implement `trigger.ts`'s `turn_end` handler calling `shouldCompact()` then
   `compact()`, with `ctx.ui.setStatus`/`ctx.ui.notify` wiring and error
   handling that fails open (a compaction failure must never crash the
   user's turn — matching this repo's existing `ak-hooks-bridge`'s
   fail-open-on-timeout precedent, per `README.md`'s ak-hooks-bridge
   section).
6. Write the regression test proving Pi core's own reactive compaction path
   is untouched (i.e., this extension only *adds* an earlier trigger; it does
   not intercept or suppress `SessionBeforeCompactEvent` in a way that
   changes Pi core's own behavior when autocompact-lite would not have
   fired).
7. Decide honestly (per the Requirements note on attribution) whether the
   final implementation counts as "reimplemented" or, if it turns out
   unavoidably close to the reference's proactive-trigger logic, as a
   "ported" excerpt — set the attribution header language accordingly.
8. Update `README.md`.
9. Run `bun test`; confirm 0 regressions against the running baseline
   (137 + Phase 1 + Phase 2's new tests).
10. Smoke-test: `pi -e ./extensions/autocompact-lite` starts cleanly with a
    long synthetic session (or `--offline` + a crafted session file) to
    exercise the near-threshold path without live model calls where
    possible; document any step that requires a live model call and cannot
    be verified offline.

## Success Criteria

- [ ] Proactive compaction fires only when `shouldCompact()` says so, using
      Pi's own settings — no hardcoded thresholds duplicating
      `CompactionSettings`.
- [ ] Proven (by test) that Pi core's own reactive compaction path is
      unmodified when this extension is absent/disabled.
- [ ] Compaction failure fails open (never crashes a turn).
- [ ] No Codex/Grok/OAuth, no subagent capability channel, no goal-extension
      coupling, no continuation-replay machinery present anywhere in the
      diff (explicit code-review checklist item for the later cook dispatch).
- [ ] `bun test` green, no regressions.
- [ ] Attribution header language matches the honest reimplement-vs-port
      determination made in Implementation Step 7.

## Risk Assessment

- **Risk (highest in this plan):** "minimal reimplementation" is inherently
  underspecified until Pi 0.83's exact `turn_end`/context-usage event payload
  is inspected in full at implementation time; this plan's Implementation
  Step 2-3 flag two concrete open questions (`prepareCompaction` import path;
  exact event payload shape) rather than guessing, but the eventual design
  may still need a short spike before phase completion. **Mitigation:** if
  the spike reveals Pi core already does proactive between-turn compaction
  itself (making this whole extension redundant), stop and report that
  finding to the user instead of shipping a no-op or duplicate mechanism.
- **Risk:** double-triggering compaction (once by this extension proactively,
  once by Pi core reactively) could waste tokens/cost on a redundant summary
  call. **Mitigation:** the regression test in Related Code Files must
  explicitly assert the reactive path does not re-fire immediately after a
  proactive compaction already ran in the same turn boundary.
- **Risk:** attribution classification (reimplementation vs. port) is
  genuinely undecidable before code is written. **Mitigation:** Implementation
  Step 7 defers the final call to code-review time with an explicit honesty
  requirement, rather than pre-committing to "reimplementation" language that
  might later prove inaccurate.
- **Rollback:** delete `extensions/autocompact-lite/` and
  `test/autocompact-lite.test.ts`, revert the `README.md` section. Because
  this phase only *adds* a `turn_end` listener and never disables/replaces
  Pi core's own compaction path, removing the directory fully restores prior
  behavior with no other file touched.

## Follow-up: percentage-plus-reserve threshold (mik-20260805T1320Z-a5j2)

The original implementation used only `contextWindow - reserveTokens` (mirroring
Pi core's `shouldCompact()`), which produced inconsistent trigger percentages
across model window sizes. Updated to a dual threshold:
`min(contextWindow * thresholdPercent / 100, contextWindow - reserveTokens)`.

- Added `thresholdPercent` (default 85) and `cooldownTurns` (default 2) to
  `CompactionSettings`.
- Settings are read from the `autoCompactLite` block in `settings.json`
  (global + project, project wins), following the repo's established pattern.
- Cooldown suppresses re-triggers for `cooldownTurns` turns unless a token
  reduction below threshold is observed (re-arming).
- Raw percentage remains unclamped — values >100% are valid overload signals.
- No model names or window sizes hardcoded; `contextWindow` is consumed
  dynamically from `ctx.getContextUsage()`.
- Tests expanded from 13 to 36 (threshold math, boundaries, invalid settings,
  cooldown, re-arming, dynamic window sizes, >100% overload).
