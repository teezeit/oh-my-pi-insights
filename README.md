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

### Architecture

After Stage 3, the extension was split from a single file into modules: `index.ts` handles registration and orchestration; `src/` contains session sources, deterministic stats, temporal aggregation, data aggregation, prompt templates, model calls, result caching, user context, and report rendering.

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

Current release: **`v0.1.0-rc.1`** (internal test release, not on npm). The
repository is private, so you need read access to
`github.com/teezeit/oh-my-pi-insights`.

```bash
omp plugin install "git+https://github.com/teezeit/oh-my-pi-insights.git#v0.1.0-rc.1"
omp plugin list            # shows the installed version and path
omp plugin doctor          # verifies the install
```

Always install from the tag, not `#main`: `main` moves. To update, re-run the
install with the newer tag. To remove: `omp plugin uninstall @teezeit/omp-insights`
(the caches under `~/.omp/agent/usage-data/` stay; delete that folder too for a
clean slate).

From a checkout instead: `omp -e ./index.ts` (one session, no install) or
`omp plugin link .` (links the checkout).

### Trying it (for testers)

1. Start omp in any project and run `/insights`. The first run reads every
   session and classifies up to 50 of them, so it takes minutes, not seconds.
2. The report opens in your browser; it is also at
   `~/.omp/agent/usage-data/report.html`. Add `--md` for a Markdown copy.
3. Re-render without any model calls: `/insights --no-llm`.
4. Feedback: open an issue on the repository with the report section, what
   you expected, and (if relevant) a screenshot. Do not attach `report.html`
   or session logs unless you are fine sharing their content.

Known limits in this release: untested on Windows; the Claude Code source
(`--source claude`) has no interruption or per-tool timing data; nav links
jump to a collapsed section's header but do not open it.

## Data and cost

- **What leaves your machine:** session transcripts (long ones in chunks)
  are sent to *your own* configured model to classify each session (the
  `smol` role), and an aggregated data block (stats plus short excerpts such
  as first prompts, friction notes and file names, not full transcripts)
  goes to your active model for the report sections. It all runs through
  your local `omp -p` with your credentials; nothing goes anywhere else.
- **What stays local:** the report, all caches and the audit manifest under
  `~/.omp/agent/usage-data/`. Session logs are only read, never written.
- **What it costs:** one smol call per not-yet-classified session (capped by
  `--max-facets`, default 50) plus 9 calls on your active model. Re-runs reuse
  cached classifications; `--no-llm` costs nothing. The dollar cost depends on
  your models and has not been measured for this release.
- **Memory:** each model call is a separate `omp -p` process (~450 MB); at
  most 4 run at once (`--model-concurrency`).

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
| `--model-concurrency <N>` | Max concurrent `omp -p` model subprocesses across all LLM phases, ~450 MB each (default 4, env `OMP_INSIGHTS_MODEL_CONCURRENCY`) |

## What omp gives it that Pi did not

- **Cost is recorded, not estimated.** Assistant messages carry
  `message.usage.cost.total` and out-of-band calls are `model_usage`
  records. Upstream's price table and token-derived cost are gone. This is
  omp's own list price per call, applied regardless of how the call is
  actually paid for, so the report also splits it by payment basis:
  `cost_by_provider` (sorted desc, one entry per provider) tags each
  provider's auth as `subscription` (OAuth; the figure is the API
  list-price equivalent of what the plan covered, not an amount actually
  billed), `api_key` (pay-as-you-go; `billed_cost` sums these: this is the
  real spend), or `unknown` (no credential entry for that provider, or
  omp's credential store could not be read). Auth is read read-only from
  omp's own `agent.db` (`auth_credentials` table; never the credential
  data itself) via `src/auth.ts#readProviderAuth`, which never throws: any
  failure reads every provider as `unknown` rather than guessing.
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
- **Per-turn and per-tool pathology.** Session totals hide the expensive
  failure mode: one request costing many LLM round trips and tool calls to
  change two lines. A per-turn pass (one human message to the next) and
  `tool_execution_start`/`toolResult` pairing for per-tool wall clock surface
  it; neither has a Pi equivalent.

## Friction signals

The report reads these session-log facts to answer "where does the model go
wrong, get corrected, or work too long for too little":

- `stopReason: "aborted"` on an assistant message (a generation the user
  killed mid-flight) and `stopReason: "error"` with its `errorMessage`
  classified into `rate_limit` / `quota` / `auth` / `other`.
- `toolResult.isError`, and separately, the harness's own "Tool X not found"
  replies (the model inventing a tool name that does not exist). Invented
  names are kept out of every real tool's error rate rather than blamed on
  whichever tool the model meant to call.
- `type: "ttsr_injection"` (the harness caught a bad generation mid-session
  and injected a rule) and `type: "reset_boundary"` (a path was abandoned
  and context rewound).
- `type: "custom", customType: "tool_execution_start"` paired with the
  matching `toolResult` by `toolCallId`, for per-tool wall clock (p50/p90
  and share of total tool time).
- A per-turn pass over human messages: LLM round trips, tool calls,
  exploration calls before the first edit, wall clock and cost per turn,
  reported as p50/p90 plus the worst 5 turns per session and across the
  corpus.
- `cacheRead` / `input` per session (the resumed-stale-session tax: a low
  ratio on a large prompt means money and latency burned re-reading
  context), and a per-path edit count surfacing the same file edited
  repeatedly across sessions.

Two caveats:

- `intent` on `tool_execution_start` is only present when omp's
  `tools.intentTracing` was on for that session. The report counts tool calls
  carrying intent and mentions intent only when that count is above zero.
- The Claude Code source (`--source claude`) has no `steering`,
  `ttsr_injection`, `reset_boundary` or `tool_execution_start` equivalent, so
  interruption rate, TTSR injections, reset boundaries and per-tool wall
  clock all read `0` for that source rather than "unavailable."

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
`~/.omp/agent/usage-data/` (under the active profile's agent directory when
`OMP_PROFILE` or `PI_CODING_AGENT_DIR` is set):

| Path | Contents |
|------|----------|
| `session-meta/<id>.json` | Deterministic stats; invalidated when a log's size or mtime changes |
| `facets/<id>.json` | LLM-extracted facets, cleared by `--refresh` |
| `sections/<hash>.json` | Generated sections and synthesis, keyed on the shared data block and active model; newest 5 kept |
| `harness-snapshot.json` | Your setup at the last run (config hash, model roles, skills, hooks), diffed for "Since Last Report" |
| `report.html` | Last generated HTML report |
| `report.md` | Last Markdown export |
| `session-set.json` | Audit manifest for the last run |

## Requirements

- omp `>=18.8.4 <19` (declared as `engines.omp` in `package.json`; omp does
  not enforce it, so check `omp --version`). Developed against `omp/18.1.14`,
  verified on `omp/18.8.4`.
- Node `>=22.6` only for running the tests; inside omp there are no runtime
  dependencies beyond built-ins.

## License

AGPL-3.0-only, as upstream.

## Tests

```bash
npm test                    # node --test, no dependencies
npm run test:update-golden   # after an intentional report-layout change
```

195 tests, ~2s. Node >= 22.6 (native TypeScript type-stripping); upstream ships
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
two consecutive runs read slightly different totals because the session
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
