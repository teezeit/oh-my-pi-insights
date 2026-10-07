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
  reuse; `--max-sessions` / `--max-facets` / `--facet-concurrency` flags and
  `OMP_INSIGHTS_*` environment overrides.
- Test suite (33 tests, `node --test`, no dependencies) and CI.

### Changed

- `DATA_DIR` moved to `~/.omp/agent/usage-data`.
- `gatherUserContext` reads omp's real surface: `config.yml` (YAML
  `modelRoles` and `retry.fallbackChains`), both `skills/` and
  `managed-skills/`, `extensions/`, `hooks/<event>/`, `mcp.json`, and
  `~/.claude/CLAUDE.md`.
- `PI_FEATURES_REFERENCE` rewritten as `OMP_FEATURES_REFERENCE` for omp's
  feature set. Getting this list wrong is the main way the report becomes
  useless, because the model can only suggest features it is told exist.
- Model calls go through an `omp -p` subprocess with the prompt on stdin. omp
  exposes credentials to extensions but no completion client; shelling out
  inherits every provider dialect and auth scheme omp supports instead of
  reimplementing them. Facet extraction runs on the `smol` role, sections and
  synthesis on the active model.
- Session metadata cache invalidated by a `size:mtime` signature over the
  primary log and every sidecar; caches namespaced per source.
- `multi_clauding` renamed to `concurrent_sessions` (harness-neutral).
- Session load cap raised from 200 to 2000; the corpus already exceeded it.

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
