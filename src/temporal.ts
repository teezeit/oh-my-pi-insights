// SPDX-FileCopyrightText: 2026 Hari Srinivasan <harisrini21@gmail.com>
// SPDX-FileCopyrightText: 2026 Tobias Hoelzer (omp port)
// SPDX-License-Identifier: AGPL-3.0-only


// Week-over-week diffs, trajectory, anomalies and friction resolution over
// the session corpus.

import type { DeltaWindow, SessionFacets, SessionMeta, TemporalData, TemporalDelta } from "./types.ts";

export function modeStr(arr: string[]): string {
	const counts: Record<string, number> = {};
	for (const v of arr) if (v) counts[v] = (counts[v] || 0) + 1;
	return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || "";
}

export function computeTemporalData(metas: SessionMeta[], facetsMap: Map<string, SessionFacets>): TemporalData {
	const sorted = [...metas].sort((a, b) => a.start_time.localeCompare(b.start_time));
	if (!sorted.length) return { diff_headlines: [], this_week: null, last_week: null, trajectory: { cost: "stable", errors: "stable", note: "" }, anomalies: [], major_transition: null, resolved_friction: [], ongoing_friction: [], staleness_pct: 0, delta: null };

	const now = new Date(sorted[sorted.length - 1]!.start_time).getTime();
	const oneWeek = 7 * 86400000;

	// Diff: this week vs last week
	const thisWeekSessions = sorted.filter(m => now - new Date(m.start_time).getTime() < oneWeek);
	const lastWeekSessions = sorted.filter(m => { const age = now - new Date(m.start_time).getTime(); return age >= oneWeek && age < 2 * oneWeek; });

	function periodSummary(sessions: SessionMeta[]) {
		if (!sessions.length) return null;
		const models: Record<string, number> = {};
		let cost = 0, errors = 0;
		for (const m of sessions) { cost += m.total_cost; errors += m.tool_errors; for (const [model, s] of Object.entries(m.model_usage)) models[model] = (models[model] || 0) + s.message_count; }
		return { sessions: sessions.length, avg_cost: cost / sessions.length, errors_per_session: errors / sessions.length, primary_model: Object.entries(models).sort((a, b) => b[1] - a[1])[0]?.[0]?.replace(/.*\//, "") || "unknown" };
	}

	const tw = periodSummary(thisWeekSessions);
	const lw = periodSummary(lastWeekSessions);

	// Trajectory: direction only. Why: a percentage here was a third delta over
	// yet another window; the single quoted delta is `delta` below.
	const recent10 = sorted.slice(-10);
	const older = sorted.slice(0, -10);
	const recentCost = recent10.reduce((s, m) => s + m.total_cost, 0) / recent10.length;
	const olderCost = older.length ? older.reduce((s, m) => s + m.total_cost, 0) / older.length : recentCost;
	const recentErrors = recent10.reduce((s, m) => s + m.tool_errors, 0) / recent10.length;
	const olderErrors = older.length ? older.reduce((s, m) => s + m.tool_errors, 0) / older.length : recentErrors;
	const costTrend = recentCost > olderCost * 1.2 ? "increasing" : recentCost < olderCost * 0.8 ? "decreasing" : "stable";
	const errorTrend = recentErrors > olderErrors * 1.2 ? "increasing" : recentErrors < olderErrors * 0.8 ? "decreasing" : "stable";
	const trajectory = {
		cost: costTrend,
		errors: errorTrend,
		note: older.length ? `Recent 10 vs earlier ${older.length} sessions: cost ${costTrend}, errors ${errorTrend}` : "Not enough history",
	};

	// Anomalies
	const anomalies: TemporalData["anomalies"] = [];
	for (let i = 5; i < sorted.length; i++) {
		const m = sorted[i]!;
		const window = sorted.slice(Math.max(0, i - 10), i);
		const avgCost = window.reduce((s, x) => s + x.total_cost, 0) / window.length;
		const avgErrors = window.reduce((s, x) => s + x.tool_errors, 0) / window.length;
		const reasons: string[] = [];
		if (m.total_cost > avgCost * 3 && m.total_cost > 10) reasons.push(`cost spike: $${m.total_cost.toFixed(0)} vs $${avgCost.toFixed(0)} avg`);
		if (m.tool_errors > avgErrors * 3 && m.tool_errors > 10) reasons.push(`error spike: ${m.tool_errors} vs ${avgErrors.toFixed(0)} avg`);
		if (reasons.length) anomalies.push({ date: m.start_time.slice(0, 10), cost: `$${m.total_cost.toFixed(2)}`, errors: m.tool_errors, reason: reasons.join("; "), prompt: m.first_prompt.slice(0, 80) });
	}
	anomalies.sort((a, b) => parseFloat(b.cost.slice(1)) - parseFloat(a.cost.slice(1)));

	// Major transition: the latest point where the dominant model of the
	// surrounding 10-session windows changes, walked back to the first session
	// on the new model so neither window mixes both.
	const primaryModel = (m: SessionMeta) => Object.entries(m.model_usage).sort((a, b) => b[1].cost - a[1].cost)[0]?.[0] || "";
	let major_transition: TemporalData["major_transition"] = null;
	let delta: TemporalDelta | null = null;
	for (let i = sorted.length - 1; i >= 10; i--) {
		const after = sorted.slice(i, Math.min(i + 10, sorted.length));
		const before = sorted.slice(Math.max(0, i - 10), i);
		if (before.length < 5 || after.length < 5) continue;
		const beforeModel = modeStr(before.map(primaryModel));
		const afterModel = modeStr(after.map(primaryModel));
		if (beforeModel && afterModel && beforeModel !== afterModel) {
			let j = i;
			while (j > 1 && primaryModel(sorted[j - 1]!) === afterModel) j--;
			delta = compareWindows("model_switch", sorted.slice(Math.max(0, j - 10), j), sorted.slice(j, j + 10));
			major_transition = {
				when: sorted[j]!.start_time.slice(0, 10),
				what: `Shifted from ${beforeModel.replace(/.*\//, "")} to ${afterModel.replace(/.*\//, "")}`,
				impact: `Cost ${trend(delta.cost_per_session.pct)}, errors ${trend(delta.errors_per_session.pct)} per session (${windowText(delta)})`,
			};
			break;
		}
	}
	if (!delta && tw && lw) delta = compareWindows("week_over_week", lastWeekSessions, thisWeekSessions);

	const diff_headlines: string[] = [];
	if (delta) {
		const c = delta.cost_per_session;
		const e = delta.errors_per_session;
		if (Math.abs(c.pct) > 15) diff_headlines.push(`Cost ${trend(c.pct)} ($${c.before.toFixed(1)} \u2192 $${c.after.toFixed(1)}/session; ${windowText(delta)})`);
		if (Math.abs(e.pct) > 20) diff_headlines.push(`Errors ${trend(e.pct)} (${e.before.toFixed(1)} \u2192 ${e.after.toFixed(1)}/session; ${windowText(delta)})`);
	}
	if (tw && lw && tw.primary_model !== lw.primary_model) diff_headlines.push(`Model shifted: ${lw.primary_model} \u2192 ${tw.primary_model}`);

	// Resolved vs ongoing friction
	const recentCutoff = now - 14 * 86400000;
	const recentMetas = sorted.filter(m => new Date(m.start_time).getTime() >= recentCutoff);
	const olderMetas = sorted.filter(m => new Date(m.start_time).getTime() < recentCutoff);
	const recentFriction: Record<string, number> = {};
	const olderFriction: Record<string, number> = {};
	for (const m of recentMetas) { const f = facetsMap.get(m.session_id); if (f) for (const [k, v] of Object.entries(f.friction_counts)) if (v > 0) recentFriction[k] = (recentFriction[k] || 0) + v; }
	for (const m of olderMetas) { const f = facetsMap.get(m.session_id); if (f) for (const [k, v] of Object.entries(f.friction_counts)) if (v > 0) olderFriction[k] = (olderFriction[k] || 0) + v; }
	const resolved_friction: string[] = [];
	const ongoing_friction: TemporalData["ongoing_friction"] = [];
	for (const [type] of Object.entries(olderFriction)) { if (!recentFriction[type]) resolved_friction.push(type); }
	for (const [type, count] of Object.entries(recentFriction)) { if (count > 0) ongoing_friction.push({ type, recent_count: count, total_count: count + (olderFriction[type] || 0) }); }
	ongoing_friction.sort((a, b) => b.recent_count - a.recent_count);

	// Staleness
	const flatCost = sorted.reduce((s, m) => s + m.total_cost, 0) / sorted.length;
	const staleness_pct = flatCost > 0 ? Math.abs((recentCost - flatCost) / flatCost * 100) : 0;

	return { diff_headlines, this_week: tw, last_week: lw, trajectory, anomalies: anomalies.slice(0, 5), major_transition, resolved_friction: resolved_friction.slice(0, 5), ongoing_friction: ongoing_friction.slice(0, 8), staleness_pct, delta };
}

function trend(pct: number): string {
	return `${pct > 0 ? "up" : "down"} ${Math.abs(pct)}%`;
}

function windowText(d: TemporalDelta): string {
	return `${d.before.start}..${d.before.end}, n=${d.before.sessions} vs ${d.after.start}..${d.after.end}, n=${d.after.sessions}`;
}

function compareWindows(basis: TemporalDelta["basis"], before: SessionMeta[], after: SessionMeta[]): TemporalDelta {
	const window = (s: SessionMeta[]): DeltaWindow => ({ start: s[0]!.start_time.slice(0, 10), end: s[s.length - 1]!.start_time.slice(0, 10), sessions: s.length });
	const mean = (s: SessionMeta[], f: (m: SessionMeta) => number) => s.reduce((acc, m) => acc + f(m), 0) / s.length;
	const compare = (f: (m: SessionMeta) => number) => {
		const b = mean(before, f);
		const a = mean(after, f);
		return { before: b, after: a, pct: Math.round((a - b) / (b || 1) * 100) };
	};
	return {
		basis,
		before: window(before),
		after: window(after),
		cost_per_session: compare((m) => m.total_cost),
		errors_per_session: compare((m) => m.tool_errors),
	};
}
