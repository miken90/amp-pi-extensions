# amp-pi

A general, extensible pack of enhancements for the [Pi agent harness](https://pi.dev/).
The package name is intentionally generic so it can host unrelated Pi enhancements
over time. It includes **auto-skills** and a durable **skill-loader** tool.

> auto-skills is a **convenience layer that supplements — never replaces — the
> model's own skill selection**. Pi already lists every skill's name+description
> in the system prompt (progressive disclosure); auto-skills just curates the
> few materially relevant ones per turn and pre-loads their bodies. The model
> can still invoke any other skill through the `skill` tool.

## Features

### skill-loader

Provides the `skill` tool used to invoke installed skills by name, inject their
instructions once per session, discover Claude-compatible skill directories,
and route `/skill:name` through the tool instead of Pi's native inline
expansion. Keeping this tool in this repository prevents package updates from
overwriting local skill-loading fixes.

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

## Develop

```bash
bun test                       # unit + integration + load-smoke tests
bun build extensions/auto-skills/index.ts --no-bundle --outfile /tmp/auto-skills.js
bun build extensions/skill-loader/index.ts --no-bundle --outfile /tmp/skill-loader.js
```

Tests inject a fake parser + temp agent dir, so they never touch the real Pi
config or require network.

## Layout

```
extensions/
├── skill-loader/
│   └── index.ts  # skill tool, /skill routing, Claude skill discovery
└── auto-skills/
    ├── index.ts      # Pi extension entry: events, commands, status
    ├── pipeline.ts   # pure end-to-end route: parse -> score -> authority
    ├── contract.ts   # parse mik-target-v1 prompts; isolate objective/context
    ├── authority.ts  # high-impact capability gating
    ├── discovery.ts  # mtime-aware SkillIndex (add/modify/remove)
    ├── scanner.ts    # self-contained SKILL.md discovery
    ├── router.ts     # token scoring + selection
    ├── prompt.ts     # builds the injected <auto-skills> block
    ├── config.ts     # settings + persisted runtime state
    └── types.ts      # shared types & defaults
```

See [`docs/auto-skills.md`](docs/auto-skills.md) for design notes.
