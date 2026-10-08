<!-- SPDX-FileCopyrightText: 2026 Hari Srinivasan <harisrini21@gmail.com> -->
<!-- SPDX-FileCopyrightText: 2026 Tobias Hoelzer (omp port) -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Changelog

Versioning restarts at `0.1.0` for this fork. Upstream
[`Observal/pi-insights`](https://github.com/Observal/pi-insights) was at
`1.2.3`; carrying that number forward would have implied a continuity of
package identity that does not exist, since this targets a different harness.

## 0.1.0 — unreleased

First release of the omp port. The initial commit of this repository is
upstream verbatim; every entry below is a diff against it.

### Added

- **omp session source.** Filesystem walk of `~/.omp/agent/sessions`, replacing
  the Pi `SessionManager` import. Advisor and per-subagent sidecar logs are
  attributed to their parent session and reported separately as
  `cost_primary` / `cost_advisor` / `cost_subagent`; they never appear as
  top-level sessions.
- **Claude Code source** behind the same `SessionSource` interface
  (`--source claude`, reads `~/.claude/projects`). Corpora are never merged.
- **Audit manifest** (`usage-data/session-set.json`) naming the exact session
  set, per-session cost split by class, sidecar paths and a `size:mtime`
  signature per log, plus `tools/verify-cost.sh`, which re-sums
  `usage.cost.total` with `jq` over those files and verifies nothing changed
  since the run.
- **Signals omp records and Pi did not:** `steering` (interruptions),
  `thinking_level_change` and `model_change` (mid-session escalation),
  `compaction`, `ttft`/`duration` latency, `cacheRead`/`cacheWrite`.
- `xd://` writes counted as their tool device rather than as file writes, so
  MCP and device usage is visible instead of hidden inside a `write` count.
- Deterministic Markdown sections: cost attribution by class, failures by
  tool, corpus provenance, facet coverage, and the user's own setup.
- **Friction signals**: `stopReason: "aborted"`/`"error"` (classified into
  `rate_limit`/`quota`/`auth`/`other`), `toolResult.isError` versus invented
  tool names (the harness's "Tool X not found" replies, kept out of every
  real tool's error rate), `ttsr_injection` and `reset_boundary`. Reported as
  an interruption rate, an abort-outcome-label split (heuristic, overridden
  by the facet LLM's per-event judgment where available), provider-error
  classes, invented-tool-name counts and a per-tool error-rate table.
- **Per-turn aggregation**: a pass over human messages tracking LLM round
  trips, tool calls, exploration calls before the first edit, wall clock and
  cost per turn; reported as p50/p90 plus the worst 5 turns per session and
  across the corpus.
- **Per-tool wall clock**: `tool_execution_start` paired with the matching
  `toolResult` by `toolCallId`, reported as calls/p50/p90/share of total tool
  time per tool. `intent` is only recorded before 2026-10-07 (omp disabled
  `tools.intentTracing` that day) and is never rendered as a column.
- **Cache efficiency and edit churn**: `cacheRead / (input + cacheRead)` per
  session plus a token-weighted corpus ratio and a worst-5-sessions table;
  per-path edit counts (same edit/write detection that already fed
  `files_modified`) aggregated into a most-re-edited-files table.
- Caching for generated sections and synthesis, keyed on the shared data block
  and active model; `--no-llm` renders from cache with no spend and labels the
  reuse; `--max-sessions` / `--max-facets` / `--model-concurrency` flags and
  `OMP_INSIGHTS_*` environment overrides.
- Test suite (33 tests, `node --test`, no dependencies) and CI.
- **Facts object and facts checker** (`src/facts.ts`). Every percentage and
  dollar amount the report may quote is computed in TS with its definition,
  `n`, population and window, handed to the section prompts read-only, and
  the generated prose is checked against it afterwards (+-1 point for
  percentages, +-1% for dollars). Unbacked numbers are reported as a warning
  and written to `fact_check` in `session-set.json`. Scope is percentages and
  dollar amounts only; bare integers are not checked.
- `n=` sample size on every stat card and chart in the HTML report;
  facet charts are labelled decay-weighted.
- **Live features reference** (`buildFeaturesReference`): swaps the Memory
  entry for retain/recall when `memory.backend` isn't the default `learn`,
  instead of always advertising the `learn` tool.
- **Suggestion filtering** (`filterSuggestions`): drops a generated
  suggestion if it names a feature unavailable in the live harness state
  (e.g. the `learn` tool when `memory.backend` is `mnemopi`) or an
  already-installed skill (exact name or close token-overlap match).
- **Harness-change detection** (`src/harness.ts`): diffs
  `config.yml.bak-*` snapshots, skill/hook install dates and `AGENTS.md`
  mtime against the report window, surfacing memory-backend switches and
  other harness changes in "What Changed This Week" (flagged `too_recent`
  when fewer than 7 days of corpus data exist after the change) — a signal
  independent of `src/temporal.ts`'s facet-derived model-switch diff.
- **Tooling-session exclusion** (`excludeToolingSessions`): this repo's own
  development sessions are dropped before aggregation entirely (totals
  included), so they no longer dominate worst-turn and friction signals.
  Configurable via `--exclude-projects` / `OMP_INSIGHTS_EXCLUDE_PROJECTS`
  (comma-separated, substring-matched; `none` opts out), default excludes
  `oh-my-pi-insights`. The excluded count is reported in the corpus audit
  table and the session-set.json manifest.

### Changed

- `DATA_DIR` moved to `~/.omp/agent/usage-data`.
- `gatherUserContext` reads omp's real surface: `config.yml` (YAML
  `modelRoles` and `retry.fallbackChains`), both `skills/` and
  `managed-skills/`, `extensions/`, `hooks/<event>/`, `mcp.json`, and
  `~/.claude/CLAUDE.md`.
- `PI_FEATURES_REFERENCE` rewritten as `OMP_FEATURES_REFERENCE` for omp's
  feature set, then that static constant replaced by
  `buildFeaturesReference(ctx)` built from the live `UserContext` (memory
  backend) rather than a hardcoded list. Getting this list wrong is the main
  way the report becomes useless, because the model can only suggest
  features it is told exist.
- `gatherUserContext` also reads `memory.backend` from `config.yml`
  (`UserContext.memory_backend`, default `"learn"`).
- Model calls go through an `omp -p` subprocess with the prompt on stdin. omp
  exposes credentials to extensions but no completion client; shelling out
  inherits every provider dialect and auth scheme omp supports instead of
  reimplementing them. Facet extraction runs on the `smol` role, sections and
  synthesis on the active model.
- Session metadata cache invalidated by a `size:mtime` signature over the
  primary log and every sidecar; caches namespaced per source.
- `multi_clauding` renamed to `concurrent_sessions` (harness-neutral).
- Session load cap raised from 200 to 2000; the corpus already exceeded it.
- **Model price comparison uses implied list price** (`usage.cost.input /
  input`, `usage.cost.output / output`, $ per Mtok) instead of blended
  cost per token. Blended rates fold cache reads in, so identically priced
  models with different cache mixes read 2-5x apart and drove savings claims.
  Model tiers derive from it; the Markdown model table shows it.
- Session meta cache schema bumped to 4 (per-session activity intervals,
  per-model cost components).

### Removed

- **The price table and token-derived cost.** omp records
  `usage.cost.total` per call, so cost is read rather than estimated. A
  session whose source kept no cost reports it as unavailable and never as $0.
- **Regex bucketing of tool-error text.** `toolResult.isError` is a boolean,
  so the error count is exact; the previous patterns both missed errors and
  invented them from successful output containing phrases like "file not
  found". The category now derives from the tool name.
- The synthesis fallback that substituted placeholder prose on failure.
- All `@earendil-works/*` dependencies; the host is typed structurally.

### Fixed

- **Memory blowup from unbounded `omp -p` fan-out.** Facets ran 50 sessions
  at once, each long transcript fired every chunk summary in parallel, and
  all 8 sections ran together. Every call is a full omp process (~450 MB), so
  a corpus with long sessions spawned hundreds and froze the machine. One
  shared limiter now caps live model subprocesses across all phases;
  `--facet-concurrency` is replaced by `--model-concurrency` (default 4, env
  `OMP_INSIGHTS_MODEL_CONCURRENCY`).
- **Impossible active time.** Active hours summed every session's duration,
  so parallel sessions counted once each (198h/day). Each session now records
  runs of message activity (user, assistant, toolResult) split at gaps over
  15 minutes; active time is their union per local calendar day, so parallel
  sessions count once and sessions left open count only while active.
- **Interruption card vs rate.** The card counted steering only while the
  rate also counted mid-session aborts. Both now use one numerator, with an
  aborted / steered breakdown on the card.
- **Conflicting before/after deltas.** The banner, the major-transition note
  and the trajectory line each computed their own delta over unstated
  windows. There is now one `TemporalData.delta` (around the model switch,
  else week over week) with explicit windows, and every printed delta quotes it.
- **Browser errors blamed on eval.** Browser automation runs through `eval`,
  so its failures counted as eval errors. Eval calls whose code uses the
  `browser` global now count as `browser`.
- A session present twice on disk under two slugified-cwd directories was
  counted twice, double-counting its spend and making session counts
  non-deterministic between runs. Deduplicated by session id.
- Model labels were truncated by a regex assuming Pi's dot-separated ids, so
  `gpt-5.6-terra` rendered as `6-terra`.
- Failed facet extractions were silently dropped, removing those sessions from
  every facet-derived chart with no trace. They are now counted and reported.
- The friction-signal, per-turn and per-tool-wall-clock fields were added to
  `SessionMeta` without a cache schema version, so every already-cached
  session (any log whose `size:mtime` had not changed since before these
  fields existed) silently read back as zero/empty instead of being
  recomputed: a real corpus with months of cached sessions reported 0
  aborted generations and 0 provider errors despite hundreds of each in the
  logs. `session-meta/<id>.json` now carries a schema version; a stale or
  missing version is treated as a cache miss rather than backfilled with 0.
