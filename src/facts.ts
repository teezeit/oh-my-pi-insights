// SPDX-FileCopyrightText: 2026 Tobias Hoelzer (omp port)
// SPDX-License-Identifier: AGPL-3.0-only


// The report's single source of numbers. Every percentage and dollar amount
// the LLM sections may quote is computed here, in TS, with its definition,
// sample size and window. The prompts receive this list read-only and are
// told to quote it; checkFacts then scans the generated prose and flags any
// percentage or dollar amount no fact backs.
//
// Checker scope (v1, decided): percentages and $ amounts only. Bare integers
// are NOT checked. Why: prose legitimately quotes per-session counts (round
// trips, p90 tool calls, edits on one file) that are too numerous to list
// and too easy to collide with by accident, so checking them would either
// flood with false flags or pass everything. Known blind spot: a wrong count
// ("133 round trips") or a per-item dollar figure the LLM derived itself
// ("$16.48 per ticket") is only caught if it is a $ amount; wrong bare counts
// go through unflagged.

import type { AggregatedData, TemporalData } from "./types.ts";

export type Fact = {
	id: string;
	/** pct facts are in percent (7.3 means 7.3%), usd in dollars. */
	value: number;
	unit: "pct" | "usd" | "count" | "hours";
	definition: string;
	n: number;
	population: string;
	window: string;
};

export type FactFlag = {
	/** Dotted path into the sections object, e.g. "friction_analysis.intro". */
	path: string;
	value: number;
	unit: "pct" | "usd";
	excerpt: string;
};

// Tolerances: +-1 percentage point, and for dollars the larger of 1% of the
// fact or half a unit of the precision the prose printed ("$124" ~ 123.45).
const PCT_TOLERANCE_POINTS = 1;
const USD_TOLERANCE_RATIO = 0.01;

export function buildFacts(agg: AggregatedData, temporal: TemporalData): Fact[] {
	const facts: Fact[] = [];
	const window = `${agg.date_range.start}..${agg.date_range.end}`;
	const add = (id: string, value: number, unit: Fact["unit"], definition: string, n: number, population: string, w = window) => {
		if (!Number.isFinite(value)) return;
		facts.push({ id, value: unit === "usd" ? Math.round(value * 100) / 100 : Math.round(value * 10) / 10, unit, definition, n, population, window: w });
	};
	const share = (part: number, whole: number) => (whole > 0 ? (part / whole) * 100 : 0);
	const sessions = agg.total_sessions;
	const activeDays = Object.keys(agg.active_hours_by_day).length;

	add("sessions", sessions, "count", "substantive sessions in the report", sessions, "sessions");
	add("messages", agg.total_messages, "count", "human messages", sessions, "sessions");
	add("active_hours", agg.total_duration_hours, "hours", "union of session intervals per day; parallel sessions counted once", sessions, "sessions");
	add("active_hours_per_day", activeDays ? agg.total_duration_hours / activeDays : 0, "hours", "active hours / days with activity", activeDays, "active days");
	add("interruptions", agg.total_interruptions, "count", "mid-session aborts + steering messages", agg.total_messages, "human messages");
	add("interruptions.aborted", agg.interruptions_aborted, "count", "aborts not at session end", agg.total_messages, "human messages");
	add("interruptions.steered", agg.interruptions_steered, "count", "steering messages", agg.total_messages, "human messages");
	add("interruption_rate", agg.interruption_rate * 100, "pct", "(mid-session aborts + steering) / human messages", agg.total_messages, "human messages");

	const outcomeN = Object.values(agg.outcome_counts).reduce((a, b) => a + b, 0);
	if (outcomeN > 0) {
		const achieved = (agg.outcome_counts.fully_achieved ?? 0) + (agg.outcome_counts.mostly_achieved ?? 0);
		add("success_rate", share(achieved, outcomeN), "pct", "fully or mostly achieved / sessions with an outcome facet (unweighted)", outcomeN, "sessions with facets");
		for (const [k, v] of Object.entries(agg.outcome_counts))
			add(`outcome_share.${k}`, share(v, outcomeN), "pct", `sessions with outcome ${k} (unweighted)`, outcomeN, "sessions with facets");
	}

	add("cache_hit_ratio", agg.cache_hit_ratio * 100, "pct", "cacheRead / (input + cacheRead) tokens", sessions, "sessions");
	for (const s of agg.worst_cache_sessions) {
		add(`cache_hit_ratio.session.${s.session_id.slice(0, 8)}`, s.ratio * 100, "pct", `cache hit ratio of one session in ${s.project}`, 1, "session");
		add(`cost.session.${s.session_id.slice(0, 8)}`, s.cost, "usd", `cost of one session in ${s.project}`, 1, "session");
	}

	const toolCalls = Object.values(agg.tool_calls_by_tool).reduce((a, b) => a + b, 0);
	add("tool_errors", agg.total_tool_errors, "count", "tool results with isError", toolCalls, "tool calls");
	add("tool_error_rate", share(agg.total_tool_errors, toolCalls), "pct", "failed tool calls / tool calls", toolCalls, "tool calls");
	for (const r of agg.tool_error_rate_table)
		add(`tool_error_rate.${r.tool}`, r.rate * 100, "pct", `failed / calls for ${r.tool} (browser includes eval calls driving the browser global)`, r.calls, `${r.tool} calls`);
	for (const t of agg.tool_time_share.slice(0, 10))
		add(`tool_time_share.${t.tool}`, t.share * 100, "pct", `${t.tool} share of measured tool wall clock`, sessions, "sessions");

	add("total_cost", agg.total_cost, "usd", "sum of recorded cost (primary + advisor + subagent)", sessions, "sessions");
	add("cost_per_session", sessions ? agg.total_cost / sessions : 0, "usd", "total cost / sessions", sessions, "sessions");
	add("cost.primary", agg.total_cost_primary, "usd", "primary-session cost", sessions, "sessions");
	add("cost.advisor", agg.total_cost_advisor, "usd", "advisor sidecar cost", sessions, "sessions");
	add("cost.subagent", agg.total_cost_subagent, "usd", "subagent sidecar cost", sessions, "sessions");
	add("cost.utility", agg.total_utility_cost, "usd", "out-of-band model_usage cost (titles, auto-thinking)", sessions, "sessions");
	add("cost_share.primary", share(agg.total_cost_primary, agg.total_cost), "pct", "primary cost / total cost", sessions, "sessions");
	add("cost_share.advisor", share(agg.total_cost_advisor, agg.total_cost), "pct", "advisor cost / total cost", sessions, "sessions");
	add("cost_share.subagent", share(agg.total_cost_subagent, agg.total_cost), "pct", "subagent cost / total cost", sessions, "sessions");
	for (const [model, u] of Object.entries(agg.model_usage)) {
		add(`model_cost.${model}`, u.cost, "usd", `recorded cost on ${model}`, u.sessions, "sessions using the model");
		add(`model_cost_share.${model}`, share(u.cost, agg.total_cost), "pct", `${model} cost / total cost`, u.sessions, "sessions using the model");
		if (u.list_price) {
			add(`list_price.input.${model}`, u.list_price.input_per_mtok, "usd", `implied list price per Mtok uncached input on ${model}`, u.sessions, "sessions using the model");
			add(`list_price.output.${model}`, u.list_price.output_per_mtok, "usd", `implied list price per Mtok output on ${model}`, u.sessions, "sessions using the model");
		}
	}
	add("estimated_waste", agg.estimated_waste, "usd", "heuristic model-mismatch waste over flagged sessions", agg.model_efficiency.length, "flagged sessions");
	for (const e of agg.model_efficiency)
		add(`model_efficiency.${e.session_id.slice(0, 8)}`, e.cost, "usd", `cost of a ${e.flag} session on ${e.model}`, 1, "session");
	for (const t of agg.worst_turns_corpus)
		add(`worst_turn.${t.session_id.slice(0, 8)}`, t.cost, "usd", `cost of one turn in ${t.project}`, 1, "turn");

	add("subagent_session_share", share(agg.sessions_using_subagent, sessions), "pct", "sessions that spawned subagents / sessions", sessions, "sessions");
	add("mcp_session_share", share(agg.sessions_using_mcp, sessions), "pct", "sessions that used MCP / sessions", sessions, "sessions");
	const projectTotal = Object.values(agg.projects).reduce((a, b) => a + b, 0);
	for (const [p, v] of Object.entries(agg.projects))
		add(`project_share.${p}`, share(v, projectTotal), "pct", `sessions in ${p} / sessions`, projectTotal, "sessions");

	// Facet distributions are decay-weighted (10-day half-life), so their
	// shares are of the weighted total; n is the unweighted session count.
	const facetDists: Array<[string, Record<string, number>]> = [
		["goal_share", agg.goal_categories],
		["session_type_share", agg.session_types],
		["satisfaction_share", agg.satisfaction],
		["friction_share", agg.friction],
		["helpfulness_share", agg.helpfulness],
	];
	for (const [prefix, dist] of facetDists) {
		const total = Object.values(dist).reduce((a, b) => a + b, 0);
		for (const [k, v] of Object.entries(dist))
			add(`${prefix}.${k}`, share(v, total), "pct", `decay-weighted share of ${k}`, agg.sessions_with_facets, "sessions with facets");
	}

	const d = temporal.delta;
	if (d) {
		const w = `${d.before.start}..${d.before.end} vs ${d.after.start}..${d.after.end}`;
		const n = d.before.sessions + d.after.sessions;
		add("delta.cost_per_session", d.cost_per_session.pct, "pct", `change in mean cost per session (${d.basis})`, n, "sessions", w);
		add("delta.errors_per_session", d.errors_per_session.pct, "pct", `change in mean tool errors per session (${d.basis})`, n, "sessions", w);
		add("delta.cost_per_session.before", d.cost_per_session.before, "usd", "mean cost per session, before window", d.before.sessions, "sessions", w);
		add("delta.cost_per_session.after", d.cost_per_session.after, "usd", "mean cost per session, after window", d.after.sessions, "sessions", w);
	}
	for (const a of temporal.anomalies)
		add(`anomaly.${a.date}`, Number(a.cost.slice(1)), "usd", "cost of an outlier session", 1, "session", a.date);

	return facts;
}

const NUM = String.raw`(\d[\d,]*(?:\.\d+)?)`;
// "40-60%" and "40 to 60%" carry two percentages; "-43%" carries one.
const PCT_RE = new RegExp(`${NUM}(?:\\s*(?:-|to)\\s*${NUM})?\\s*%`, "g");
const USD_RE = new RegExp(String.raw`\$\s?${NUM}\s*([kKmM]\b)?`, "g");

/**
 * Flags every percentage and dollar amount in the section prose that is not
 * within tolerance of some fact. Signs are ignored: "down 43%" and "-43%"
 * both compare as 43 against |fact|.
 */
export function checkFacts(sections: Record<string, unknown>, facts: Fact[]): FactFlag[] {
	const pcts = facts.filter((f) => f.unit === "pct").map((f) => Math.abs(f.value));
	const usds = facts.filter((f) => f.unit === "usd").map((f) => Math.abs(f.value));
	const flags: FactFlag[] = [];
	const excerpt = (text: string, at: number) => text.slice(Math.max(0, at - 40), at + 40).trim();
	const parse = (s: string) => Number(s.replace(/,/g, ""));

	const visit = (value: unknown, path: string) => {
		if (typeof value === "string") {
			for (const m of value.matchAll(PCT_RE)) {
				for (const raw of [m[1], m[2]]) {
					if (raw === undefined) continue;
					const v = parse(raw);
					if (!pcts.some((p) => Math.abs(p - v) <= PCT_TOLERANCE_POINTS))
						flags.push({ path, value: v, unit: "pct", excerpt: excerpt(value, m.index!) });
				}
			}
			for (const m of value.matchAll(USD_RE)) {
				const scale = m[2] ? (m[2].toLowerCase() === "k" ? 1_000 : 1_000_000) : 1;
				const v = parse(m[1]!) * scale;
				const decimals = m[1]!.split(".")[1]?.length ?? 0;
				const printedHalfUnit = 0.5 * 10 ** -decimals * scale;
				if (!usds.some((u) => Math.abs(u - v) <= Math.max(u * USD_TOLERANCE_RATIO, printedHalfUnit)))
					flags.push({ path, value: v, unit: "usd", excerpt: excerpt(value, m.index!) });
			}
		} else if (Array.isArray(value)) {
			value.forEach((v, i) => visit(v, path ? `${path}.${i}` : String(i)));
		} else if (value && typeof value === "object") {
			for (const [k, v] of Object.entries(value)) visit(v, path ? `${path}.${k}` : k);
		}
	};
	visit(sections, "");
	return flags;
}

/** The facts block handed to every section prompt, one fact per line. */
export function formatFactsForPrompt(facts: Fact[]): string {
	return facts
		.map((f) => {
			const shown = f.unit === "pct" ? `${f.value}%` : f.unit === "usd" ? `$${f.value.toFixed(2)}` : f.unit === "hours" ? `${f.value}h` : String(f.value);
			return `${f.id} = ${shown} (${f.definition}; n=${f.n} ${f.population}; ${f.window})`;
		})
		.join("\n");
}
