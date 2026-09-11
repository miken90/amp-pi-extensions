# Architecture

Source: root `README.md`, `package.json`, and the source tree (`extensions/`,
`scripts/`, `test/`). No build or test suite was run to produce this document
(2026-09-11).

## Purpose

`amp-pi` (package name, intentionally generic) is a pack of enhancements for
the Pi agent harness, installed as a Pi extension pack (`package.json`:
`pi.extensions: ["./extensions"]`).

## Module Boundaries

- `extensions/skill-loader/` — provides the `skill` tool: invokes installed
  skills by name, injects instructions once per session, routes
  `/skill:name` through the tool instead of Pi's native inline expansion.
  Reads from Pi's built-in skill locations
  (`~/.pi/agent/skills/`, `~/.agents/skills/`).
- `extensions/auto-skills/` — curates and pre-loads the few materially
  relevant skills per turn as a convenience layer on top of Pi's own skill
  listing; does not replace the model's own `skill` tool invocation.
  Submodules: `authority.ts`, `config.ts`, `contract.ts`, `discovery.ts`,
  `pipeline.ts`, `prompt.ts`, `router.ts`, `scanner.ts`, `types.ts`.
- `extensions/pinned-model/` — single `index.ts`; pins a model per
  documented behavior.
- `extensions/memory-lite/` — manual, per-repository curated context:
  `read-path.ts` / `write-path.ts`, `storage.ts`, `schema.ts`, `identity.ts`,
  `lock.ts`, `atomic-file.ts`, `budget.ts`, `privacy.ts`, `status.ts`,
  `config.ts`.
- `extensions/ak-hooks-bridge/` — runs AgentKit's Claude Code hooks under Pi
  (`config.ts`, `runner.ts`).
- `scripts/repair-herdr-agent.ts` (bin `amp-pi-repair-herdr`) — idempotent,
  shape-locked patch of the globally installed hd-agent `amp-pi`/`pi`
  launcher so `HERDR_AGENT` is exported; writes a `.herdr-backup` before the
  first patch, `--restore` rolls it back.
- `scripts/update-pi-from-ak.ts` (bin `amp-pi-update-from-ak`) — repairs
  AgentKit-shipped Claude-Code-flavored assets Pi doesn't consume as-is:
  rewrites namespaced `name: ak:<skill>` frontmatter to Pi's hyphenated Agent
  Skills grammar, and converts Claude Code agent definitions
  (tool names, model aliases) for Pi's subagent loader.
- `test/` — one `*.test.ts` per extension/script above, run with `bun test`.

## Documentation & Plans

- `docs/auto-skills.md` — pre-existing auto-skills behavior doc.
- Root `plans/` — dated implementation plans for past work (e.g.
  `plans/260805-1837-.../`), separate from this Harness install's
  `docs/plans/`.

## Ownership

- Consumer-owned: `extensions/`, `scripts/`, `test/`, root `README.md`,
  `docs/auto-skills.md`, root `plans/`, `package.json`, `tsconfig.json`.
- Harness-owned: `AGENTS.md` HARNESS block, `docs/WORKFLOW.md`,
  `docs/templates/`.
