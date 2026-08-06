---
title: "Phase 2: Runtime spike: context-event injection"
status: completed
priority: P1
effort: "4h"
dependencies: [1]
---

# Phase 2: Runtime spike: context-event injection

## Overview

Prove, using only local static/runtime harnesses and no live model/API call,
that Pi 0.83's `context` event can add one provider-compatible, ephemeral,
deduplicated message without changing session files, transcript entries,
compaction state, tool registration, or hd-agent behavior. This is a hard gate:
if it cannot be proven, stop and do not implement the read or write paths.

## Requirements

- [ ] Register a temporary test-only context handler in an injected harness,
      not in the production extension tree, or use an existing local runner
      harness without modifying application code.
- [ ] Confirm the handler receives `ContextEvent.messages` and returns a new
      `messages` array; do not mutate the input array in place.
- [ ] Confirm `UserMessage` shape (`role: "user"`, string/content-array,
      timestamp) is accepted by the Pi 0.83 type/runtime surface.
- [ ] Confirm sequential context handlers preserve prior messages and that a
      later handler receives the previous handler's returned array.
- [ ] Confirm repeated context events with the same marker do not duplicate the
      memory message.
- [ ] Confirm a missing, disabled, malformed, or over-budget memory source
      returns no added message and does not throw.
- [ ] Confirm no session manager, appendEntry, session JSONL, compaction event,
      `before_agent_start`, provider call, or subagent is involved.

## Architecture

The spike must model the production contract only:

```text
input messages
  -> context handler reads bounded fixture
  -> detects MEMORY-LITE marker
  -> returns cloned input + at most one synthetic user message
  -> second context emission remains one message
```

The message marker must be deterministic and include repository key, schema
version, and content hash. The spike must test both string content and the
chosen provider-compatible form; select the simpler form that passes local
runtime/type checks. Do not use a custom system message or custom transcript
entry.

## Related Code Files

- Create temporarily during implementation only: no committed spike helper is
  required unless the repository's test harness needs a permanent pure test
  fixture. If a helper is required, it must be inside the later
  `test/memory-lite-*.test.ts` surface and be documented as non-production.
- Inspect: `extensions/auto-skills/index.ts:62-123` for the existing prompt hook,
  but do not modify it.
- Inspect: installed SDK
  `@earendil-works/pi-coding-agent/dist/core/extensions/runner.js:744-771`
  and `dist/core/extensions/types.d.ts:499-502,774-776`.

## Implementation Steps

1. Build an isolated fake `ExtensionAPI`/runner harness following this repo's
   existing dependency-injection test style; no Pi startup and no live model.
2. Feed a synthetic message list containing user, assistant, and tool-result
   shaped entries. Assert the returned list keeps all original messages in the
   same order and appends exactly one memory message.
3. Emit the context hook twice with the same content and assert marker-based
   dedupe. Change the content hash and assert replacement/one-message behavior
   is deterministic rather than unbounded accumulation.
4. Test a handler registered before and after the memory handler to establish
   composition behavior. The memory handler must preserve messages from both
   sides and never discard another extension's result.
5. Test a synthetic context loop representing multiple tool calls. Assert the
   message list remains bounded and no input object is mutated.
6. Test oversized content and malformed fixture results. Assert fail-open
   behavior and a non-sensitive status signal only.
7. Static-check that the production design does not register
   `before_agent_start`, `session_*`, `message_end`, `context` mutation outside
   the narrow handler, or any model/provider API.
8. Stop immediately if local runtime evidence shows that the synthetic user
   message is persisted to the session transcript, changes compaction behavior,
   is rejected by the provider-facing conversion path, or cannot be deduped.

## Success Criteria

- [ ] Local harness proves the exact `context` result contract and bounded
      dedupe without a live model call.
- [ ] No persistent file, session entry, or configuration mutation occurs.
- [ ] Context handler composes with earlier/later handlers and never replaces
      unrelated messages.
- [ ] Provider-facing message shape is verified by local SDK/type/runtime
      conversion only; no network/API call is permitted.
- [ ] A clear PASS or STOP report is recorded in implementation work before
      Phase 3 begins.

## Risk Assessment

- **Event semantics risk:** Type declarations say context fires before each LLM
  call, but the spike must verify the installed runtime's actual message flow.
- **Provider compatibility risk:** A user-role message is the conservative
  candidate, but provider adapters may impose ordering constraints. If local
  conversion cannot establish safety, stop rather than guessing.
- **Compaction risk:** The synthetic message must be ephemeral to the request
  context. If it enters session persistence or is summarized into compaction,
  reject this design and return to the user.
- **Rollback:** the spike has no production state; delete only temporary test
  artifacts created during the later implementation dispatch.
