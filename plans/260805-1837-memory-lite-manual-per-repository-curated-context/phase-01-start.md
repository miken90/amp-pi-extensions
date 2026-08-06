---
title: "Phase 1: Foundation: identity, schema, storage contract"
status: completed
priority: P1
effort: "4h"
dependencies: []
---

# Phase 1: Foundation: identity, schema, storage contract

## Overview

Define and unit-test the pure repository identity, versioned document schema,
storage path, and default-off configuration boundary before registering any
runtime event or write command. This phase creates no user memory data and must
not read session contents.

## Requirements

- [ ] Resolve canonical repository identity for normal repositories, remote-less
      repositories, Git worktrees, submodules, and symlinked cwd paths.
- [ ] Use remote-derived identity when available and a real Git metadata path
      fallback when no remote exists; reject non-repository cwd.
- [ ] Use a domain-separated SHA-256 storage key; never use a human label alone
      as a directory name.
- [ ] Define schema version 1 with repository key, label, timestamps, entry ids,
      tags, and text; reject malformed and unsupported future versions without
      mutation.
- [ ] Define default-off state isolated from Pi settings, session JSONL,
      `pinnedModel`, `autoSkills`, `akHooksBridge`, and hd-agent state.
- [ ] Define storage under the resolved agent directory at `memory-lite/`,
      outside the worktree and separate from the rejected reference path
      `memories/`.

## Architecture

Suggested pure modules:

- `extensions/memory-lite/identity.ts` — Git boundary discovery, remote
  normalization, worktree/submodule/symlink handling, key derivation.
- `extensions/memory-lite/schema.ts` — version 1 parse/validate/serialize,
  entry validation, bounded text checks.
- `extensions/memory-lite/storage.ts` — path derivation only in this phase;
  actual atomic mutation is Phase 4.
- `extensions/memory-lite/config.ts` — isolated enablement state and defaults.
- `extensions/memory-lite/index.ts` — not wired until Phase 2/3 gates pass.

No module may import session managers or inspect session files. Keep all
filesystem roots injectable for tests.

## Related Code Files

- Create later: `extensions/memory-lite/identity.ts`
- Create later: `extensions/memory-lite/schema.ts`
- Create later: `extensions/memory-lite/storage.ts`
- Create later: `extensions/memory-lite/config.ts`
- Create later: `extensions/memory-lite/index.ts`
- Create later: `test/memory-lite-foundation.test.ts`
- Modify later: `README.md` only after the extension is implemented and accepted;
  this phase must not modify it during the foundation spike.

## Implementation Steps

1. Re-verify Pi 0.83's `getAgentDir()` export and the current repository's
   package/extension discovery pattern before selecting the storage root.
2. Implement identity resolution against synthetic temporary Git metadata
   fixtures, not the user's real repository content. Test normal remote URLs,
   SSH-style URLs, no remote, worktree `.git` files, submodule boundaries,
   symlinked cwd, and non-repository cwd.
3. Normalize remote identity without credentials or query/fragment data; hash
   the normalized identity with a fixed domain separator such as
   `amp-pi-memory-lite:v1:`.
4. Implement schema validation and serialization. Preserve unknown fields only
   if the version parser explicitly allows them; otherwise reject malformed
   input without rewrite.
5. Define isolated enablement storage. Recommended v1: one small settings
   record alongside the repository memory document, with `enabled: false` as
   the absent/default state. Do not add a Pi global settings key in this phase.
6. Add tests proving two distinct repository identities cannot map to the same
   full storage key in the tested fixture set, and that labels never determine
   the key.

## Success Criteria

- [ ] Pure identity tests cover normal repo, worktree, submodule, no-remote,
      symlink, and non-repo cases.
- [ ] Schema tests cover valid v1, malformed data, unsupported future version,
      empty entries, oversize entry, invalid id, and invalid tag cases.
- [ ] Default-off behavior is represented by an absent/false isolated state;
      no Pi settings/session file is read or written.
- [ ] No runtime event is registered and no memory data is created by this phase.
- [ ] `bun test` remains green against the repository baseline.

## Risk Assessment

- **Worktree policy risk:** Sharing memory across worktrees is a product choice.
  V1 recommends common canonical-repository memory, but implementation must
  expose the resolved identity in `/memory status` and stop if the Git metadata
  cannot prove the relationship.
- **No-remote path risk:** Moving a local repository changes the fallback key.
  Do not silently merge old keys; document this in status and leave migration
  for a future explicit command.
- **Schema risk:** Never downgrade an unsupported version or overwrite it with
  defaults. The safe response is read-only incompatibility plus a status error.
- **Rollback:** remove only the not-yet-enabled extension files from the later
  implementation; no data exists from this phase.
