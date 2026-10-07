<!-- SPDX-FileCopyrightText: 2026 Hari Srinivasan <harisrini21@gmail.com> -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# omp Insights

Personal usage analytics for the **omp** coding harness. Scans your session
history, extracts deterministic stats, and generates a report covering your
workflows, spend and friction points.

This is a port of [`Observal/pi-insights`](https://github.com/Observal/pi-insights)
(AGPL-3.0-only, © Hari Srinivasan) from the Pi coding agent to omp. The initial
commit of this repository is upstream verbatim; diff against it to read the
port. Upstream is itself a rewrite of a Claude Code command; the temporal
layer, facet taxonomy, prompts and report structure are upstream's work.

## Port status

| Stage | Contents | State |
|-------|----------|-------|
| 1 | paths and user context, filesystem session scanner, deterministic stats, caps, `--md` report | **landed** |
| 2 | LLM facet extraction, 8 section prompts, synthesis, HTML report | **landed** |
| 3 | `~/.claude/projects` source adapter | **landed** |

### How model calls work

omp hands extensions credentials (`ctx.modelRegistry.getApiKeyAndHeaders`) but
no completion client, so `callModel` shells out to `omp -p` with the prompt on
stdin rather than reimplementing a provider client. That inherits every
provider dialect and auth scheme omp supports, including the OAuth-backed ones
a `retry.fallbackChains` entry reaches on a rate limit. Subprocesses run with
`--no-session --no-tools --no-extensions --no-skills`, so they answer and
nothing else, and never enter the corpus this report reads.

Facet extraction runs on the **smol** role (structured classification, one call
per uncached session); the section prompts and the synthesis run on the
**active** model, where judgement quality shows.

Set `OMP_INSIGHTS_OMP_BIN` if `omp` is not on `PATH`.

## Install

```bash
omp -e ./index.ts          # try it from a checkout
omp install ./oh-my-pi-insights
```

`omp -e npm:<pkg>` does not work for an uninstalled package: it resolves as a
path and fails with `Cannot find module`.

## Usage

```
/insights --md --no-open
```

| Flag | Description |
|------|-------------|
| `--md` / `--format md` | Write the Markdown export |
| `--no-open` | Do not open the HTML report in a browser |
| `--since <N>d` / `<N>w` | Only analyse sessions from the last N days/weeks |
| `--refresh` / `-r` | Invalidate cached facet extractions and regenerate the sections |
| `--no-llm` | Render from caches only; never call a model |
| `--source claude` | Read `~/.claude/projects` instead of omp's sessions |
| `--max-sessions <N>` | Session load cap (default 2000, env `OMP_INSIGHTS_MAX_SESSIONS`) |
| `--max-facets <N>` | Facet extraction cap (default 50, env `OMP_INSIGHTS_MAX_FACETS`) |
| `--facet-concurrency <N>` | Facet extraction concurrency (default 50, env `OMP_INSIGHTS_FACET_CONCURRENCY`) |

## What omp gives it that Pi did not

- **Cost is recorded, not estimated.** Assistant messages carry
  `message.usage.cost.total` and out-of-band calls are `model_usage` records.
  Upstream's price table and token-derived cost are gone.
- **Tool failures are a boolean.** `toolResult.isError` replaces upstream's
  regex bucketing over tool output; the category comes from the tool name.
- **Nested logs are real sessions.** `__advisor.jsonl` and per-subagent logs
  live in a sidecar directory beside their parent's log and hold their own
  spend. They are attributed to the parent, reported as
  `cost_primary`/`cost_advisor`/`cost_subagent`, and never counted as
  top-level sessions.
- **Behavioural signals with no Pi equivalent**: `steering` (interruptions),
  `thinking_level_change` and `model_change` (mid-session escalation),
  `compaction`, `ttft`/`duration` (latency), `cacheRead`/`cacheWrite`.
- **`xd://` writes are tool-device calls**, not file writes, so MCP and device
  usage is visible instead of hidden inside a `write` count.

## Verifying the numbers

Every run writes an audit manifest next to the report:

```
~/.omp/agent/usage-data/session-set.json
```

It lists the exact session set, per-session cost split by class, each sidecar
path, and a `size:mtime` signature per log. `tools/verify-cost.sh` re-sums
`usage.cost.total` with `jq` over those same files (including
`__advisor.jsonl`), checks no log changed since the run, and compares:

```bash
$ ./tools/verify-cost.sh
{
  "sessions_checked": 114,
  "logs_changed_since_run": 0,
  "jq":     { "primary": 2459.844615600002, "advisor": 20.02110515, "subagent": 215.55632425000005, "total": 2695.422045000002 },
  "report": { "primary": 2459.844615600002, "advisor": 20.02110515, "subagent": 215.55632425000002, "total": 2695.422045 },
  "advisor_sidecars_summed": 16,
  "subagent_sidecars_summed": 175,
  "match": true
}
```

## Data layout

Read-only against `~/.omp/agent/sessions`. Results are cached in
`~/.omp/agent/usage-data/`:

| Path | Contents |
|------|----------|
| `session-meta/<id>.json` | Deterministic stats; invalidated when a log's size or mtime changes |
| `facets/<id>.json` | LLM-extracted facets, cleared by `--refresh` |
| `sections/<hash>.json` | Generated sections and synthesis, keyed on the shared data block and active model; newest 5 kept |
| `report.html` | Last generated HTML report |
| `report.md` | Last Markdown export |
| `session-set.json` | Audit manifest for the last run |

## Requirements

- omp 18.x (developed against `omp/18.1.14`, verified on `omp/18.8.0`)
- No runtime dependencies beyond node builtins

## License

AGPL-3.0-only, as upstream.

## Tests

```bash
npm test                    # node --test, no dependencies
npm run test:update-golden   # after an intentional report-layout change
```

26 tests, ~0.4s. Node >= 22.6 (native TypeScript type-stripping); upstream ships
no test suite, builder or linter config, so this adds a runner rather than
adopting one.

- `test/config.test.ts` - the hand-rolled `config.yml` YAML subset reader and
  flag/env/default limit resolution.
- `test/stats.test.ts` - cost from both `message.usage` and `model_usage`,
  `isError` counting, `xd://` device classification, hashline-patch line
  accounting, steering/escalation signals, and the
  `total_cost == primary + advisor + subagent` identity the jq cross-check
  reconciles against the logs.
- `test/scanner.test.ts` - a temp fixture tree: sidecar classification and
  recursion, `.log` spill ignored, duplicate-session-id dedupe, signature
  coverage, partial trailing lines from a live session.
- `test/report.test.ts` - aggregation and weekly-diff noise gates, plus a
  golden-file comparison of the rendered Markdown (`test/golden/report.md`).

## Cost and caching

A cold run over ~120 sessions costs one smol call per uncached session (capped
at `--max-facets`, default 50) plus 9 calls on the active model. Measured: 8m6s
for 44 facets plus sections and synthesis.

Sections are cached on a hash of the shared data block and the active model, so
an unchanged corpus re-renders for free. The corpus changes whenever omp runs,
though, so on a machine that is actively using omp the key legitimately misses:
two consecutive runs here read $2790.305 and $2790.503, because the session
doing the measuring kept spending. Use `--no-llm` when you want a re-render
with no spend; it reuses the newest cached generation and the report says so.

## Sources

`SessionSource` owns listing, parsing and transcript formatting, so a harness
adapter is an implementation of one interface rather than a fork of the
pipeline. Corpora are never merged: a single total across two harnesses would
hide which one the spend came from.

| | omp (default) | `--source claude` |
|---|---|---|
| Layout | `sessions/<slug>/<ts>_<id>.jsonl` + sidecar dir | `projects/<slug>/<uuid>.jsonl`, flat |
| Cost | `usage.cost.total` per call, always present | `cost-state` records, **only some sessions** |
| Subagents | separate sidecar logs, cost split out | inline `isSidechain` turns, cost not separable |
| Tool errors | `toolResult.isError` + `toolName` | `tool_result.is_error`, tool resolved via `tool_use_id` |
| Interruptions, escalation, latency | `steering`, `thinking_level_change`, `model_change`, `ttft` | not recorded |

Claude Code traps the adapter handles, all verified against the real corpus:

- **Cost is partial.** 19 of 24 local logs carry no `cost-state`. Those
  sessions report `cost_recorded: false`, contribute $0, and the report says
  the spend figure is a lower bound. Deriving cost from tokens and a price
  table is the exact workaround this port exists to delete, so it is not done.
- **Responses repeat.** One API response can be logged as several assistant
  entries sharing a `requestId`; usage is deduplicated by it. Where a
  `cost-state` exists it supersedes the per-message sum entirely, since it is
  the harness's own accounting.
- **`tool_result` names an id, not a tool**, so the adapter remembers
  `tool_use_id -> tool name` from the calling turn to categorise failures.
- **Sidechain and meta turns are not the human typing** and never count as
  user messages, response times or hour-of-day.

The meta and sections caches are namespaced per source, so the two corpora
cannot contaminate each other's cached stats or prose.

Measured on the local Claude corpus: 24 logs, 7 substantive, **$6.123361**,
matching an independent `jq` sum over `cost-state.totalCostUSD` for the same
files exactly.
