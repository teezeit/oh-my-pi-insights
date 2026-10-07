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
