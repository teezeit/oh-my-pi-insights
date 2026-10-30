// SPDX-FileCopyrightText: 2026 Tobias Hoelzer (omp port)
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { test } from "node:test";
import { computeTemporalData } from "../index.ts";
import { meta } from "./helpers.ts";

const day = (d: number) => new Date(Date.UTC(2026, 8, d, 9)).toISOString();

function session(id: string, d: number, model: string, cost: number, errors: number) {
	return meta({
		session_id: id,
		start_time: day(d),
		total_cost: cost,
		cost_primary: cost,
		tool_errors: errors,
		model_usage: { [model]: { input_tokens: 1, output_tokens: 1, cost, message_count: 1 } },
	});
}

test("a model switch yields one cost and one errors delta with explicit windows", () => {
	const metas = [];
	for (let d = 1; d <= 20; d++) metas.push(session(`old${d}`, d, "openai/gpt-5.5", 10, 10));
	for (let d = 21; d <= 40; d++) metas.push(session(`new${d}`, d, "anthropic/claude-opus-5", 5, 4));

	const t = computeTemporalData(metas, new Map());

	assert.ok(t.delta, "expected a delta");
	assert.equal(t.delta.basis, "model_switch");
	assert.equal(t.delta.insufficient, false);
	assert.deepEqual(t.delta.before, { start: "2026-09-01", end: "2026-09-20", sessions: 20 });
	assert.deepEqual(t.delta.after, { start: "2026-09-21", end: "2026-10-10", sessions: 20 });
	assert.deepEqual(t.delta.cost_per_session, { before: 10, after: 5, pct: -50 });
	assert.deepEqual(t.delta.errors_per_session, { before: 10, after: 4, pct: -60 });

	// Every percentage the temporal block prints is one of the two deltas.
	const prose = [...t.diff_headlines, t.major_transition?.impact ?? "", t.trajectory.note].join(" | ");
	const pcts = [...prose.matchAll(/(\d+)%/g)].map((m) => Number(m[1]));
	assert.ok(pcts.length >= 2, prose);
	for (const p of pcts) assert.ok(p === 50 || p === 60, `stray ${p}% in: ${prose}`);
	assert.match(prose, /2026-09-01/);
	assert.match(prose, /2026-10-10/);
});

test("below MIN_WINDOW_SESSIONS, major_transition.impact names no pct (same gate as diff_headlines)", () => {
	const metas = [];
	for (let d = 1; d <= 10; d++) metas.push(session(`old${d}`, d, "openai/gpt-5.5", 10, 10));
	for (let d = 11; d <= 20; d++) metas.push(session(`new${d}`, d, "anthropic/claude-opus-5", 5, 4));

	const t = computeTemporalData(metas, new Map());

	assert.ok(t.delta?.insufficient, "expected the model-switch delta to be insufficient at 10v10");
	assert.ok(t.major_transition, "expected a major_transition");
	assert.doesNotMatch(t.major_transition!.impact, /\d+%/, `impact must not quote a pct below the sample gate: ${t.major_transition!.impact}`);
	assert.match(t.major_transition!.impact, /not enough sessions/i);
});

test("without a model switch the delta falls back to week over week", () => {
	const metas = [
		session("a", 1, "m", 10, 2),
		session("b", 2, "m", 10, 2),
		session("c", 10, "m", 20, 2),
	];
	const t = computeTemporalData(metas, new Map());
	assert.ok(t.delta);
	assert.equal(t.delta.basis, "week_over_week");
	assert.deepEqual(t.delta.before, { start: "2026-09-01", end: "2026-09-02", sessions: 2 });
	assert.deepEqual(t.delta.after, { start: "2026-09-10", end: "2026-09-10", sessions: 1 });
	assert.equal(t.delta.cost_per_session.pct, 100);
	assert.equal(t.delta.errors_per_session.pct, 0);
});

test("a 10-vs-10 week-over-week delta is marked insufficient and produces no cost/error headlines", () => {
	const metas = [];
	for (let i = 0; i < 10; i++) metas.push(session(`last${i}`, 17 + (i % 7), "m", 20, 10));
	for (let i = 0; i < 10; i++) metas.push(session(`this${i}`, 24 + (i % 7), "m", 5, 2));

	const t = computeTemporalData(metas, new Map());

	assert.ok(t.delta, "expected a delta");
	assert.equal(t.delta.basis, "week_over_week");
	assert.equal(t.delta.before.sessions, 10);
	assert.equal(t.delta.after.sessions, 10);
	assert.equal(t.delta.insufficient, true);
	assert.ok(
		!t.diff_headlines.some((h) => h.startsWith("Cost") || h.startsWith("Errors")),
		`unexpected cost/error headline: ${JSON.stringify(t.diff_headlines)}`,
	);
	assert.ok(
		t.diff_headlines.some((h) => /not enough data/i.test(h)),
		`expected an insufficient-data marker, got ${JSON.stringify(t.diff_headlines)}`,
	);
});

test("resolved_friction excludes a type still present in the current run's friction counts (agg.friction)", () => {
	const metas = [session("old1", 1, "m", 5, 0), session("new1", 30, "m", 5, 0)];
	const facetsMap = new Map([
		["old1", { session_id: "old1", underlying_goal: "", goal_categories: {}, outcome: "fully_achieved", user_satisfaction_counts: {}, assistant_helpfulness: "", session_type: "single_task", friction_counts: { wrong_approach: 2 } as Record<string, number>, friction_detail: "", primary_success: "none", brief_summary: "x" }],
		["new1", { session_id: "new1", underlying_goal: "", goal_categories: {}, outcome: "fully_achieved", user_satisfaction_counts: {}, assistant_helpfulness: "", session_type: "single_task", friction_counts: {} as Record<string, number>, friction_detail: "", primary_success: "none", brief_summary: "x" }],
	]);

	const withoutCurrent = computeTemporalData(metas, facetsMap);
	assert.ok(withoutCurrent.resolved_friction.includes("wrong_approach"));

	const withCurrent = computeTemporalData(metas, facetsMap, { wrong_approach: 5 });
	assert.ok(!withCurrent.resolved_friction.includes("wrong_approach"));
});

test("sinceDays=7 narrows the recent window to half that range and reports it", () => {
	const metas = [
		session("in-window", 40, "m", 5, 0),
		session("just-outside", 36, "m", 5, 0),
	];
	const facetsMap = new Map([
		["in-window", { session_id: "in-window", underlying_goal: "", goal_categories: {}, outcome: "fully_achieved", user_satisfaction_counts: {}, assistant_helpfulness: "", session_type: "single_task", friction_counts: { wrong_approach: 3 } as Record<string, number>, friction_detail: "", primary_success: "none", brief_summary: "x" }],
		["just-outside", { session_id: "just-outside", underlying_goal: "", goal_categories: {}, outcome: "fully_achieved", user_satisfaction_counts: {}, assistant_helpfulness: "", session_type: "single_task", friction_counts: { wrong_approach: 7 } as Record<string, number>, friction_detail: "", primary_success: "none", brief_summary: "x" }],
	]);

	const t = computeTemporalData(metas, facetsMap, {}, { sinceDays: 7 });

	assert.equal(t.recent_window_days, 3.5);
	const wrongApproach = t.ongoing_friction.find((f) => f.type === "wrong_approach");
	assert.ok(wrongApproach, "expected wrong_approach to still be ongoing");
	assert.equal(wrongApproach!.recent_count, 3, "the 4-day-old session is outside the 3.5-day window");
	assert.equal(wrongApproach!.total_count, 10);
});

test("sinceDays=0 (no --since) keeps the 14-day recent window", () => {
	const metas = [session("a", 1, "m", 5, 0)];
	const t = computeTemporalData(metas, new Map());
	assert.equal(t.recent_window_days, 14);
});

test("below MIN_WINDOW_SESSIONS sessions total, trajectory reports insufficient data with no 'decreasing' claim", () => {
	const metas = [];
	for (let d = 1; d <= 15; d++) metas.push(session(`s${d}`, d, "anthropic/claude-opus-5", 20 - d, 5));

	const t = computeTemporalData(metas, new Map());

	assert.equal(t.trajectory.cost, "insufficient");
	assert.equal(t.trajectory.errors, "insufficient");
	assert.match(t.trajectory.note, /not enough sessions/i);
	assert.doesNotMatch(t.trajectory.note, /decreasing/);
});

test("with 45 sessions split across a falling-cost window, trajectory computes a trend", () => {
	const metas = [];
	for (let d = 1; d <= 25; d++) metas.push(session(`old${d}`, d, "anthropic/claude-opus-5", 10, 10));
	for (let d = 26; d <= 45; d++) metas.push(session(`new${d}`, d, "anthropic/claude-opus-5", 5, 4));

	const t = computeTemporalData(metas, new Map());

	assert.equal(t.trajectory.cost, "decreasing");
	assert.equal(t.trajectory.errors, "decreasing");
	assert.match(t.trajectory.note, /cost decreasing, errors decreasing/);
});
