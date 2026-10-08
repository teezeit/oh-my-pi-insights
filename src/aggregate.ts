// SPDX-FileCopyrightText: 2026 Hari Srinivasan <harisrini21@gmail.com>
// SPDX-FileCopyrightText: 2026 Tobias Hoelzer (omp port)
// SPDX-License-Identifier: AGPL-3.0-only


// Folds per-session SessionMeta + SessionFacets into one AggregatedData,
// plus the small numeric helpers (median/percentile/top8) other modules
// reuse for their own per-session percentiles.

import type { AggregatedData, SessionFacets, SessionMeta, TurnCorpusEntry, TurnPercentiles } from "./types.ts";

export const OVERLAP_WINDOW_MS = 30 * 60_000;

/** Sessions whose user messages interleave inside a 30-minute window. */
export function detectConcurrentSessions(
	sessions: Array<{ session_id: string; user_message_timestamps: string[] }>,
) {
	const all: Array<{ ts: number; sid: string }> = [];
	for (const s of sessions) {
		for (const iso of s.user_message_timestamps) {
			const ts = new Date(iso).getTime();
			if (!isNaN(ts)) all.push({ ts, sid: s.session_id });
		}
	}
	all.sort((a, b) => a.ts - b.ts);

	const pairs = new Set<string>();
	const duringMsgs = new Set<string>();
	let windowStart = 0;
	const sessionLastIdx = new Map<string, number>();

	for (let i = 0; i < all.length; i++) {
		const msg = all[i]!;
		while (
			windowStart < i &&
			msg.ts - all[windowStart]!.ts > OVERLAP_WINDOW_MS
		) {
			const exp = all[windowStart]!;
			if (sessionLastIdx.get(exp.sid) === windowStart)
				sessionLastIdx.delete(exp.sid);
			windowStart++;
		}
		const prevIdx = sessionLastIdx.get(msg.sid);
		if (prevIdx !== undefined) {
			for (let j = prevIdx + 1; j < i; j++) {
				const between = all[j]!;
				if (between.sid !== msg.sid) {
					const pair = [msg.sid, between.sid].sort().join(":");
					pairs.add(pair);
					duringMsgs.add(`${all[prevIdx]!.ts}:${msg.sid}`);
					duringMsgs.add(`${between.ts}:${between.sid}`);
					duringMsgs.add(`${msg.ts}:${msg.sid}`);
					break;
				}
			}
		}
		sessionLastIdx.set(msg.sid, i);
	}

	const involvedSessions = new Set<string>();
	for (const pair of pairs) {
		const [a, b] = pair.split(":");
		if (a) involvedSessions.add(a);
		if (b) involvedSessions.add(b);
	}

	return {
		overlap_events: pairs.size,
		sessions_involved: involvedSessions.size,
		user_messages_during: duringMsgs.size,
	};
}

// ─── Aggregation ──────────────────────────────────────────────────────────────

export function median(arr: number[]): number {
	if (!arr.length) return 0;
	const s = [...arr].sort((a, b) => a - b);
	const mid = Math.floor(s.length / 2);
	return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Nearest-rank percentile (p in [0,100]) over a full, unweighted sample. */
export function percentile(arr: number[], p: number): number {
	if (!arr.length) return 0;
	const sorted = [...arr].sort((a, b) => a - b);
	const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
	return sorted[idx]!;
}

/**
 * Weighted median: used to pool a per-session statistic (e.g. each session's
 * own turn p50 or p90) into one corpus-level number, weighted by how many
 * turns that session contributed. This is an approximation of the true
 * percentile over every individual turn, not an exact recomputation.
 */
export function weightedPercentile(pairs: Array<{ value: number; weight: number }>, p: number): number {
	const filtered = pairs.filter((v) => v.weight > 0);
	if (!filtered.length) return 0;
	const sorted = [...filtered].sort((a, b) => a.value - b.value);
	const totalWeight = sorted.reduce((s, v) => s + v.weight, 0);
	const target = totalWeight * (p / 100);
	let cumulative = 0;
	for (const v of sorted) {
		cumulative += v.weight;
		if (cumulative >= target) return v.value;
	}
	return sorted[sorted.length - 1]!.value;
}

export function mergeRecord(
	target: Record<string, number>,
	source: Record<string, number>,
) {
	for (const [k, v] of Object.entries(source)) {
		target[k] = (target[k] ?? 0) + v;
	}
}

export function top8(rec: Record<string, number>): [string, number][] {
	return Object.entries(rec)
		.sort((a, b) => b[1] - a[1])
		.slice(0, 8);
}

/**
 * Active hours per local calendar day: the union of every session's
 * activity runs (SessionMeta.active_intervals), split at local midnight.
 * Why: summing durations counted parallel sessions once each (198h/day), and
 * even a union of [start, end] read ~23h/day because sessions stay open for
 * days; only runs of actual message activity count.
 */
export function activeHoursByDay(metas: SessionMeta[]): Record<string, number> {
	const byDay = new Map<string, Array<[number, number]>>();
	for (const m of metas) {
		for (const [startIso, endIso] of m.active_intervals ?? []) {
			let start = Date.parse(startIso);
			const end = Date.parse(endIso);
			if (Number.isNaN(start) || Number.isNaN(end)) continue;
			while (start < end) {
				const d = new Date(start);
				const nextMidnight = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
				const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
				const segEnd = Math.min(end, nextMidnight);
				let list = byDay.get(key);
				if (!list) byDay.set(key, (list = []));
				list.push([start, segEnd]);
				start = segEnd;
			}
		}
	}
	const out: Record<string, number> = {};
	for (const key of [...byDay.keys()].sort()) {
		const intervals = byDay.get(key)!.sort((a, b) => a[0] - b[0]);
		let totalMs = 0;
		let [curStart, curEnd] = intervals[0]!;
		for (const [s, e] of intervals.slice(1)) {
			if (s > curEnd) {
				totalMs += curEnd - curStart;
				curStart = s;
				curEnd = e;
			} else if (e > curEnd) curEnd = e;
		}
		totalMs += curEnd - curStart;
		out[key] = totalMs / 3_600_000;
	}
	return out;
}

/**
 * B11: this tool's own development sessions (scanner port, friction-analysis
 * implementation) are naturally turn/tool-call heavy builds against this very
 * codebase, and would otherwise dominate worst-turn and friction signals
 * meant to reflect the user's other work. Follow-up revision: these sessions
 * must still count in every total (cost, tokens, sessions, active time, tool
 * rates, the manifest), so this matcher is no longer used to drop them from
 * the corpus before aggregation. aggregateData calls it internally to build
 * an isAnalysis set gating only the analysis-facing fields (worst turns,
 * facets merged into session summaries/friction, suggestion-evidence session
 * ids); computeTemporalData (anomalies, trajectory) still takes a
 * pre-filtered list from index.ts, since nothing there feeds a total.
 */
export function excludeToolingSessions(
	metas: SessionMeta[],
	excludeProjects: string[],
): SessionMeta[] {
	const needles = excludeProjects.map((p) => p.toLowerCase()).filter(Boolean);
	if (!needles.length) return metas;
	return metas.filter((m) => !needles.some((n) => m.project_path.toLowerCase().includes(n)));
}

export function aggregateData(
	metas: SessionMeta[],
	facetsMap: Map<string, SessionFacets>,
	excludeProjects: string[] = [],
): AggregatedData {
	const agg: AggregatedData = {
		total_sessions: metas.length,
		sessions_with_facets: 0,
		date_range: { start: "", end: "" },
		total_messages: 0,
		total_duration_hours: 0,
		active_hours_by_day: {},
		total_input_tokens: 0,
		total_output_tokens: 0,
		total_cost: 0,
		tool_counts: {},
		languages: {},
		git_commits: 0,
		git_pushes: 0,
		projects: {},
		goal_categories: {},
		outcomes: {},
		outcome_counts: {},
		sample_sizes: { satisfaction_signals: 0, friction_sessions: 0 },
		satisfaction: {},
		helpfulness: {},
		session_types: {},
		friction: {},
		success: {},
		session_summaries: [],
		friction_details: [],
		user_instructions: [],
		total_interruptions: 0,
		interruptions_aborted: 0,
		interruptions_steered: 0,
		total_tool_errors: 0,
		tool_error_categories: {},
		user_response_times: [],
		median_response_time: 0,
		avg_response_time: 0,
		sessions_using_subagent: 0,
		sessions_using_mcp: 0,
		total_lines_added: 0,
		total_lines_removed: 0,
		total_files_modified: 0,
		days_active: 0,
		message_hours: [],
		concurrent_sessions: {
			overlap_events: 0,
			sessions_involved: 0,
			user_messages_during: 0,
		},
		total_cost_primary: 0,
		total_cost_advisor: 0,
		total_cost_subagent: 0,
		total_utility_cost: 0,
		total_cache_read_tokens: 0,
		total_cache_write_tokens: 0,
		advisor_logs: 0,
		subagent_logs: 0,
		sessions_with_sidecars: 0,
		total_thinking_escalations: 0,
		total_model_switches: 0,
		total_compactions: 0,
		total_steering: 0,
		median_ttft_ms: 0,
		model_usage: {},
		model_efficiency: [],
		estimated_waste: 0,
		// ── friction-signal additions (interruptions, errors, tool-not-found) ──
		tool_calls_by_tool: {},
		tool_errors_by_tool: {},
		tool_not_found: {},
		error_classes: {},
		error_generations: 0,
		aborted_generations: 0,
		aborted_at_session_end: 0,
		ttsr_injections: 0,
		ttsr_rules: {},
		reset_boundaries: 0,
		interruption_rate: 0,
		tool_error_rate_table: [],
		abort_labels: {},
		total_turns: 0,
		turn_p50: { round_trips: 0, tool_calls: 0, exploration: 0, wall_sec: 0 },
		turn_p90: { round_trips: 0, tool_calls: 0, exploration: 0, wall_sec: 0 },
		worst_turns_corpus: [],
		tool_duration_by_tool: {},
		tool_time_share: [],
		tool_calls_with_intent: 0,
		cache_hit_ratio: 0,
		worst_cache_sessions: [],
		most_churned_files: [],
	};

	const dates: string[] = [];
	const activeDays = new Set<string>();
	const turnCorpusCandidates: TurnCorpusEntry[] = [];
	const p50Pairs = {
		round_trips: [] as Array<{ value: number; weight: number }>,
		tool_calls: [] as Array<{ value: number; weight: number }>,
		exploration: [] as Array<{ value: number; weight: number }>,
		wall_sec: [] as Array<{ value: number; weight: number }>,
	};
	const p90Pairs = {
		round_trips: [] as Array<{ value: number; weight: number }>,
		tool_calls: [] as Array<{ value: number; weight: number }>,
		exploration: [] as Array<{ value: number; weight: number }>,
		wall_sec: [] as Array<{ value: number; weight: number }>,
	};
	const toolDurationAcc = new Map<
		string,
		{ calls: number; total_sec: number; p50Pairs: Array<{ value: number; weight: number }>; p90Pairs: Array<{ value: number; weight: number }> }
	>();
	const churnAcc = new Map<string, { edits: number; sessions: Set<string> }>();
	// Tooling sessions stay in every total (cost, tokens, sessions, active
	// time, tool rates, the manifest) but must not pollute the signals that
	// feed the model's narrative: worst turns, friction, facets merged into
	// session summaries, and the suggestion-evidence session ids
	// (worst_cache_sessions). See excludeToolingSessions for the match rule.
	const isAnalysis = new Set(excludeToolingSessions(metas, excludeProjects).map((m) => m.session_id));

	// Decay weighting: half-life of 10 days for facet-derived charts
	const latestTs = metas.reduce((max, m) => {
		const t = new Date(m.start_time).getTime();
		return t > max ? t : max;
	}, 0);
	const HALF_LIFE_MS = 10 * 86400000;
	const LAMBDA = Math.log(2) / HALF_LIFE_MS;

	function decayWeight(meta: SessionMeta): number {
		const age = latestTs - new Date(meta.start_time).getTime();
		return Math.exp(-LAMBDA * age);
	}

	function mergeWeighted(target: Record<string, number>, source: Record<string, number>, weight: number) {
		for (const [k, v] of Object.entries(source)) {
			target[k] = (target[k] ?? 0) + v * weight;
		}
	}

	for (const meta of metas) {
		agg.total_messages += meta.user_message_count;
		agg.total_input_tokens += meta.input_tokens;
		agg.total_output_tokens += meta.output_tokens;
		agg.total_cost += meta.total_cost;
		mergeRecord(agg.tool_counts, meta.tool_counts);
		mergeRecord(agg.languages, meta.languages);
		mergeRecord(agg.tool_error_categories, meta.tool_error_categories);
		agg.git_commits += meta.git_commits;
		agg.git_pushes += meta.git_pushes;
		agg.total_tool_errors += meta.tool_errors;
		agg.total_lines_added += meta.lines_added;
		agg.total_lines_removed += meta.lines_removed;
		agg.total_files_modified += meta.files_modified;
		agg.user_response_times.push(...meta.user_response_times);
		agg.message_hours.push(...meta.message_hours);
		if (meta.uses_subagent) agg.sessions_using_subagent++;
		if (meta.uses_mcp) agg.sessions_using_mcp++;
		agg.total_cost_primary += meta.cost_primary;
		agg.total_cost_advisor += meta.cost_advisor;
		agg.total_cost_subagent += meta.cost_subagent;
		agg.total_utility_cost += meta.utility_cost;
		agg.total_cache_read_tokens += meta.cache_read_tokens;
		agg.total_cache_write_tokens += meta.cache_write_tokens;
		agg.advisor_logs += meta.sidecar_counts.advisor;
		agg.subagent_logs += meta.sidecar_counts.subagent;
		if (meta.sidecar_counts.advisor + meta.sidecar_counts.subagent > 0)
			agg.sessions_with_sidecars++;
		agg.total_thinking_escalations += meta.thinking_escalations;
		agg.total_model_switches += meta.model_switches;
		agg.total_compactions += meta.compactions;
		agg.total_steering += meta.steering_messages;
		mergeRecord(agg.tool_calls_by_tool, meta.tool_calls_by_tool);
		agg.tool_calls_with_intent += meta.tool_calls_with_intent;
		mergeRecord(agg.tool_errors_by_tool, meta.tool_errors_by_tool);
		mergeRecord(agg.tool_not_found, meta.tool_not_found);
		mergeRecord(agg.error_classes, meta.error_classes);
		mergeRecord(agg.ttsr_rules, meta.ttsr_rules);
		agg.error_generations += meta.error_generations;
		agg.aborted_generations += meta.aborted_generations;
		agg.aborted_at_session_end += meta.aborted_at_session_end;
		agg.ttsr_injections += meta.ttsr_injections;
		agg.reset_boundaries += meta.reset_boundaries;
		agg.total_turns += meta.turn_count;
		if (meta.turn_count > 0) {
			const w = meta.turn_count;
			p50Pairs.round_trips.push({ value: meta.turn_p50.round_trips, weight: w });
			p50Pairs.tool_calls.push({ value: meta.turn_p50.tool_calls, weight: w });
			p50Pairs.exploration.push({ value: meta.turn_p50.exploration, weight: w });
			p50Pairs.wall_sec.push({ value: meta.turn_p50.wall_sec, weight: w });
			p90Pairs.round_trips.push({ value: meta.turn_p90.round_trips, weight: w });
			p90Pairs.tool_calls.push({ value: meta.turn_p90.tool_calls, weight: w });
			p90Pairs.exploration.push({ value: meta.turn_p90.exploration, weight: w });
			p90Pairs.wall_sec.push({ value: meta.turn_p90.wall_sec, weight: w });
		}
		const project = meta.project_path.replace(/.*\//, "") || meta.project_path;
		// Worst turns feed the "worst turns across the corpus" prompt input;
		// a tooling session's heavy refactor turns must not crowd it out.
		if (isAnalysis.has(meta.session_id)) {
			for (const t of meta.worst_turns) {
				turnCorpusCandidates.push({
					session_id: meta.session_id,
					project,
					prompt: t.prompt,
					llm_round_trips: t.llm_round_trips,
					tool_calls: t.tool_calls,
					exploration_before_first_mutation: t.exploration_before_first_mutation,
					wall_sec: t.wall_sec,
					cost: t.cost,
				});
			}
		}
		for (const [tool, d] of Object.entries(meta.tool_duration_by_tool)) {
			let acc = toolDurationAcc.get(tool);
			if (!acc) {
				acc = { calls: 0, total_sec: 0, p50Pairs: [], p90Pairs: [] };
				toolDurationAcc.set(tool, acc);
			}
			acc.calls += d.calls;
			acc.total_sec += d.total_sec;
			acc.p50Pairs.push({ value: d.p50_sec, weight: d.calls });
			acc.p90Pairs.push({ value: d.p90_sec, weight: d.calls });
		}
		for (const [path, count] of Object.entries(meta.edits_by_file)) {
			let churn = churnAcc.get(path);
			if (!churn) {
				churn = { edits: 0, sessions: new Set() };
				churnAcc.set(path, churn);
			}
			churn.edits += count;
			churn.sessions.add(meta.session_id);
		}

		// Aggregate per-model usage
		for (const [model, usage] of Object.entries(meta.model_usage ?? {})) {
			const slot = (agg.model_usage[model] ??= { input_tokens: 0, output_tokens: 0, cost: 0, message_count: 0, cost_input: 0, cost_output: 0, sessions: 0 });
			slot.input_tokens += usage.input_tokens;
			slot.output_tokens += usage.output_tokens;
			slot.cost += usage.cost;
			slot.message_count += usage.message_count;
			slot.cost_input = (slot.cost_input ?? 0) + (usage.cost_input ?? 0);
			slot.cost_output = (slot.cost_output ?? 0) + (usage.cost_output ?? 0);
			slot.sessions++;
		}

		if (meta.start_time) {
			dates.push(meta.start_time);
			activeDays.add(meta.start_time.slice(0, 10));
		}

		if (meta.project_path) {
			const proj = meta.project_path.replace(/.*\//, "") || meta.project_path;
			agg.projects[proj] = (agg.projects[proj] ?? 0) + 1;
		}

		const facets = facetsMap.get(meta.session_id);
		// Abort events have no reliable structural label; prefer the facet LLM's
		// per-event judgment (matched by timestamp) over the cheap heuristic.
		for (const ev of meta.abort_events) {
			const llmLabel = facets?.abort_labels?.find((l) => l.ts === ev.ts)?.label;
			const label = llmLabel || ev.heuristic_label;
			agg.abort_labels[label] = (agg.abort_labels[label] ?? 0) + 1;
		}
		if (facets) {
			agg.sessions_with_facets++;
			// Everything below is narrative-facing (session summaries, friction
			// counts/details, goal/outcome/satisfaction merges feeding the
			// section prompts): a tooling session counts toward facet coverage
			// above, but its facets must not shape what the model is told
			// happened to the user.
			if (!isAnalysis.has(meta.session_id)) continue;
			const w = decayWeight(meta);
			mergeWeighted(agg.goal_categories, facets.goal_categories, w);
			if (facets.outcome) {
				agg.outcomes[facets.outcome] = (agg.outcomes[facets.outcome] ?? 0) + w;
				agg.outcome_counts[facets.outcome] = (agg.outcome_counts[facets.outcome] ?? 0) + 1;
			}
			mergeWeighted(agg.satisfaction, facets.user_satisfaction_counts, w);
			agg.sample_sizes.satisfaction_signals += Object.values(facets.user_satisfaction_counts ?? {}).reduce((a, b) => a + b, 0);
			if (Object.values(facets.friction_counts ?? {}).some((v) => v > 0)) agg.sample_sizes.friction_sessions++;
			if (facets.assistant_helpfulness)
				agg.helpfulness[facets.assistant_helpfulness] =
					(agg.helpfulness[facets.assistant_helpfulness] ?? 0) + w;
			if (facets.session_type)
				agg.session_types[facets.session_type] =
					(agg.session_types[facets.session_type] ?? 0) + w;
			mergeWeighted(agg.friction, facets.friction_counts, w);
			if (facets.primary_success && facets.primary_success !== "none") {
				agg.success[facets.primary_success] =
					(agg.success[facets.primary_success] ?? 0) + w;
			}
			agg.session_summaries.push({
				id: meta.session_id.slice(0, 8),
				date: meta.start_time.slice(0, 10),
				summary: facets.brief_summary,
				outcome: facets.outcome,
				helpfulness: facets.assistant_helpfulness,
			});
			if (facets.friction_detail?.trim())
				agg.friction_details.push(facets.friction_detail.trim());
			if (facets.user_instructions_to_assistant) {
				agg.user_instructions.push(...facets.user_instructions_to_assistant);
			}
		}
	}

	// Pooled approximation (see the AggregatedData comment): the weighted
	// median of each session's own p50/p90, not a true recomputation over
	// every individual turn.
	agg.turn_p50 = {
		round_trips: weightedPercentile(p50Pairs.round_trips, 50),
		tool_calls: weightedPercentile(p50Pairs.tool_calls, 50),
		exploration: weightedPercentile(p50Pairs.exploration, 50),
		wall_sec: weightedPercentile(p50Pairs.wall_sec, 50),
	};
	agg.turn_p90 = {
		round_trips: weightedPercentile(p90Pairs.round_trips, 50),
		tool_calls: weightedPercentile(p90Pairs.tool_calls, 50),
		exploration: weightedPercentile(p90Pairs.exploration, 50),
		wall_sec: weightedPercentile(p90Pairs.wall_sec, 50),
	};
	agg.worst_turns_corpus = turnCorpusCandidates
		.sort((a, b) => b.tool_calls - a.tool_calls)
		.slice(0, 5);

	// Same pooled-weighted-median approximation as turn_p50/p90 above, applied
	// per tool name instead of to a fixed set of four metrics.
	for (const [tool, acc] of toolDurationAcc) {
		agg.tool_duration_by_tool[tool] = {
			calls: acc.calls,
			total_sec: acc.total_sec,
			p50_sec: weightedPercentile(acc.p50Pairs, 50),
			p90_sec: weightedPercentile(acc.p90Pairs, 50),
		};
	}
	const totalToolSec = Object.values(agg.tool_duration_by_tool).reduce((a, d) => a + d.total_sec, 0);
	agg.tool_time_share = Object.entries(agg.tool_duration_by_tool)
		.map(([tool, d]) => ({
			tool,
			total_sec: d.total_sec,
			share: totalToolSec > 0 ? d.total_sec / totalToolSec : 0,
		}))
		.sort((a, b) => b.share - a.share);

	// Token-weighted: recomputed from the already-summed corpus totals (which
	// include sidecar tokens), not an average of the per-session ratios
	// (which are primary-session-only). Both are reasonable; mixing them
	// here is a minor, documented approximation.
	agg.cache_hit_ratio =
		agg.total_input_tokens + agg.total_cache_read_tokens > 0
			? agg.total_cache_read_tokens / (agg.total_input_tokens + agg.total_cache_read_tokens)
			: 0;
	// Cited as suggestion evidence (session_id), so tooling sessions are
	// excluded here too, not just from worst_turns_corpus.
	agg.worst_cache_sessions = metas
		.filter((m) => isAnalysis.has(m.session_id))
		.map((m) => {
			const tokens = m.input_tokens + m.cache_read_tokens;
			// Derived fresh from the always-reliable persisted token counts
			// rather than trusting m.cache_hit_ratio: that field can be stale
			// for metas assembled by overriding token counts without
			// recomputing the derived ratio (as some test fixtures do), not
			// just for pre-this-change cache entries.
			return {
				session_id: m.session_id,
				project: m.project_path.replace(/.*\//, "") || m.project_path,
				ratio: tokens > 0 ? m.cache_read_tokens / tokens : 0,
				tokens,
				cost: m.total_cost,
			};
		})
		.filter((s) => s.tokens >= 50_000)
		.sort((a, b) => a.ratio - b.ratio)
		.slice(0, 5);

	agg.most_churned_files = [...churnAcc.entries()]
		.map(([path, v]) => ({ path, edits: v.edits, sessions: v.sessions.size }))
		.sort((a, b) => b.edits - a.edits)
		.slice(0, 10);

	dates.sort();
	agg.date_range = {
		start: dates[0]?.slice(0, 10) ?? "",
		end: dates[dates.length - 1]?.slice(0, 10) ?? "",
	};
	agg.days_active = activeDays.size;
	agg.median_response_time = median(agg.user_response_times);
	agg.avg_response_time = agg.user_response_times.length
		? agg.user_response_times.reduce((a, b) => a + b, 0) /
			agg.user_response_times.length
		: 0;

	// Interruption rate: aborted mid-flight or corrected via steering, per
	// human message. A trailing abort with no next message (session just
	// ended there) is excluded; there was no further request to interrupt.
	agg.interruptions_aborted = agg.aborted_generations - agg.aborted_at_session_end;
	agg.interruptions_steered = agg.total_steering;
	agg.total_interruptions = agg.interruptions_aborted + agg.interruptions_steered;
	agg.interruption_rate = agg.total_messages > 0 ? agg.total_interruptions / agg.total_messages : 0;

	agg.active_hours_by_day = activeHoursByDay(metas);
	agg.total_duration_hours = Object.values(agg.active_hours_by_day).reduce((a, b) => a + b, 0);

	// Per-tool error rate, excluding tool_not_found misfires from both sides
	// of the ratio. Floored at 5 calls so a single unlucky call can't read as
	// a 100% failure rate.
	agg.tool_error_rate_table = Object.entries(agg.tool_calls_by_tool)
		.map(([tool, calls]) => {
			const errors = agg.tool_errors_by_tool[tool] ?? 0;
			return { tool, calls, errors, rate: calls > 0 ? errors / calls : 0 };
		})
		.filter((r) => r.calls >= 5)
		.sort((a, b) => b.rate - a.rate);

	// Trim to caps
	agg.session_summaries = agg.session_summaries.slice(-50);
	agg.friction_details = agg.friction_details.slice(0, 20);
	agg.user_instructions = agg.user_instructions.slice(0, 15);

	agg.median_ttft_ms = median(
		metas.map((m) => m.median_ttft_ms).filter((v) => v > 0),
	);

	agg.concurrent_sessions = detectConcurrentSessions(
		metas.map((m) => ({
			session_id: m.session_id,
			user_message_timestamps: m.user_message_timestamps,
		})),
	);

	// Model efficiency analysis
	// Classify models by their implied list price (see AggregatedData
	// model_usage.list_price), never by blended cost per token: that rate
	// mixes cache reads in and ranked identically priced models apart.
	// Models with negligible cost (subscriptions like Mistral Pro, ChatGPT Plus)
	// are classified as "subscription" and excluded from cost optimization recommendations.
	const MODEL_TIERS: Record<string, "high" | "mid" | "low" | "subscription"> = {};
	const INPUT_PRICE: Record<string, number> = {}; // implied list $ per Mtok uncached input
	for (const [model, u] of Object.entries(agg.model_usage)) {
		const perMtok = (cost: number | undefined, tokens: number) =>
			cost && tokens > 0 ? Math.round((cost / tokens) * 1e6 * 1e4) / 1e4 : 0;
		const input = perMtok(u.cost_input, u.input_tokens);
		const output = perMtok(u.cost_output, u.output_tokens);
		u.list_price = input || output ? { input_per_mtok: input, output_per_mtok: output } : null;
		if (input > 0) INPUT_PRICE[model] = input;
	}

	// Derive tiers from the list-price distribution
	const priceValues = Object.values(INPUT_PRICE).sort((a, b) => a - b);
	const priceMedian = priceValues.length ? priceValues[Math.floor(priceValues.length / 2)]! : 0;

	const classifyModel = (name: string): "high" | "mid" | "low" | "subscription" => {
		if (MODEL_TIERS[name]) return MODEL_TIERS[name]!;
		const price = INPUT_PRICE[name];
		// Subscription detection: no cost recorded despite significant usage
		// (fixed monthly plans)
		const aggUsage = agg.model_usage[name];
		if (aggUsage && (aggUsage.input_tokens + aggUsage.output_tokens) > 10000 && aggUsage.cost < 0.01) {
			MODEL_TIERS[name] = "subscription";
			return "subscription";
		}
		if (!price) {
			if (aggUsage && aggUsage.cost > 0) {
				// Cost recorded but no per-component split: price unknown, not cheap.
				MODEL_TIERS[name] = "mid";
				return "mid";
			}
			// Zero cost: subscription or free tier
			if (aggUsage && aggUsage.message_count > 20) {
				MODEL_TIERS[name] = "subscription";
				return "subscription";
			}
			MODEL_TIERS[name] = "low";
			return "low";
		}
		// Classify relative to the median implied list price
		if (price > priceMedian * 3) {
			MODEL_TIERS[name] = "high";
		} else if (price < priceMedian * 0.4) {
			MODEL_TIERS[name] = "low";
		} else {
			MODEL_TIERS[name] = "mid";
		}
		return MODEL_TIERS[name]!;
	};

	const COMPLEX_TYPES = new Set(["multi_task", "iterative_refinement"]);
	const SIMPLE_TYPES = new Set(["quick_question", "single_task"]);

	let estimatedWaste = 0;

	for (const meta of metas) {
		const facets = facetsMap.get(meta.session_id);
		if (!facets) continue;

		// Determine primary model (highest cost or most messages)
		const models = Object.entries(meta.model_usage ?? {});
		if (!models.length) continue;
		const primaryModel = models.sort((a, b) => b[1].cost - a[1].cost)[0]!;
		const [modelName, modelStats] = primaryModel;
		const tier = classifyModel(modelName);

		const isSimple = SIMPLE_TYPES.has(facets.session_type)
			|| (meta.user_message_count <= 3 && meta.duration_minutes < 5);
		const isComplex = COMPLEX_TYPES.has(facets.session_type)
			|| meta.user_message_count > 8
			|| meta.files_modified > 5;
		const poorOutcome = facets.outcome === "not_achieved" || facets.outcome === "partially_achieved";
		const goodOutcome = facets.outcome === "fully_achieved" || facets.outcome === "mostly_achieved";

		let flag: "overspend" | "underspend" | "quota_pressure" | "ok" = "ok";
		let reason = "";

		// Subscription models: no dollar cost, but quota is finite.
		// Within a subscription plan, heavier models consume more quota (messages,
		// tokens, or rate limit budget) than lighter ones. For example:
		// - Mistral Pro: Medium 3.5 uses more of message quota than Small
		// - OpenAI Plus: o1/o3 burn cap faster than GPT-4o-mini
		// - Google: Pro uses more TPM budget than Flash
		// Flag when a subscription's heavier model is used for trivial tasks.
		if (tier === "subscription") {
			if (isSimple && goodOutcome && modelStats.message_count > 3) {
				// Check if there's a lighter subscription model available from the same provider
				const modelLower = modelName.toLowerCase();
				const provider = modelLower.includes("mistral") ? "mistral"
					: modelLower.includes("gpt") || modelLower.includes("o1") || modelLower.includes("o3") ? "openai"
					: modelLower.includes("gemini") ? "google"
					: modelLower.includes("claude") ? "anthropic" : "unknown";
				
				// Detect if this is a "heavy" model within its subscription
				const isHeavySubscription = /medium|large|pro|opus|o[13]/i.test(modelLower)
					&& !/small|mini|flash|haiku|lite/i.test(modelLower);
				
				if (isHeavySubscription) {
					flag = "quota_pressure";
					reason = `Used ${modelName} (subscription) for a simple ${facets.session_type}. Within your plan, this model consumes more quota than lighter alternatives. Consider using a smaller model from the same subscription (e.g. ${provider === "mistral" ? "Mistral Small" : provider === "openai" ? "GPT-4o-mini" : provider === "google" ? "Gemini Flash" : "a lighter tier"}) for trivial tasks, or offload to a cheap PAYG model to preserve quota for complex work.`;
				} else {
					// Already using a light subscription model for simple tasks: this is fine
					// No flag needed
				}
			}
		}
		// PAYG overspend: expensive model on simple task
		else if (tier === "high" && isSimple && goodOutcome) {
			flag = "overspend";
			reason = `Used ${modelName} for a simple ${facets.session_type} that completed successfully. A lower-tier model would likely suffice.`;
			estimatedWaste += modelStats.cost * 0.8;
		}
		// PAYG underspend: low-tier model on complex task with poor outcome
		else if (tier === "low" && isComplex && poorOutcome) {
			flag = "underspend";
			reason = `Used ${modelName} for a complex ${facets.session_type} that ended with ${facets.outcome}. A more capable model may have succeeded.`;
			estimatedWaste += modelStats.cost;
		}
		// PAYG overspend: expensive model on ANY task with poor outcome (wasted tokens)
		else if (tier === "high" && poorOutcome && modelStats.cost > 0.10) {
			flag = "overspend";
			reason = `Spent $${modelStats.cost.toFixed(2)} on ${modelName} but outcome was ${facets.outcome}. Tokens were burned without reaching the goal.`;
			estimatedWaste += modelStats.cost * 0.5;
		}

		if (flag !== "ok") {
			agg.model_efficiency.push({
				model: modelName,
				session_id: meta.session_id,
				date: meta.start_time.slice(0, 10),
				cost: modelStats.cost,
				outcome: facets.outcome,
				session_type: facets.session_type,
				goal: facets.underlying_goal?.slice(0, 80) ?? "",
				flag,
				reason,
			});
		}
	}

	agg.estimated_waste = estimatedWaste;
	agg.model_efficiency.sort((a, b) => b.cost - a.cost);
	agg.model_efficiency = agg.model_efficiency.slice(0, 20);

	// Annotate model_usage with tier info for downstream prompts
	for (const [model, usage] of Object.entries(agg.model_usage)) {
		usage.tier = MODEL_TIERS[model] || "mid";
	}

	return agg;
}
