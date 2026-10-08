// SPDX-FileCopyrightText: 2026 Hari Srinivasan <harisrini21@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { test } from "node:test";
import { aggregateData, excludeToolingSessions } from "../index.ts";
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

test("a tooling session excluded before aggregation is absent from worst-turns and friction, kept out of totals", () => {
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

	const analyzed = excludeToolingSessions(metas, ["oh-my-pi-insights"]);
	const agg = aggregateData(analyzed, new Map());

	// Documented choice: tooling sessions are dropped before aggregation
	// entirely, so they are absent from both the worst-turn/friction signals
	// and the headline totals (total_sessions, cost) computed from the same
	// filtered list — not tagged-but-counted. ScanSummary.excluded_tooling
	// records how many were dropped for audit.
	assert.equal(agg.total_sessions, 1);
	assert.equal(agg.worst_turns_corpus.length, 1);
	assert.equal(agg.worst_turns_corpus[0]!.prompt, "fix the login bug");
	assert.equal(agg.total_cost, 0.1);
});
