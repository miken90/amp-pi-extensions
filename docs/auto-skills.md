# auto-skills — design notes

## Goal

Pi already lists every installed skill's name + description in the system prompt
(progressive disclosure). The sibling skill-loader lets the model invoke a
skill by name and receive its full `SKILL.md` body on demand.
With a large catalog this is noisy and the model may not pick the best skill.
**auto-skills** adds curation: each turn it selects the materially relevant
skills for the specific request and proactively loads their full bodies, while
keeping the catalog fresh as `SKILL.md` files change.

## How it fits into the Pi lifecycle

```diagram
user submits prompt
  └─ input                         → detect /skill: or /ak: → set turnExplicit
  └─ (skill/template expansion)
  └─ before_agent_start            → refresh index; if explicit/disabled → skip
                                     else: routePrompt → inject <auto-skills>
                                     into systemPrompt + set footer status
  └─ agent loop (provider call …)
```

- **Explicit invocation wins**: the `input` handler sees the *raw* text
  (pre-expansion) and sets a per-turn flag. `before_agent_start` consumes and
  clears it, records `lastReason: "explicit"`, and skips routing entirely so
  Pi's native `/skill:name` expansion owns the turn.
- **Stable snapshot**: the index is refreshed once at the top of
  `before_agent_start`; selection reads that snapshot, so it is constant for the
  turn even if the filesystem changes mid-turn.

## Refresh strategy (add/modify/remove)

`SkillIndex` (discovery.ts) keys entries by `filePath` and tracks `mtimeMs`:

- Every turn, each configured skill directory is re-walked (cheap) so deleted
  files are always detected.
- A `SKILL.md` is re-parsed only when its mtime changed; identical mtime +
  unchanged name/description means no change.
- The merge also folds in skills Pi already loaded (from
  `event.systemPromptOptions.skills`), so skills supplied by npm packages or
  `--skill` (which we can't stat ourselves) are still considered.

The return value reports `added` / `modified` / `removed` deltas for
observability; `/askills reload` forces a full rebuild.

## Router (selection)

Pure, deterministic, no LLM calls (router.ts):

1. Tokenize the routing query (lowercase, split, drop stopwords + short tokens,
   light suffix stemming so `tools`↔`tool`, `diagrams`↔`diagram` match).
2. For each skill, score: name-token match = 3, description-token match = 1,
   small multi-token coverage bonus.
3. Keep skills with `score ≥ threshold` (default 1.0), sort desc, cap at
   `maxSelected` (default 2).
4. Skills with `disable-model-invocation: true` are excluded (Pi hides them
   from the model too).

"Ordinary requests may select zero skills" — if nothing clears the threshold,
nothing is injected.

## Contract-aware routing (mik-target-v1)

A raw user prompt is one thing; a Mik assignment is a YAML contract whose
`forbidden_scope` and `control` sections contain exactly the words that broke
naive routing ("Do not commit, push, or deploy"). `contract.ts` detects
structured prompts (presence of an `objective:` field) and extracts only the
routing signal:

- **Scored**: `objective` + `context`.
- **Exposed for authority checks, never scored**: `allowed_scope`,
  `forbidden_scope`.
- **Discarded entirely**: `control`, `verification`, `result`,
  `post_work_synchronization`, metadata fields.

Non-structured (ordinary) prompts pass through to the scorer whole. This alone
removed the false positives that previously ranked forbidden capabilities
first on debug/review/db/frontend assignments.

## Authority gating

On top of field extraction, `authority.ts` is defense-in-depth for high-impact
capabilities. A skill classified as deploy / commit-push-git / harness-install
/ external / active red-team is auto-selectable only when the *objective*
affirmatively authorizes that capability:

- Authorization is tested on `objective` + `allowed_scope` with **negated
  spans removed** ("do not deploy", "without committing", "never … repair the
  Harness" never count as authorization; the negation consumes its whole clause
  up to a `.` or `;`).
- A deploy objective selects the deploy skill; a debug objective does not.
- Existing-Harness **documentation sync** is a distinct, non-high-impact
  capability: a docs-sync skill is allowed when the objective asks for it,
  while Harness **install/repair** stays blocked. This matches the Mik
  post-work synchronization distinction.

"Skills are procedures, not authorization" (Mik §9): selecting a skill never
broadens the assignment's authority. The injected `<auto-skills>` block tells
the model to honor the assignment scope.

## Why a self-contained scanner (not `loadSkillsFromDir`)

Pi's examples use `import type` only. Runtime imports of
`@earendil-works/pi-coding-agent` resolve the package's `.d.ts` under Pi's jiti
loader and fail on internal specifiers (`./cli/args.ts`). So `scanner.ts`
re-implements the small subset of Pi's discovery rules we need using only
`node:fs`/`node:path`. This keeps the extension dependency-free at runtime,
works under jiti and bun, and is unit-testable in isolation.

Discovery rules mirrored from Pi (see Pi's `docs/skills.md`):
- a directory containing `SKILL.md` is a skill root (no further recursion);
- otherwise recurse into subdirectories to find `SKILL.md`;
- in `~/.pi/agent/skills` and `.pi/skills`, direct root `.md` files are also
  treated as skills.

## Preloading

When `preload` is true, the selected skills' `SKILL.md` bodies are read
(frontmatter stripped) and placed in an `<auto-skills>` block appended to the
system prompt, capped per-skill (`maxBodyBytes`) and per-turn
(`maxTotalBytes`). Bodies are loaded only for the selected few, never eagerly
for the whole catalog.

## Verification

- `bun test` — unit + integration + load-smoke tests covering: refresh
  add/modify/remove/merge, router scoring/threshold/caps, contract field
  extraction, authority gating + negation, explicit-invocation precedence,
  full mik-target-v1 assignments (debug/review/frontend/database/simple/
  authorized-deploy/authorized-harness-docs-sync), and an extension-load smoke
  test against a mock `ExtensionAPI` with injected deps.
- `bun build … --no-bundle` — syntax check across all sources.
- Real Pi load smoke tests confirm both extension factories load under jiti,
  the model invokes the local `skill` tool, and `before_agent_start` routes and
  writes auto-skills state. Add/modify/remove of `SKILL.md` files between
  invocations is reflected in the routed selection.

## Extension points (future)

The `amp-pi` package manifest points at `./extensions`; additional unrelated
extensions can be added as sibling subdirectories and are auto-discovered by Pi.
The sibling `skill-loader` extension owns explicit skill invocation through the
`skill` tool; `auto-skills` remains the relevance-based automatic selector.
`auto-skills` itself exposes injectable deps (`parseDir`, `readSettings`,
`agentDir`) so its logic stays testable without the Pi runtime. The pure
routing pipeline lives in `pipeline.ts` (`routePrompt`) and is shared by the
live handler and the `/askills test` dry-run.
