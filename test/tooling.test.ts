// SPDX-FileCopyrightText: 2026 Hari Srinivasan <harisrini21@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { test } from "node:test";
import { aggregateData, excludeToolingSessions, type SessionFacets } from "../index.ts";
import { meta } from "./helpers.ts";

// B11: this tool's own development sessions (scanner port, friction-analysis
// implementation) are naturally turn/tool-call heavy and must not dominate
// worst-turn and friction signals meant to reflect the user's other work.

test("excludeToolingSessions drops sessions whose project matches the exclude list", () => {
	const metas = [
		meta({ session_id: "a", project_path: "/Users/me/projects/peach" }),
		meta({ session_id: "b", project_path: "/Users/me/code/oh-my-pi-insights" }),
	];
	const filtered = excludeToolingSessions(metas, ["oh-my-pi-insights"]);
	assert.deepEqual(filtered.map((m) => m.session_id), ["a"]);
});

test("excludeToolingSessions is a no-op with an empty exclude list", () => {
	const metas = [meta({ session_id: "a" })];
	assert.deepEqual(excludeToolingSessions(metas, []), metas);
});

test("excludeToolingSessions matches a worktree path under the excluded repo name", () => {
	const metas = [
		meta({ session_id: "a", project_path: "/Users/me/code/oh-my-pi-insights/.orca/worktrees/insights-b-advice" }),
	];
	assert.deepEqual(excludeToolingSessions(metas, ["oh-my-pi-insights"]), []);
});

test("a tooling session's cost/sessions count stay in totals; its worst turn is dropped from worst_turns_corpus", () => {
	const toolingTurn = {
		start_ts: "2026-09-10T10:00:00.000Z",
		prompt: "port the scanner to omp",
		llm_round_trips: 40,
		tool_calls: 80,
		exploration_before_first_mutation: 20,
		mutated: true,
		wall_sec: 3000,
		cost: 5,
		aborted: false,
	};
	const userTurn = {
		start_ts: "2026-09-11T10:00:00.000Z",
		prompt: "fix the login bug",
		llm_round_trips: 2,
		tool_calls: 3,
		exploration_before_first_mutation: 1,
		mutated: true,
		wall_sec: 60,
		cost: 0.1,
		aborted: false,
	};

	const metas = [
		meta({
			session_id: "a",
			project_path: "/Users/me/projects/peach",
			total_cost: 0.1,
			worst_turns: [userTurn],
		}),
		meta({
			session_id: "b",
			project_path: "/Users/me/code/oh-my-pi-insights",
			total_cost: 5,
			worst_turns: [toolingTurn],
		}),
	];

	// Why the full (unfiltered) metas list is passed in: tooling sessions must
	// stay in totals (cost, session count) while still dropping out of
	// worst-turn/friction analysis — a pre-filtered list would wrongly drop
	// them from both.
	const agg = aggregateData(metas, new Map(), ["oh-my-pi-insights"]);

	assert.equal(agg.total_sessions, 2);
	assert.equal(agg.total_cost, 5.1);
	assert.equal(agg.worst_turns_corpus.length, 1);
	assert.equal(agg.worst_turns_corpus[0]!.prompt, "fix the login bug");
});

test("a tooling session's facets (friction, session summaries) are excluded even though it counts toward totals", () => {
	const metas = [
		meta({ session_id: "a", project_path: "/Users/me/projects/peach" }),
		meta({ session_id: "b", project_path: "/Users/me/code/oh-my-pi-insights" }),
	];
	const facetsMap = new Map<string, SessionFacets>([
		["a", {
			session_id: "a",
			underlying_goal: "fix bug",
			goal_categories: {},
			outcome: "fully_achieved",
			user_satisfaction_counts: {},
			assistant_helpfulness: "helpful",
			session_type: "single_task",
			friction_counts: { buggy_code: 1 },
			friction_detail: "the login form double-submitted",
			primary_success: "none",
			brief_summary: "fixed the login bug",
		}],
		["b", {
			session_id: "b",
			underlying_goal: "port scanner",
			goal_categories: {},
			outcome: "fully_achieved",
			user_satisfaction_counts: {},
			assistant_helpfulness: "helpful",
			session_type: "multi_task",
			friction_counts: { excessive_changes: 5 },
			friction_detail: "spent too long refactoring the scanner",
			primary_success: "none",
			brief_summary: "ported the omp scanner",
		}],
	]);

	const agg = aggregateData(metas, facetsMap, ["oh-my-pi-insights"]);

	assert.equal(agg.total_sessions, 2);
	assert.equal(agg.session_summaries.length, 1);
	assert.equal(agg.session_summaries[0]!.summary, "fixed the login bug");
	assert.equal(agg.friction_details.length, 1);
	assert.equal(agg.friction_details[0], "the login form double-submitted");
	assert.equal(agg.friction.excessive_changes ?? 0, 0);
	assert.ok((agg.friction.buggy_code ?? 0) > 0);
});

test("a tooling session is excluded from worst_cache_sessions (suggestion evidence)", () => {
	const metas = [
		meta({ session_id: "a", project_path: "/Users/me/projects/peach", input_tokens: 60_000, cache_read_tokens: 1_000 }),
		meta({ session_id: "b", project_path: "/Users/me/code/oh-my-pi-insights", input_tokens: 60_000, cache_read_tokens: 1_000 }),
	];
	const agg = aggregateData(metas, new Map(), ["oh-my-pi-insights"]);
	assert.deepEqual(
		agg.worst_cache_sessions.map((s) => s.session_id),
		["a"],
	);
});

test("with no exclude list, aggregateData behaves exactly as before (nothing dropped)", () => {
	const metas = [meta({ session_id: "a", project_path: "/Users/me/code/oh-my-pi-insights" })];
	const agg = aggregateData(metas, new Map());
	assert.equal(agg.total_sessions, 1);
});
