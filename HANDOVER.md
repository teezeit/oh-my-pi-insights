# oh-my-pi-insights - porting handover

## Goal

Port `Observal/pi-insights` (a Pi coding-agent extension, AGPL-3.0) to the **omp**
harness ("Oh My Pi", `omp/18.1.14`). Output: an omp extension exposing `/insights`
that scans local omp session logs and produces a self-contained HTML report plus a
`--md` export.

The report exists to turn hundreds of unrememberable sessions into a handful of
config changes: AGENTS.md rules, model-routing changes, skills to delete, prompts
to reuse. Every generated block is meant to be pasted somewhere, not admired.

## Provenance and licence

- `index.ts`, `package.json`, `README.md`, `LICENSE` in the initial commit are
  **verbatim upstream** `Observal/pi-insights` (2810 lines). That commit is the
  baseline; diff against it to see the port.
- Upstream is **AGPL-3.0-only**. This fork stays AGPL-3.0. Keep the SPDX headers
  and attribute upstream in the README.
- Upstream is itself a port of Claude Code's internal `/insights`
  (`src/commands/insights.ts`, 3202 lines, 2.1.88). **Do not copy from that file.**
  It is leaked proprietary source. It was read only to establish lineage. All code
  here derives from the AGPL upstream.

## What upstream already does (keep it)

Five phases, in `index.ts`:

1. **Scan** session logs.
2. **Deterministic stats** per session (`extractSessionStats`, ~:549) - tool counts,
   tokens, cost, tool errors, languages, git activity, response times, first prompt.
   Cached permanently in `usage-data/session-meta/<id>.json`.
3. **LLM facet extraction** per session (`FACET_EXTRACT_PROMPT`, ~:1303) - goals,
   outcome, satisfaction, friction taxonomy, reusable user instructions. Cached in
   `usage-data/facets/<id>.json`, invalidated only by `--refresh`.
4. **Aggregate** (`aggregateData`, ~:916) + **temporal layer**
   (`computeTemporalData`, ~:383): week-over-week diffs with noise gates
   (>15% cost, >20% errors), trajectory (last 10 vs earlier, +/-20% bands),
   anomalies (>3x trailing-10 mean AND absolute floor), major model transition with
   before/after deltas, resolved-vs-ongoing friction (14-day window), staleness,
   10-day half-life decay weighting.
5. **Generate**: 8 parallel section prompts + synthesis, then render HTML/Markdown.

The value is concentrated in phases 3-5 and the temporal layer. Do not rewrite them.
This is a **port**, not a redesign.

## Session data: omp vs Pi (verified 2026-09-09)

Corpus: `~/.omp/agent/sessions`, **383 `.jsonl` files, 356 MB**, 364 modified since
2026-08-25. Layout:

```
~/.omp/agent/sessions/<slugified-cwd>/<ISO-ts>_<session-id>.jsonl   <- primary log
~/.omp/agent/sessions/<slugified-cwd>/<ISO-ts>_<session-id>/        <- sidecar dir
        __advisor.jsonl        (22 across the corpus)
        <n>.bash.log, <n>.read.log, <n>.eval.log   (tool output spill)
```

Record types in a primary log (`jq -r .type | sort | uniq -c`):

```
message  270    custom  124    model_usage  11    thinking_level_change  5
title_change 1  title 1  session 1  model_change 1  custom_message 1  credential_pin 1
```

Key schemas:

```jsonc
{"type":"session","version":3,"id":"01a082a3-…","timestamp":"2026-09-08T20:09:14.857Z",
 "cwd":"/Users/…/peach/.worktrees/…","title":"Create PRD item in Linear","titleSource":"auto"}

{"type":"model_usage","timestamp":"…","purpose":"auto-thinking","role":"tiny",
 "provider":"anthropic","model":"claude-haiku-4-5",
 "usage":{"input":537,"output":4,"cacheRead":0,"cacheWrite":0,"totalTokens":541,
          "cost":{"input":0.000537,"output":0.00002,"cacheRead":0,"cacheWrite":0,"total":0.000557}}}

{"type":"message","id":"…","parentId":"…","timestamp":"…","message":{ … }}
// message.role ∈ user | assistant | toolResult
// assistant: {content[], model, provider, api, usage, ttft, duration, stopReason, responseId, contextSnapshot?}
// toolResult: {content[], toolName, toolCallId, isError, details}
// user:       {content[], attribution, steering}
```

**This is materially better input than Pi/Claude had.** Two upstream workarounds
must be deleted rather than ported:

- **Cost/tokens**: omp writes explicit `model_usage` records with per-model
  `usage.cost.total`. Do not re-derive cost from token counts and a price table.
- **Tool errors**: `toolResult.isError` is a boolean. Upstream buckets errors by
  regex over tool output. Delete the regex bucketing; use the flag. Keep a coarse
  category derived from `toolName`.

Also available and worth using: `usage.cacheRead`/`cacheWrite` (cache-hit economics),
`ttft` and `duration` (latency), `steering` on user messages (interruptions),
`message.parentId` (turn threading), `thinking_level_change` / `model_change`
(mid-session escalation - a real behavioural signal Pi has no equivalent for).

### Nested logs - the correctness trap

`__advisor.jsonl` sidecars are **separate sessions with their own cost**. Omitting
them undercounts spend badly; in a previous investigation an enabled advisor
accounted for 160 otherwise-invisible Anthropic calls. Requirements:

- Attribute advisor/subagent cost to the **parent** session, and also report it
  broken out (`cost_primary` vs `cost_advisor` vs `cost_subagent`).
- Never let a sidecar appear as a top-level session in session counts.
- `*.bash.log` / `*.read.log` / `*.eval.log` are tool-output spill, not transcripts.
  Ignore them except, optionally, as a size signal.

## Port checklist

### P1 - paths and context (correctness of every suggestion)

- `DATA_DIR` (`index.ts:38`) `~/.pi/agent/usage-data` -> `~/.omp/agent/usage-data`.
- `gatherUserContext` (`:343`) reads `~/.pi/agent/{AGENTS.md,settings.json,skills,extensions}`.
  omp equivalents:
  - `~/.omp/agent/config.yml` (**YAML, not `settings.json`**) - default model lives in
    `modelRoles`; also read `retry.fallbackChains`.
  - `~/.omp/agent/skills/` **and** `~/.omp/agent/managed-skills/` (55 skills today -
    both dirs must be read or the report will suggest skills that already exist).
  - `~/.omp/agent/extensions/` (`.ts` files).
  - Global instructions: `~/.claude/CLAUDE.md` is the user's identity file; project
    `AGENTS.md` files live per repo. Read the global one; per-project ones are optional.
- `PI_FEATURES_REFERENCE` (`:1377`) must be rewritten for omp's real feature surface:
  skills + managed skills (`manage_skill`), `learn`/memory, hooks
  (`~/.omp/agent/hooks/`), extensions, subagents (`task`), `xd://` tool devices,
  MCP servers, model roles and fallback chains, advisor. **Getting this list wrong is
  the main way the report becomes useless**, because the model can only suggest
  features it is told exist.

### P2 - scan and stats over omp logs

- Replace the Pi `SessionManager` import (`:27`) with a filesystem walk of
  `~/.omp/agent/sessions/**/*.jsonl`. Prefer fs-only; do not depend on omp internals.
- Session id = the `type:"session"` record's `id`; start time = its `timestamp`;
  project = `cwd`.
- Rewrite `extractSessionStats` against the schemas above: sum `model_usage` for
  cost/tokens, count `toolResult.isError` for errors, derive languages from
  `file_path`-ish tool inputs, response-time gaps from consecutive user/assistant
  timestamps, hour-of-day from timestamps.
- Keep `isMetaSession` (`:527`): exclude sessions spawned by the insights pipeline
  itself.
- Keep `detectMultiClauding` (`:833`, 30-minute overlap window) - rename to something
  harness-neutral.

### P3 - caps

`MAX_SESSIONS_TO_LOAD = 200`, `MAX_FACET_EXTRACTIONS = 50`, `FACET_CONCURRENCY = 50`
(`:44-47`). The corpus is already 383 sessions. Raise the load cap (or make it
`--since`-driven), keep facet extraction capped and cached so a run has bounded cost.
Make all three overridable by flag or env.

### P4 - model calls

`callModel` (`:1248`) uses `ctx.model` / `ctx.modelRegistry.getApiKeyAndHeaders`.
Verify these exist on omp's extension context. omp and Pi expose the same extension
API under different package names - see the note at the top of
`~/.omp/agent/extensions/orca-agent-status.ts`, which deliberately avoids
package-specific type imports for exactly this reason. Follow that pattern: no
`@earendil-works/*` imports, structural typing only. Drop those deps from
`package.json`.

### P5 - registration

Register the command as `/insights` in an omp extension. Verify it loads via
`omp -e ./index.ts` (note: `omp -e npm:<pkg>` does **not** work for uninstalled
packages - it resolves as a path and fails with `Cannot find module`; use
`omp install` or a local path).

## Acceptance criteria

1. `omp -e ./index.ts` loads, `/insights --md --no-open` completes over the real
   corpus and writes `~/.omp/agent/usage-data/report.md`.
2. Deterministic numbers are **verifiable**: total cost from the report matches an
   independent `jq` sum over `model_usage.usage.cost.total` for the same session set,
   including `__advisor.jsonl`. Show that comparison in the PR/summary.
3. Session count excludes sidecars and meta-sessions; advisor cost is reported
   separately and included in the total.
4. `gatherUserContext` returns non-empty skills (>= 50), extensions, and a default
   model. Prove it - a suggestion recommending an already-installed skill is a bug.
5. Re-running without `--refresh` performs **zero** facet LLM calls (cache hit) and
   completes in seconds.
6. `--since 7d` restricts the corpus; `--refresh` invalidates facets.
7. No `~/.pi` path and no `@earendil-works/*` import remains: `grep -rn "\.pi/\|earendil" index.ts` is empty.

## Staging - do this in order

**Stage 1 (no LLM spend):** P1 + P2 + P3, `--md` only, deterministic sections
rendered, LLM phases stubbed. Land this and show the numbers. This is the milestone
that must be right; everything after is prompt work.

**Stage 2:** facet extraction + aggregation + section prompts + synthesis, HTML report.

**Stage 3 (optional, do not start unbidden):** a Claude Code source adapter -
`~/.claude/projects` holds 159 MB of transcripts in a comparable JSONL format.
Abstract the scanner behind a source interface in Stage 1 so this stays cheap, but do
not implement it now.

## Constraints

- Keep it a single-file extension if practical; upstream is one 2810-line file and
  splitting it makes the port diff unreadable. Split only after Stage 2 lands.
- No new runtime dependencies beyond what upstream uses (node builtins).
- Do not run project-wide formatters or reflow untouched upstream code - it destroys
  the diff against the vendored baseline.
- Read-only against `~/.omp/agent/sessions`. Never mutate session logs.
- Commit in stages with messages that make the port auditable against upstream.

## Reference

- Upstream repo: https://github.com/Observal/pi-insights (AGPL-3.0)
- Local upstream clone used for the baseline: `/tmp/pi-insights`
- Corpus: `~/.omp/agent/sessions` (383 jsonl, 356 MB)
- omp version: `omp/18.1.14`
