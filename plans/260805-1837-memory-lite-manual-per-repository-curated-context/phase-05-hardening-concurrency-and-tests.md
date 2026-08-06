---
title: "Phase 5: Hardening: concurrency, privacy, migration, acceptance"
status: completed
priority: P1
effort: "1d"
dependencies: [3, 4]
---

# Phase 5: Hardening: concurrency, privacy, migration, acceptance

## Overview

Close the implementation with adversarial tests, static conflict checks,
observability review, migration/versioning checks, and a full acceptance gate.
This phase does not add new product scope. It proves that the extension remains
isolated from Pi sessions, hd-agent, the existing extensions, and the separate
three-extension plan.

## Requirements

- [ ] Test concurrent add/remove processes against a temporary storage root;
      assert no malformed final file and no silent lost update.
- [ ] Test lock timeout, fresh-lock preservation, stale-lock recovery, temp
      cleanup, atomic replacement, and read during replacement.
- [ ] Test repository identity collisions across normal repos, worktrees,
      submodules, no-remote repos, symlinks, and similarly named remotes.
- [ ] Test default-off, explicit enablement, disablement, missing storage,
      malformed version, unsupported future version, and rollback behavior.
- [ ] Test prompt budget caps, entry-boundary truncation, marker dedupe, fresh
      reads after external update, context loops, fork/tree/switch/compact
      simulations, and non-repository cwd.
- [ ] Static-check no use of session JSONL/message history, `appendEntry`,
      `SessionManager` reads, `before_agent_start`, `resources_discover`,
      timers, watchers, provider/model APIs, subagents, SQLite/vector libraries,
      or global settings writes.
- [ ] Re-run command/tool/settings/path collision checks against current
      hd-agent and this repo.
- [ ] Confirm no change to the pre-existing auto-skills prompt-discard issue;
      document it as a separate risk only.
- [ ] Confirm no byte changes to
      `plans/260805-1746-adapt-session-breakdown-prompt-editor-autocompact-lite/`.

## Architecture

Observability is bounded and local:

- `/memory status` reports enabled state, repository identity status/hash
  prefix, schema version, entry count, byte count, truncation policy, storage
  path, last successful read/write time, lock-busy status, and last safe error.
- Do not log memory text, rejected secret candidates, auth values, file content,
  or session content.
- Rate-limit repeated read warnings so a malformed file cannot flood the UI.
- Keep no background status timer; status is calculated on command invocation.

Migration policy for v1:

- Create only version 1 documents.
- Read exactly version 1.
- For future/unknown versions: status error, no injection, no mutation.
- For no-remote repositories whose fallback identity changes after a move: do
  not auto-migrate or merge; expose the new identity and require a future
  explicit migration command outside v1.
- Rollback is extension disable/removal; data remains external and user-owned.

## Related Code Files

- Modify: `test/memory-lite-foundation.test.ts` — edge-case expansion.
- Modify: `test/memory-lite-read-path.test.ts` — lifecycle, budget, dedupe,
  fail-open, and context composition expansion.
- Modify: `test/memory-lite-write-path.test.ts` — concurrency, privacy, atomic
  replacement, migration, and rollback expansion.
- Modify: `README.md` only after all gates pass, documenting default-off policy,
  external storage, command UX, limitations, and separate attribution if any
  reference concepts are retained.
- No changes to the existing three-extension plan or unrelated auto-skills
  source/tests.

## Implementation Steps

1. Run the full test suite and all memory-lite tests with temporary injected
   roots; do not use the real `~/.pi/agent/memory-lite/` during tests.
2. Run static searches for forbidden dependencies and event registrations.
   Treat any match as a review failure requiring removal or user decision.
3. Run static namespace checks for `/memory`, settings keys, tools, shortcuts,
   storage directories, and session entry types against the current repo and
   hd-agent source/config.
4. Re-run the Phase 2 context spike locally with no model/API call. Capture
   the exact accepted message contract and ensure no persistent state appears.
5. Run build/load smoke checks that do not invoke a provider or create memory
   data, such as Bun parsing/building the extension and Pi extension discovery
   in a no-model/no-session harness if available.
6. Review all error messages and status output for secret, session, or memory
   text leakage. Confirm user-controlled memory is always labeled untrusted.
7. Verify `git diff --name-only` and `git status --short` show only the six
   authorized memory plan files during this plan-authoring operation; for a
   later implementation, only the intended extension/tests/readme paths may
   change.
8. Run `bun test` and compare with the baseline of 137 pass / 0 fail / 283
   expectations. Any regression blocks completion.
9. Apply the final acceptance checklist and stop if any requirement is not
   evidenced by a test or static check.

## Success Criteria

- [ ] Full suite passes with no baseline regression.
- [ ] All memory-lite tests pass without network, credentials, live model calls,
      persistent processes, real session reads, or real memory storage.
- [ ] Read path is proven before write path and enablement; feature remains
      default-off unless explicitly enabled.
- [ ] Concurrency and atomicity tests show valid final state under contention.
- [ ] Privacy tests show suspicious values are rejected without echo/persistence.
- [ ] Unknown schema versions and identity changes fail safe without mutation.
- [ ] Static checks show no forbidden architecture from reference `memory.ts`.
- [ ] Pi 0.83/hd-agent namespace and lifecycle conflict checks pass.
- [ ] Existing three-extension plan hashes remain identical.
- [ ] No application code is changed by the current plan-authoring operation.

## Risk Assessment

- **SDK evolution:** Context-event behavior is version-sensitive. Pin the
  implementation assumption to Pi 0.83 and retain the local spike tests; if the
  installed SDK changes before implementation, repeat the spike before code.
- **Provider differences:** The plan refuses live API verification in this
  operation. The local provider-conversion/runtime spike is mandatory; if it
  cannot prove compatibility, the feature is blocked rather than enabled.
- **Operational privacy:** External storage survives extension removal. Provide
  status/path visibility and document manual cleanup, but never delete data
  implicitly during rollback.
- **Scope creep:** Any request for automatic learning, session history, global
  memory, or background processing requires a new product decision and a new
  plan; do not expand v1 during implementation.
