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
| 2 | LLM facet extraction, 8 section prompts, synthesis, HTML report | not started |
| 3 | `~/.claude/projects` source adapter | not started |

Stage 1 calls no model: `LLM_PHASES_ENABLED` is `false`, `callModel` throws, and
the facet/section/synthesis code paths (upstream's, kept intact) are skipped. A
run costs nothing and does not need an active model.

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
| `--refresh` / `-r` | Invalidate cached facet extractions (Stage 2) |
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
| `facets/<id>.json` | LLM-extracted facets (Stage 2), cleared by `--refresh` |
| `report.html` | Last generated HTML report |
| `report.md` | Last Markdown export |
| `session-set.json` | Audit manifest for the last run |

## Requirements

- omp 18.x (developed against `omp/18.1.14`)
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
