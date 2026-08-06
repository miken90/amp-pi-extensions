# amp-pi

A general, extensible pack of enhancements for the [Pi agent harness](https://pi.dev/).
The package name is intentionally generic so it can host unrelated Pi enhancements
over time. It includes **auto-skills**, a durable **skill-loader** tool,
**pinned-model**, and post-update workflows: **herdr-repair** and
**update-pi-from-ak** (skill name repair + Claude Code agent conversion).

> auto-skills is a **convenience layer that supplements — never replaces — the
> model's own skill selection**. Pi already lists every skill's name+description
> in the system prompt (progressive disclosure); auto-skills just curates the
> few materially relevant ones per turn and pre-loads their bodies. The model
> can still invoke any other skill through the `skill` tool.

## Features

### skill-loader

Provides the `skill` tool used to invoke installed skills by name, inject their
instructions once per session, and route `/skill:name` through the tool instead
of Pi's native inline expansion. Skill discovery is left to Pi's built-in
locations (`~/.pi/agent/skills/` and `~/.agents/skills/`); the extension no
longer surfaces `~/.claude/skills/`, whose colon-named entries triggered Pi
`invalid-name` diagnostics. Keeping this tool in this repository prevents
package updates from overwriting local skill-loading fixes.

### herdr-repair

A safe, idempotent post-update repair for the globally installed hd-agent
`amp-pi`/`pi` launcher. Herdr (v0.7.5+) recognizes a foreground process as a
promptable agent when the process-group leader exports `HERDR_AGENT`. The
hd-agent wrapper spawns the real Pi CLI via `Bun.spawn` and forwards
`...process.env` plus `AMP_PI_CLI`, but not `HERDR_AGENT`, so wrapper-launched
Pi sessions are invisible to Herdr unless the user manually prefixes
`HERDR_AGENT=pi`. This workflow injects `HERDR_AGENT: "pi"` into the wrapper's
env object so every fresh `amp-pi`/`pi` session is Herdr-promptable.

Safety properties (all covered by `test/repair-herdr-agent.test.ts`):

- **Idempotent** — a second run detects the fix is already present and no-ops.
- **Shape-locked** — only patches the exact hd-agent 0.9.x env line
  `{ ...process.env, AMP_PI_CLI: piCli }`; refuses anything else with a non-zero
  exit and the offending line printed.
- **Upstream-aware** — no-ops once hd-agent ships equivalent `HERDR_AGENT`
  recognition upstream.
- **Reversible** — writes a `pim.ts.herdr-backup` of the original content before
  the first patch; `--restore` rolls it back.

### skill-name-repair

A safe, idempotent post-update repair for skill frontmatter `name:` values that
Pi rejects. AgentKit (`ak update`) rewrites every `~/.claude/skills/<dir>/SKILL.md`
with a namespaced `name: ak:<skill>`, but the Agent Skills grammar Pi enforces is
`[a-z0-9]([a-z0-9-]*[a-z0-9])?` — the colon is invalid, so those skills load with
`invalid-name` diagnostics and their `/skill:<name>` commands break. This workflow
rewrites the names to their hyphenated form (`ak:debug` -> `ak-debug`), which
already matches the directory names AgentKit creates.

Safety properties (all covered by `test/update-pi-from-ak.test.ts`):

- **Scoped** — only the `name:` key inside the leading `---` frontmatter block is
  touched; `name:`-looking lines in the body are left alone.
- **Idempotent** — already-valid names are classified `valid` and skipped.
- **Collision-aware** — reports when a repaired name is declared by several
  roots (Pi warns and keeps the first), without blocking the repair.
- **Reversible** — writes `SKILL.md.skill-name-backup` before the first patch;
  `--restore` rolls it back. A failed post-patch verification auto-rolls back.
- **One-shot** — `--update` runs `ak update --global --yes` first (global/user
  kits only; project-level refreshes are never triggered) and repairs right
  after, so the names never stay broken between the two steps.

### pinned-model

Forces every new session (`/new`) onto a pinned model, ignoring whatever model
the current session happens to be running.

Pi rewrites `defaultProvider`/`defaultModel` in `settings.json` on every model
switch (`/model`, model cycling, `setModel`), so those fields behave as "last
used model" and cannot act as a stable default. `/new` also reuses the running
process's model. This extension keeps a separate `pinnedModel` block that Pi
never overwrites and reapplies it on `session_start` with reason `"new"`.

```jsonc
// ~/.pi/agent/settings.json (global) or .pi/settings.json (per repo, wins)
{
  "pinnedModel": { "provider": "tuongnguyen-proxy", "model": "glm-5.2" }
}
```

No pin configured means no behavior change. Unavailable model or missing API key
is reported as a notice and the current model is kept.

### auto-skills

Automatically selects and loads materially relevant installed skills from the
user's request, instead of always relying on the model to sift the full catalog.

- **Contract-aware routing**: detects mik-target-v1 / structured assignments and
  scores only the `objective` + `context`. Generic control boilerplate,
  `forbidden_scope`, `verification`, `result`, and `post_work_synchronization`
  are never fed to the scorer.
- **Authority gating**: never auto-selects high-impact capabilities (deploy,
  commit/push, Harness install/repair, external actions, active red-team) unless
  the objective *affirmatively* authorizes them. Negated phrases like
  "do not deploy" never count as authorization. Matches the Mik chief-of-staff
  authority boundaries.
- **Authorized vs forbidden distinction**: a deploy objective selects the deploy
  skill; an existing-Harness *documentation-sync* objective allows the docs-sync
  skill while still blocking Harness install/repair.
- **Relevant-only & conservative**: ordinary requests may select zero skills;
  default cap is 2 (Mik's "smallest useful set").
- **Proactive loading**: pre-loads the full `SKILL.md` body of selected skills
  (capped) into the turn so the model doesn't need an extra `read` round-trip.
- **Live metadata refresh**: mtime-aware scan every turn — added, modified, or
  removed `SKILL.md` files are picked up without a restart.
- **Explicit invocation wins**: `/skill:name` and `/ak:name` always bypass
  auto-routing; the explicit skill invocation owns the turn.
- **Stable per-turn snapshot**: the catalog is refreshed once before each turn
  and held constant for that turn.
- **Observability & controls**: footer status, persisted state, and
  `/askills status|reload|enable|disable|test <query>`.

### ak-hooks-bridge

Pi has no `hooks.json`/`PreToolUse`-style hook system — it has typed extension
events (`pi.on(...)`). AgentKit ships ~20 Claude Code hook scripts
(`~/.claude/hooks/*.cjs`, registered in `~/.claude/settings.json`'s `hooks`
block) that its skills/agents assume run alongside them: privacy/scout
directory blocking, plan-format nudges, session-state tracking, usage-quota
caching, etc. Rather than reimplementing each script in TypeScript, this
extension is a generic bridge: it reads the same hook registry AgentKit
already wrote for Claude Code and, for every Pi event with a faithful Claude
Code equivalent, spawns the matching `.cjs` hook with a Claude Code-shaped JSON
payload on stdin and applies its verdict (block / allow / inject context).

| Claude Code hook | Pi event | Behavior |
|---|---|---|
| `PreToolUse` | `tool_call` | Blocking — `permissionDecision: "deny"` or exit 2 blocks the tool call. |
| `PostToolUse` | `tool_result` | Non-blocking — `additionalContext` is appended to the tool result. |
| `UserPromptSubmit` | `before_agent_start` | A block is surfaced as injected context (Pi can't hard-block a submitted prompt); `additionalContext` is injected as a hidden message. |
| `SessionStart` | `session_start` | Non-blocking — `additionalContext` shows as a notice. |
| `PreCompact` | `session_before_compact` | Blocking — a deny cancels the compaction. |
| `Stop` | `agent_settled` | Fire-and-forget (reminders/telemetry only). |

**Gap:** `SubagentStart`/`SubagentStop` have no Pi equivalent (Pi's subagent
tool, from `hd-agent`, doesn't emit lifecycle events), so those AgentKit hooks
(`subagent-init.cjs`, `team-context-inject.cjs`) never run under Pi.

Disabled by default. Enable in `~/.pi/agent/settings.json` (global) or
`.pi/settings.json` (project; overrides global):

```json
{
  "akHooksBridge": {
    "enabled": true,
    "hooksSettingsPath": "~/.claude/settings.json",
    "disabledHooks": ["session-init.cjs", "scout-block.cjs"]
  }
}
```

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Master switch. |
| `hooksSettingsPath` | `~/.claude/settings.json` | Where the `hooks` registry is read from. |
| `disabledHooks` | `[]` | Script basenames (e.g. `"privacy-block.cjs"`) to never run. |

Each hook script keeps its own internal `isHookEnabled(...)` gate (from
AgentKit's `ck-config-utils.cjs`), so most can also be toggled through
AgentKit's own config without touching `disabledHooks` here. Every hook call
has a 5s timeout and fails open (allows) on timeout, crash, or unparsable
output — a broken or slow AgentKit hook can never hang or block a Pi session.

### session-breakdown

Interactive TUI that analyzes `~/.pi/agent/sessions/**/*.jsonl` and shows the
last 7/30/90 days of session usage: sessions/day, messages/day, tokens/day,
cost/day, with model/cwd/day-of-week/time-of-day breakdown views.

- **Read-only**: zero filesystem writes — only `readdir`/`stat`/stream-read.
- **GitHub-contributions-style calendar heatmap** with model-weighted colors.
- **View toggles**: model / cwd / day-of-week / time-of-day.
- **Metric toggles**: sessions / messages / tokens.
- **Range switching**: 7/30/90-day windows via in-TUI keybindings.

Adapted from `darkamenosa/pi-setup` (Apache-2.0). See the Third-party
attribution section below.

### prompt-editor

Interactive mode/model/thinking-level editor with named "modes" — each a
(provider, modelId, thinkingLevel, editor-border color) tuple — stored in
`modes.json` (global: `~/.pi/agent/modes.json`; project: `.pi/modes.json`,
project overriding global).

- `/mode` command: select, create, rename, delete, and switch modes.
- `ctrl+shift+m` shortcut: open the mode selector.
- `ctrl+space` shortcut: cycle to the next mode.
- **No interference with `pinned-model`**: never writes to `pinnedModel`,
  `defaultProvider`, or `defaultModel` settings keys.
- Cross-process file-locking with stale-lock recovery for `modes.json`.
- Prompt history from previous sessions in the same cwd.

Adapted from `darkamenosa/pi-setup` (Apache-2.0). See the Third-party
attribution section below.

### autocompact-lite

A minimal, Pi-0.83-native proactive context-overflow recovery extension.
Detects approaching context overflow between turns using a configurable
percentage-plus-reserve threshold and triggers Pi's built-in `compact()`
before the next model request.

- **Dual threshold**: compaction fires when context tokens exceed
  `min(contextWindow * thresholdPercent / 100, contextWindow - reserveTokens)`.
  The percentage threshold gives consistent behavior across model window sizes;
  the reserve safety net ensures room for the model's response.
- **Dynamic contextWindow**: reads the active model's `contextWindow` through
  `ctx.getContextUsage()` — no hardcoded model names or window sizes.
- **Cooldown**: after a proactive compaction, subsequent triggers are suppressed
  for `cooldownTurns` turns unless token usage is observed to drop below the
  threshold (re-arming). This prevents repeated compaction of a conversation
  that stays near the boundary.
- **No double-triggering**: in-memory per-turn guard prevents redundant
  compaction within the same turn.
- **Fail-open**: compaction failure is reported via `ctx.ui.notify` and never
  crashes the turn.
- **Unclamped percentage**: raw context percentage may exceed 100% (real
  overload) and is never masked — only the trigger calculation uses it.
- **No Codex/Grok/OAuth, no subagent capability channel, no goal-extension
  coupling** — deliberately minimal.

#### Settings

Configured through the `autoCompactLite` block in `settings.json` (global
`~/.pi/agent/settings.json` or project `.pi/settings.json`, project overriding
global). Invalid values silently fall back to defaults.

```json
{
  "autoCompactLite": {
    "enabled": true,
    "thresholdPercent": 85,
    "reserveTokens": 32768,
    "cooldownTurns": 2
  }
}
```

| Field | Default | Range | Meaning |
|---|---|---|---|
| `enabled` | `true` | boolean | Master switch. |
| `thresholdPercent` | `85` | 1–100 | Compact when usage exceeds this % of `contextWindow`. |
| `reserveTokens` | `32768` | 1024–1000000 | Safety reserve: also compact when `tokens > contextWindow - reserveTokens`. |
| `cooldownTurns` | `2` | 0–100 | Minimum turns between proactive triggers (unless re-armed by observed reduction). |

After changing settings, run `/reload` in the Pi session to pick up the new
configuration.

Inspired by `darkamenosa/pi-setup`'s autocompact.ts (Apache-2.0); no source
lines copied — reimplemented against Pi 0.83's public compaction API.

### memory-lite

A default-off, manual-only, per-repository Markdown memory extension with
bounded Pi context-event injection and no session mining or autonomous work.

- **Default off**: zero injection until `/memory enable` is explicitly run.
- **Per-repository**: storage under `~/.pi/agent/memory-lite/<sha256>/`,
  outside the worktree, keyed by a domain-separated SHA-256 of the normalized
  Git remote URL.
- **Read-only injection**: appends at most one bounded, deduplicated,
  low-authority user message per context event — never a system message.
- **Manual commands**: `/memory status|show|list|add|remove|enable|disable`.
- **Atomic writes**: advisory lock, temp-file + rename, read-under-lock.
- **Privacy checks**: rejects obvious API-key/token/private-key patterns.
- **No session scanning, embedded databases, model calls, delegated agents,
  timers, or background workers.**

## Install

This project is a Pi package (see `package.json` → `pi.extensions`). The
`pi-package` keyword makes it discoverable; the `pi.extensions:
["./extensions"]` manifest auto-discovers both extension entry points.

### Recommended: install from Git

```bash
pi install git:github.com/miken90/amp-pi-extensions
```

Then update it at any time with:

```bash
pi update --extensions
```

If `hd-agent` is also installed, disable its bundled skill-loader to avoid two
extensions registering the same `skill` tool. Use the object form in
`~/.pi/agent/settings.json`:

```json
{
  "packages": [
    "git:github.com/miken90/amp-pi-extensions",
    {
      "source": "git:github.com/tuong-nguyen-vn/hd-agent",
      "extensions": ["-./src/extensions/skill-loader/index.ts"]
    }
  ]
}
```

The exclusion survives `pi update --extensions`: HD Agent continues updating,
but this package remains the owner of the `skill` tool.

### Development: install from a local checkout

Install the package by absolute local path (no copy; Pi records the path in settings):

```bash
# Global (all projects) — writes to ~/.pi/agent/settings.json
pi install /absolute/path/to/pi-extensions

# Project-local — writes to <repo>/.pi/settings.json
pi install -l /absolute/path/to/pi-extensions
```

Load temporarily without installing (current process only). Do not load the
whole package alongside an enabled HD Agent skill-loader unless that extension
is excluded as shown above:

```bash
pi -e ./extensions/auto-skills          # a single extension dir
pi -e /absolute/path/to/pi-extensions   # the whole package
```

### Verify

```bash
pi list
pi --mode json -p 'Use the ak-debug skill, then reply with exactly LOADED' --no-session
```

The JSON event stream should contain a `skill` tool call with
`{"name":"ak-debug"}` followed by a successful tool result. For auto-routing,
start `pi` and check the footer for an `auto-skills: …` status line, or run
`/askills status` inside a session.

Update / uninstall:

```bash
pi update --extensions                  # update Git packages; local paths are unchanged
pi remove /absolute/path/to/pi-extensions   # remove from settings (global)
pi remove -l /absolute/path/to/pi-extensions   # remove (project-local)
pi remove git:github.com/miken90/amp-pi-extensions
```

Restart/reload requirements: Pi loads packages at session start. After
`pi install`/`pi remove`, start a new session (`pi`) or run `/reload` in an open
session to pick up the change. After editing extension files in place, `/reload`
hot-reloads them (extensions under `~/.pi/agent/extensions/` or installed package
paths are reloadable).

## Configure

Add an `autoSkills` object to `~/.pi/agent/settings.json` (global) or
`.pi/settings.json` (project; overrides global):

```json
{
  "autoSkills": {
    "enabled": true,
    "maxSelected": 2,
    "threshold": 1.0,
    "preload": true,
    "maxBodyBytes": 8192,
    "maxTotalBytes": 28672,
    "enforceAuthority": true,
    "locations": ["~/extra-skills"]
  }
}
```

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch (also toggle via `/askills enable/disable`). |
| `maxSelected` | `2` | Max skills surfaced per turn (Mik's "smallest useful set"). |
| `threshold` | `1.0` | Min relevance score to surface a skill. |
| `preload` | `true` | Inject selected skills' full `SKILL.md` bodies (capped). |
| `maxBodyBytes` | `8192` | Per-skill body cap when preloading. |
| `maxTotalBytes` | `28672` | Total preloaded bytes per turn. |
| `enforceAuthority` | `true` | Block high-impact skills unless the objective authorizes them. |
| `locations` | `[]` | Extra skill directories to scan. |

Enable/disable also persists via `/askills enable|disable` (stored in
`~/.pi/agent/auto-skills.json`).

## Commands

| Command | Effect |
|---|---|
| `/askills` · `/askills status` | Show skill count, last selection count, and last reason. |
| `/askills reload` | Clear and rebuild the skill index now. |
| `/askills enable` · `/askills disable` | Toggle auto-routing (persisted). |
| `/askills test <query or full contract>` | Dry-run the router (same parse + authority pipeline as a real turn) and report matches + scores. |

## Herdr launcher repair

After `pi update --extensions` or reinstalling/upgrading `hd-agent`, the global
`amp-pi`/`pi` wrapper (`~/.bun/install/global/node_modules/hd-agent/bin/pim.ts`)
is overwritten and loses the `HERDR_AGENT` env injection that makes wrapper-
launched Pi sessions Herdr-promptable. Re-run the repair from any cwd:

```bash
# Locate the package (git install or local checkout) and run the repair:
bun run ~/.pi/agent/git/github.com/miken90/amp-pi-extensions/scripts/repair-herdr-agent.ts

# Or, from a local checkout:
bun run /absolute/path/to/pi-extensions/scripts/repair-herdr-agent.ts

bun run …/repair-herdr-agent.ts --check     # dry-run: report shape, write nothing
bun run …/repair-herdr-agent.ts --restore   # roll back from pim.ts.herdr-backup
bun run …/repair-herdr-agent.ts --launcher /explicit/pim.ts   # override target
```

The script verifies the file looks like the hd-agent launcher (contains both
`AMP_PI_CLI` and `Bun.spawn`), only patches the exact known env shape, writes a
reversible `pim.ts.herdr-backup`, and exits non-zero with the offending line if
the upstream shape has changed and needs manual review. It is safe to re-run
after every update; it no-ops when the launcher already exports `HERDR_AGENT`
(either from a prior repair or a future upstream fix).

## Update Pi from AgentKit

AgentKit (`ak update`) ships two kinds of Claude-Code-flavored assets that Pi
doesn't consume as-is:

1. **Skills** — `~/.claude/skills/<dir>/SKILL.md` gets a namespaced
   `name: ak:<skill>`, but Pi's Agent Skills grammar
   (`[a-z0-9]([a-z0-9-]*[a-z0-9])?`) rejects the colon, so the skill loads with
   an `invalid-name` diagnostic and its `/skill:<name>` command breaks.
2. **Agents** — `~/.claude/agents/*.md` uses Capitalized Claude Code tool names
   (`Glob, Grep, Bash, …`) and Claude model aliases (`opus`, `sonnet`, `haiku`,
   `fable`, `inherit`), which Pi's subagent loader (`~/.pi/agent/agents/*.md`)
   doesn't understand.

`scripts/update-pi-from-ak.ts` repairs both, independently and idempotently.
Re-run it from any cwd after every `ak update`:

```bash
bun run ~/.pi/agent/git/github.com/miken90/amp-pi-extensions/scripts/update-pi-from-ak.ts

bun run …/update-pi-from-ak.ts --check          # dry-run both steps, write nothing
bun run …/update-pi-from-ak.ts --restore        # roll back both steps from their backups
bun run …/update-pi-from-ak.ts --skip-skills    # agent conversion only
bun run …/update-pi-from-ak.ts --skip-agents    # skill name repair only
```

### Skill name repair

```bash
bun run …/update-pi-from-ak.ts --root ~/.claude/skills   # override scanned roots (repeatable)
```

Default roots are `~/.claude/skills`, `~/.codex/skills`, `~/.agents/skills`, and
`~/.pi/agent/skills`. Rewrites offending names to the hyphenated form
(`ak:debug` -> `ak-debug`), matching the on-disk directory names AgentKit
already creates. Only the `name:` key inside the leading frontmatter block is
touched; `name:`-looking lines in the body are left alone. Backs up each
changed file as `SKILL.md.skill-name-backup` before writing; a failed
post-patch verification auto-rolls back. Restart Pi afterwards to reload the
skill list.

### Agent conversion

```bash
bun run …/update-pi-from-ak.ts --agents-root ~/.claude/agents   # override the source dir
bun run …/update-pi-from-ak.ts --agents-out ~/.pi/agent/agents  # override the target dir
```

Converts each `~/.claude/agents/*.md` into a Pi agent definition at
`~/.pi/agent/agents/*.md`, keeping `name`/`description`/the markdown body
verbatim, and:

- **Tools**: maps known Claude Code tools to Pi tool ids (`Glob`→`glob`,
  `Grep`→`grep`, `Read`→`read`, `Write`→`write`, `Edit`/`MultiEdit`→`edit`,
  `Bash`→`bash`, `WebFetch`→`web_fetch`, `WebSearch`→`web_search`,
  `Task(name)`→`subagent`). Tools with no Pi equivalent (`TaskCreate`,
  `TaskGet`, `TaskUpdate`, `TaskList`, `SendMessage`, `BashOutput`, `KillBash`,
  `ListMcpResourcesTool`, `ReadMcpResourceTool`, `LS`) are dropped and reported.
- **Model**: maps known Claude aliases (`opus`, `sonnet`, `haiku`, `fable`) to
  Pi model ids; drops `inherit` (Pi has no equivalent, so the caller's model
  applies); unknown aliases pass through unmapped with a warning so you can
  fix them by hand.
- **Drops** Claude-only frontmatter Pi doesn't read (`memory:`).

Only writes when the converted content actually changed (idempotent); backs up
the previous converted file as `*.ak-agent-backup` before overwriting.

### Update and convert in one command

`--update` runs `ak update --global --yes` (global/user kits only — project
refreshes are deliberately skipped) first, then both repair steps:

```bash
bun run …/update-pi-from-ak.ts --update

# Override the `ak update` args after a bare `--`:
bun run …/update-pi-from-ak.ts --update -- --global --target codex --yes
```

`ak`'s stdio is inherited, so an interactive wizard still works. Exit code 3
(preview-only) is treated as success; any other non-zero exit aborts before the
repair and is propagated. Handy shell alias:

```bash
alias akup='bun run ~/.pi/agent/git/github.com/miken90/amp-pi-extensions/scripts/update-pi-from-ak.ts --update'
```

## Develop

```bash
bun test                       # unit + integration + load-smoke tests
bun build extensions/auto-skills/index.ts --no-bundle --outfile /tmp/auto-skills.js
bun build extensions/skill-loader/index.ts --no-bundle --outfile /tmp/skill-loader.js
bun build scripts/repair-herdr-agent.ts --no-bundle --outfile /tmp/repair-herdr-agent.js
bun build scripts/update-pi-from-ak.ts --no-bundle --outfile /tmp/update-pi-from-ak.js
```

Tests inject a fake parser + temp agent dir, so they never touch the real Pi
config or require network. The herdr-repair tests use temp launchers and never
mutate the real global launcher.

## Layout

```
extensions/
├── skill-loader/
│   └── index.ts  # skill tool, /skill routing
├── pinned-model/
│   └── index.ts  # reset /new sessions to the pinned model
├── ak-hooks-bridge/
│   ├── index.ts   # Pi event wiring: tool_call, tool_result, before_agent_start, …
│   ├── config.ts  # hooks.json/settings.json hook-registry parsing + matcher logic
│   └── runner.ts  # spawns each .cjs hook, interprets its allow/block/context verdict
├── auto-skills/
│   ├── index.ts      # Pi extension entry: events, commands, status
│   ├── pipeline.ts   # pure end-to-end route: parse -> score -> authority
│   ├── contract.ts   # parse mik-target-v1 prompts; isolate objective/context
│   ├── authority.ts  # high-impact capability gating
│   ├── discovery.ts  # mtime-aware SkillIndex (add/modify/remove)
│   ├── scanner.ts    # self-contained SKILL.md discovery
│   ├── router.ts     # token scoring + selection
│   ├── prompt.ts     # builds the injected <auto-skills> block
│   ├── config.ts     # settings + persisted runtime state
│   └── types.ts      # shared types & defaults
├── session-breakdown/
│   ├── index.ts      # /session-breakdown command + TUI wiring
│   ├── discovery.ts  # JSONL scan/parse, session metadata extraction
│   ├── breakdown.ts  # aggregation math, palettes, computeBreakdown
│   └── render.ts     # BreakdownComponent (calendar heatmap + tables)
├── prompt-editor/
│   ├── index.ts       # /mode command, shortcuts, session_start/model_select handlers
│   ├── modes-store.ts # file I/O + locking + schema, pure CRUD helpers
│   └── modes.ts       # inferModeFromSelection, cycleModeName (pure)
├── autocompact-lite/
│   ├── index.ts  # turn_end handler: proactive compaction trigger
│   └── usage.ts  # shouldCompact logic, settings resolution (pure, testable)
└── memory-lite/
    ├── index.ts       # /memory command, context handler registration
    ├── identity.ts    # Git boundary discovery, remote normalization, key derivation
    ├── schema.ts      # version 1 document parse/validate/serialize
    ├── storage.ts     # path derivation (memory.md, enablement.json, lock, temp)
    ├── config.ts      # isolated enablement state (default-off)
    ├── read-path.ts   # context handler, marker dedupe, bounded message assembly
    ├── budget.ts      # byte/character caps, complete-entry selection
    ├── status.ts      # non-sensitive status reporting, rate-limited warnings
    ├── write-path.ts  # add/remove CRUD orchestration, read-under-lock
    ├── lock.ts        # advisory lock with stale-lock recovery
    ├── atomic-file.ts # temp-file + rename atomic write
    └── privacy.ts     # conservative suspicious-secret checks
scripts/
├── repair-herdr-agent.ts   # idempotent post-update Herdr launcher repair
└── update-pi-from-ak.ts    # idempotent post-`ak update` skill name repair + agent conversion
```

See [`docs/auto-skills.md`](docs/auto-skills.md) for design notes.

## Third-party attribution

This repository includes code adapted from
[`darkamenosa/pi-setup`](https://github.com/darkamenosa/pi-setup) (Apache
License 2.0). The adapted files retain their Apache-2.0-derived status and
are not relicensed under this repository's MIT license:

| Extension | Source file | Changes |
|---|---|---|
| `session-breakdown` | `extensions/session-breakdown.ts` | Split into multi-module directory (`discovery.ts`, `breakdown.ts`, `render.ts`, `index.ts`); import paths adjusted. |
| `prompt-editor` | `extensions/prompt-editor.ts` | Split into `modes-store.ts`, `modes.ts`, `index.ts`; uses real `getAgentDir()` from SDK instead of best-effort duplicate. |
| `autocompact-lite` | `extensions/autocompact.ts` | Reimplementation only — no source lines copied. Built against Pi 0.83's public compaction API. |

Apache-2.0 §4 attribution obligations are satisfied by: (a) retaining the
license header in each adapted file, (b) stating that files were changed,
and (c) retaining the origin URL. The full Apache-2.0 license text is
available at https://www.apache.org/licenses/LICENSE-2.0.

## Troubleshooting: skill `invalid-name` diagnostics

Pi emits `invalid-name` diagnostics when a `SKILL.md` `name:` field contains
characters outside the allowed set (lowercase letters, numbers, hyphens only).
A common source was `~/.claude/skills/`, where entries use colon names like
`ak:web-frameworks`. **This extension no longer surfaces `~/.claude/skills/`**,
so Pi does not scan it and the diagnostics no longer appear for skills loaded
through this package. Skill discovery is now limited to Pi's two built-in
global paths (`~/.pi/agent/skills/` and `~/.agents/skills/`). If you add
`~/.claude/skills/` back via Pi settings (`"skills": ["~/.claude/skills"]`),
the diagnostics will return unless the `name:` fields are hyphen-only — run
`scripts/update-pi-from-ak.ts` (see [Update Pi from AgentKit](#update-pi-from-agentkit)) to
normalize them after every `ak update`.
