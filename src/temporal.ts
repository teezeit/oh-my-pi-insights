// SPDX-FileCopyrightText: 2026 Hari Srinivasan <harisrini21@gmail.com>
// SPDX-FileCopyrightText: 2026 Tobias Hoelzer (omp port)
// SPDX-License-Identifier: AGPL-3.0-only


// Week-over-week diffs, trajectory, anomalies and friction resolution over
// the session corpus.

import type { SessionFacets, SessionMeta, TemporalData } from "./types.ts";

export function modeStr(arr: string[]): string {
	const counts: Record<string, number> = {};
	for (const v of arr) if (v) counts[v] = (counts[v] || 0) + 1;
	return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || "";
}

export function computeTemporalData(metas: SessionMeta[], facetsMap: Map<string, SessionFacets>): TemporalData {
	const sorted = [...metas].sort((a, b) => a.start_time.localeCompare(b.start_time));
	if (!sorted.length) return { diff_headlines: [], this_week: null, last_week: null, trajectory: { cost: "stable", errors: "stable", note: "" }, anomalies: [], major_transition: null, resolved_friction: [], ongoing_friction: [], staleness_pct: 0 };

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
	const diff_headlines: string[] = [];
	if (tw && lw && lw.avg_cost > 0) {
		const costD = Math.round((tw.avg_cost - lw.avg_cost) / lw.avg_cost * 100);
		if (Math.abs(costD) > 15) diff_headlines.push(`Cost ${costD > 0 ? "up" : "down"} ${Math.abs(costD)}% ($${lw.avg_cost.toFixed(1)} \u2192 $${tw.avg_cost.toFixed(1)}/session)`);
		const errD = Math.round((tw.errors_per_session - lw.errors_per_session) / (lw.errors_per_session || 1) * 100);
		if (Math.abs(errD) > 20) diff_headlines.push(`Errors ${errD > 0 ? "up" : "down"} ${Math.abs(errD)}% (${lw.errors_per_session.toFixed(0)} \u2192 ${tw.errors_per_session.toFixed(0)}/session)`);
		if (tw.primary_model !== lw.primary_model) diff_headlines.push(`Model shifted: ${lw.primary_model} \u2192 ${tw.primary_model}`);
	}

	// Trajectory
	const recent10 = sorted.slice(-10);
	const older = sorted.slice(0, -10);
	const recentCost = recent10.reduce((s, m) => s + m.total_cost, 0) / recent10.length;
	const olderCost = older.length ? older.reduce((s, m) => s + m.total_cost, 0) / older.length : recentCost;
	const recentErrors = recent10.reduce((s, m) => s + m.tool_errors, 0) / recent10.length;
	const olderErrors = older.length ? older.reduce((s, m) => s + m.tool_errors, 0) / older.length : recentErrors;
	const trajectory = {
		cost: recentCost > olderCost * 1.2 ? "increasing" : recentCost < olderCost * 0.8 ? "decreasing" : "stable",
		errors: recentErrors > olderErrors * 1.2 ? "increasing" : recentErrors < olderErrors * 0.8 ? "decreasing" : "stable",
		note: older.length ? `Recent 10 vs earlier ${older.length}: cost ${recentCost > olderCost ? "up" : "down"} ${Math.abs(Math.round((recentCost - olderCost) / (olderCost || 1) * 100))}%, errors ${recentErrors > olderErrors ? "up" : "down"} ${Math.abs(Math.round((recentErrors - olderErrors) / (olderErrors || 1) * 100))}%` : "Not enough history",
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

	// Major transition
	let major_transition: TemporalData["major_transition"] = null;
	for (let i = sorted.length - 1; i >= 10; i--) {
		const after = sorted.slice(i, Math.min(i + 10, sorted.length));
		const before = sorted.slice(Math.max(0, i - 10), i);
		if (before.length < 5 || after.length < 5) continue;
		const beforeModel = modeStr(before.map(m => Object.entries(m.model_usage).sort((a, b) => b[1].cost - a[1].cost)[0]?.[0] || ""));
		const afterModel = modeStr(after.map(m => Object.entries(m.model_usage).sort((a, b) => b[1].cost - a[1].cost)[0]?.[0] || ""));
		if (beforeModel && afterModel && beforeModel !== afterModel) {
			const beforeCost = before.reduce((s, m) => s + m.total_cost, 0) / before.length;
			const afterCost = after.reduce((s, m) => s + m.total_cost, 0) / after.length;
			const beforeErrors = before.reduce((s, m) => s + m.tool_errors, 0) / before.length;
			const afterErrors = after.reduce((s, m) => s + m.tool_errors, 0) / after.length;
			major_transition = {
				when: sorted[i]!.start_time.slice(0, 10),
				what: `Shifted from ${beforeModel.replace(/.*\//, "")} to ${afterModel.replace(/.*\//, "")}`,
				impact: `Cost ${afterCost > beforeCost ? "up" : "down"} ${Math.abs(Math.round((afterCost - beforeCost) / (beforeCost || 1) * 100))}%, errors ${afterErrors > beforeErrors ? "up" : "down"} ${Math.abs(Math.round((afterErrors - beforeErrors) / (beforeErrors || 1) * 100))}%`,
			};
			break;
		}
	}

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

	return { diff_headlines, this_week: tw, last_week: lw, trajectory, anomalies: anomalies.slice(0, 5), major_transition, resolved_friction: resolved_friction.slice(0, 5), ongoing_friction: ongoing_friction.slice(0, 8), staleness_pct };
}
