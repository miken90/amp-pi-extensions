---
title: "Phase 4: Write path: manual commands and atomic persistence"
status: completed
priority: P1
effort: "1d"
dependencies: [1, 2, 3]
---

# Phase 4: Write path: manual commands and atomic persistence

## Overview

Add explicit user-controlled commands for selective memory curation only after
the read path is proven safe. Writes are confined to the current repository's
external namespace and use read-under-lock, validate, temporary-file write, and
atomic replacement. No lifecycle event writes or automatic mutation are added.

## Requirements

- [ ] Implement `/memory add`, `/memory remove`, `/memory enable`, and
      `/memory disable`; preserve `/memory status`, `/memory show`, and
      `/memory list` behavior.
- [ ] Require a canonical repository identity for every mutating command.
- [ ] Reject empty, oversized, malformed, or obviously secret-bearing text;
      warn that users remain responsible for reviewing stored context.
- [ ] Add and remove by stable exact entry id; never use fuzzy text deletion.
- [ ] Enabling is explicit and repository-scoped; disabling stops future reads
      without deleting memory content.
- [ ] Use an adjacent advisory lock with exclusive creation, bounded retry,
      stale-lock policy, and owner metadata.
- [ ] Read and validate the current document under lock, apply one operation,
      serialize version 1, write a same-directory temp file, close it, and
      atomically rename it over the target.
- [ ] Preserve the last valid target on all validation, permission, disk, lock,
      or rename failures.
- [ ] Never modify Pi settings, session JSONL, worktree files, AGENTS/Harness
      files, package loading, or another repository's namespace.

## Architecture

Suggested modules:

- `write-path.ts` — command argument validation and CRUD orchestration.
- `lock.ts` — exclusive lock creation, bounded retry, stale-lock handling.
- `atomic-file.ts` — same-directory temporary write, close, rename, cleanup.
- `privacy.ts` — conservative suspicious-secret checks and safe error text.

The command handler must be user-driven only. It must not be called from
`session_start`, `context`, `before_agent_start`, `message_end`, compaction,
shutdown, timers, or file watchers.

## Related Code Files

- Create: `extensions/memory-lite/write-path.ts`
- Create: `extensions/memory-lite/lock.ts`
- Create: `extensions/memory-lite/atomic-file.ts`
- Create: `extensions/memory-lite/privacy.ts`
- Modify: `extensions/memory-lite/index.ts`
- Create: `test/memory-lite-write-path.test.ts`

## Implementation Steps

1. Re-read the current validated schema and identity modules from Phase 1 and
   assert the target path is outside the worktree before every mutation.
2. Implement strict subcommand parsing. In interactive mode, use Pi's UI input
   only for omitted add text; in print/non-interactive mode, reject missing
   arguments rather than waiting.
3. Implement conservative privacy checks for common API-key, bearer-token,
   private-key, password, and auth-file patterns. Reject suspicious input with
   a safe explanation; never echo the candidate text in errors.
4. Implement lock creation with `open(..., "wx")` semantics, owner pid/time,
   bounded retry, and stale-lock handling. A fresh lock from another process
   must never be removed solely due to contention.
5. Implement atomic replacement using a same-directory temp file with
   restrictive creation mode where supported, complete serialization, close,
   optional sync if available without introducing a dependency, and rename.
6. Add operations for add/list/show/remove. Each operation reads under lock
   for mutation, revalidates schema and repository key, applies a single
   deterministic change, and releases the lock in `finally`.
7. Add enable/disable state in the same repository namespace or an explicitly
   separate versioned sidecar. Keep absent state equivalent to disabled and do
   not write a default state merely by loading the extension.
8. Test failures at each boundary: lock contention, stale lock, malformed
   existing file, permission error, temp write error, rename error, interrupted
   operation, duplicate id, wrong repository key, and suspicious secret input.
9. Verify commands never invoke `ctx.newSession`, `appendEntry`, provider APIs,
   or any session/history reader.

## Success Criteria

- [ ] All writes require explicit commands and a valid current repository.
- [ ] Atomic replacement and lock behavior prevent partial/corrupt documents
      and define safe multi-process last-writer behavior.
- [ ] Add/remove/enable/disable are idempotent where applicable and preserve
      unrelated entries.
- [ ] No secret candidate is echoed or persisted by rejected paths.
- [ ] Errors are observable through safe notifications/status and do not crash
      the Pi process.
- [ ] Read path remains default-off until `/memory enable` is explicitly run.
- [ ] `bun test` remains green.

## Risk Assessment

- **Concurrent writer risk:** Two commands may contend. The second must retry
  within a bounded window, then report busy without overwriting. Read-under-lock
  prevents silent lost updates from stale snapshots.
- **Crash risk:** A temp file or lock may remain after termination. Temp files
  are ignored by readers; stale locks are recoverable only under conservative
  age/ownership rules and are never treated as memory entries.
- **Privacy risk:** Pattern checks are not complete DLP. The UX must state that
  manual curation remains the user's responsibility; v1 must not claim secrets
  are guaranteed removed.
- **Rollback:** `/memory disable` is the first rollback. Removing the extension
  leaves the external namespace untouched for user inspection; never delete it
  automatically.
