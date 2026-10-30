// SPDX-FileCopyrightText: 2026 Hari Srinivasan <harisrini21@gmail.com>
// SPDX-FileCopyrightText: 2026 Tobias Hoelzer (omp port)
// SPDX-License-Identifier: AGPL-3.0-only


// Week-over-week diffs, trajectory, anomalies and friction resolution over
// the session corpus.

import { normalizeFrictionCounts } from "./aggregate.ts";
import type { DeltaWindow, SessionFacets, SessionMeta, TemporalData, TemporalDelta } from "./types.ts";

// Why: a 10-vs-10 session cost/error swing is well within normal noise; both
// windows of a quoted delta must clear this before the report calls it a
// trend instead of a coincidence. Chosen to be comfortably above the 10-
// session windows the model-switch and week-over-week comparisons default
// to, not derived from any statistical test.
export const MIN_WINDOW_SESSIONS = 20;

export function modeStr(arr: string[]): string {
	const counts: Record<string, number> = {};
	for (const v of arr) if (v) counts[v] = (counts[v] || 0) + 1;
	return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || "";
}

export type TemporalOptions = { sinceDays?: number };

export function computeTemporalData(metas: SessionMeta[], facetsMap: Map<string, SessionFacets>, currentFriction: Record<string, number> = {}, options: TemporalOptions = {}): TemporalData {
	const sorted = [...metas].sort((a, b) => a.start_time.localeCompare(b.start_time));
	// Why: a recent window wider than the analysed range (or more than half
	// of it) would leave no older friction to compare against, so the window
	// never exceeds 14 days or half of --since's range, whichever is smaller.
	const recentWindowDays = options.sinceDays && options.sinceDays > 0 ? Math.min(14, options.sinceDays / 2) : 14;
	if (!sorted.length) return { diff_headlines: [], this_week: null, last_week: null, trajectory: { cost: "stable", errors: "stable", note: "" }, anomalies: [], major_transition: null, resolved_friction: [], ongoing_friction: [], staleness_pct: 0, delta: null, delta_unavailable_reason: null, recent_window_days: recentWindowDays };

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

	// Trajectory: direction only, gated by MIN_WINDOW_SESSIONS the same way
	// `delta` is. Why: a 10-vs-10 session swing is noise (see the gate
	// comment above); below the threshold this must not claim a trend.
	const recent10 = sorted.slice(-10);
	const older = sorted.slice(0, -10);
	const recentCost = recent10.reduce((s, m) => s + m.total_cost, 0) / recent10.length;
	const olderCost = older.length ? older.reduce((s, m) => s + m.total_cost, 0) / older.length : recentCost;
	const recentErrors = recent10.reduce((s, m) => s + m.tool_errors, 0) / recent10.length;
	const olderErrors = older.length ? older.reduce((s, m) => s + m.tool_errors, 0) / older.length : recentErrors;

	const recentWindow = sorted.slice(-MIN_WINDOW_SESSIONS);
	const olderWindow = sorted.slice(0, -MIN_WINDOW_SESSIONS);
	const trajectoryInsufficient = recentWindow.length < MIN_WINDOW_SESSIONS || olderWindow.length < MIN_WINDOW_SESSIONS;
	let trajectory: TemporalData["trajectory"];
	if (trajectoryInsufficient) {
		trajectory = {
			cost: "insufficient",
			errors: "insufficient",
			note: `Not enough sessions for a cost/error trend (need ${MIN_WINDOW_SESSIONS}+ per window)`,
		};
	} else {
		const windowRecentCost = recentWindow.reduce((s, m) => s + m.total_cost, 0) / recentWindow.length;
		const windowOlderCost = olderWindow.reduce((s, m) => s + m.total_cost, 0) / olderWindow.length;
		const windowRecentErrors = recentWindow.reduce((s, m) => s + m.tool_errors, 0) / recentWindow.length;
		const windowOlderErrors = olderWindow.reduce((s, m) => s + m.tool_errors, 0) / olderWindow.length;
		const costTrend = windowRecentCost > windowOlderCost * 1.2 ? "increasing" : windowRecentCost < windowOlderCost * 0.8 ? "decreasing" : "stable";
		const errorTrend = windowRecentErrors > windowOlderErrors * 1.2 ? "increasing" : windowRecentErrors < windowOlderErrors * 0.8 ? "decreasing" : "stable";
		// Why: windows carries the raw numbers behind cost/errors/note so the
		// renderers (html.ts, md.ts) and facts.ts can show and fact-check this
		// trajectory instead of only the LLM prompt quoting the prose note.
		trajectory = {
			cost: costTrend,
			errors: errorTrend,
			note: `Recent ${MIN_WINDOW_SESSIONS} vs earlier ${olderWindow.length} sessions: cost ${costTrend}, errors ${errorTrend}`,
			windows: {
				recent_n: recentWindow.length,
				older_n: olderWindow.length,
				recent_mean_cost: windowRecentCost,
				older_mean_cost: windowOlderCost,
				recent_mean_errors: windowRecentErrors,
				older_mean_errors: windowOlderErrors,
				cost_pct: Math.round((windowRecentCost - windowOlderCost) / (windowOlderCost || 1) * 100),
				errors_pct: Math.round((windowRecentErrors - windowOlderErrors) / (windowOlderErrors || 1) * 100),
			},
		};
	}

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
			// Why: the switch point j is found from 10-session mode windows above,
			// but the quoted delta itself needs MIN_WINDOW_SESSIONS-sized windows
			// to ever clear the noise gate; j still anchors both windows so
			// neither mixes both models.
			delta = compareWindows("model_switch", sorted.slice(Math.max(0, j - MIN_WINDOW_SESSIONS), j), sorted.slice(j, j + MIN_WINDOW_SESSIONS));
			major_transition = {
				when: sorted[j]!.start_time.slice(0, 10),
				what: `Shifted from ${beforeModel.replace(/.*\//, "")} to ${afterModel.replace(/.*\//, "")}`,
				impact: delta.insufficient
					? `Not enough sessions on each side to measure impact (need ${MIN_WINDOW_SESSIONS}+ per window; ${windowText(delta)})`
					: `Cost ${trend(delta.cost_per_session.pct)}, errors ${trend(delta.errors_per_session.pct)} per session (${windowText(delta)})`,
			};
			break;
		}
	}
	if (!delta && tw && lw) delta = compareWindows("week_over_week", lastWeekSessions, thisWeekSessions);
	// Why: without this, the Since Last Report block vanishes silently when
	// there is trajectory or harness content to explain but no before/after
	// comparison was possible (issue #13), instead of saying why.
	const delta_unavailable_reason: string | null = delta
		? null
		: tw && !lw
			? "No previous week inside this report window"
			: "Not enough sessions for a before/after comparison";

	const diff_headlines: string[] = [];
	// Why: below MIN_WINDOW_SESSIONS the cost/error pct is noise, not a
	// finding; say so once here instead of letting Top Actions/Friction each
	// derive their own confident-sounding number from the same thin windows
	// (prompts.ts quotes diff_headlines verbatim as "the only delta").
	if (delta?.insufficient) {
		diff_headlines.push(`Not enough data yet for a cost/error trend (need ${MIN_WINDOW_SESSIONS}+ sessions per window; have ${windowText(delta)})`);
	} else if (delta) {
		const c = delta.cost_per_session;
		const e = delta.errors_per_session;
		if (Math.abs(c.pct) > 15) diff_headlines.push(`Cost ${trend(c.pct)} ($${c.before.toFixed(1)} \u2192 $${c.after.toFixed(1)}/session; ${windowText(delta)})`);
		if (Math.abs(e.pct) > 20) diff_headlines.push(`Errors ${trend(e.pct)} (${e.before.toFixed(1)} \u2192 ${e.after.toFixed(1)}/session; ${windowText(delta)})`);
	}
	// Why: major_transition (below) is the one model-shift statement; this
	// used to also push "Model shifted: lw -> tw" from the calendar-week
	// primary model, which could name a different pair of models than
	// major_transition's sliding-window detection for the same corpus.

	// Resolved vs ongoing friction
	const recentCutoff = now - recentWindowDays * 86400000;
	const recentMetas = sorted.filter(m => new Date(m.start_time).getTime() >= recentCutoff);
	const olderMetas = sorted.filter(m => new Date(m.start_time).getTime() < recentCutoff);
	let recentFriction: Record<string, number> = {};
	let olderFriction: Record<string, number> = {};
	// Issue #11/#12: normalize so word-order/synonym variants merge and
	// resolution/success keys never count as friction here either.
	for (const m of recentMetas) { const f = facetsMap.get(m.session_id); if (f) for (const [k, v] of Object.entries(normalizeFrictionCounts(f.friction_counts))) if (v > 0) recentFriction[k] = (recentFriction[k] || 0) + v; }
	for (const m of olderMetas) { const f = facetsMap.get(m.session_id); if (f) for (const [k, v] of Object.entries(normalizeFrictionCounts(f.friction_counts))) if (v > 0) olderFriction[k] = (olderFriction[k] || 0) + v; }
	// Second pass: regroup cross-session variants (each loop above only
	// normalized one session's dict at a time - see normalizeFrictionCounts).
	recentFriction = normalizeFrictionCounts(recentFriction);
	olderFriction = normalizeFrictionCounts(olderFriction);
	const resolved_friction: string[] = [];
	const ongoing_friction: TemporalData["ongoing_friction"] = [];
	// Why: a type absent from the recent window can still rank in agg.friction
	// (the Friction Types chart, decay-weighted over the whole corpus); do
	// not call it resolved while the chart the user is looking at still
	// shows it happening.
	for (const [type] of Object.entries(olderFriction)) { if (!recentFriction[type] && !(currentFriction[type] > 0)) resolved_friction.push(type); }
	for (const [type, count] of Object.entries(recentFriction)) { if (count > 0) ongoing_friction.push({ type, recent_count: count, total_count: count + (olderFriction[type] || 0) }); }
	ongoing_friction.sort((a, b) => b.recent_count - a.recent_count);

	// Staleness
	const flatCost = sorted.reduce((s, m) => s + m.total_cost, 0) / sorted.length;
	const staleness_pct = flatCost > 0 ? Math.abs((recentCost - flatCost) / flatCost * 100) : 0;

	return { diff_headlines, this_week: tw, last_week: lw, trajectory, anomalies: anomalies.slice(0, 5), major_transition, resolved_friction: resolved_friction.slice(0, 5), ongoing_friction: ongoing_friction.slice(0, 8), staleness_pct, delta, delta_unavailable_reason, recent_window_days: recentWindowDays };
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
		insufficient: before.length < MIN_WINDOW_SESSIONS || after.length < MIN_WINDOW_SESSIONS,
	};
}

/**
 * Renders the one trajectory sentence the Since Last Report block (html.ts,
 * md.ts) shows next to the week-over-week/model-switch delta. Returns null
 * when the trajectory is below MIN_WINDOW_SESSIONS (trajectory.windows is
 * then absent) - render nothing rather than a stable/insufficient line.
 */
export function trajectoryLine(trajectory: TemporalData["trajectory"]): string | null {
	const w = trajectory.windows;
	if (!w) return null;
	return `Last ${w.recent_n} vs previous ${w.older_n} sessions: cost $${w.older_mean_cost.toFixed(2)} \u2192 $${w.recent_mean_cost.toFixed(2)}/session (${trend(w.cost_pct)}), errors ${w.older_mean_errors.toFixed(1)} \u2192 ${w.recent_mean_errors.toFixed(1)}/session`;
}
