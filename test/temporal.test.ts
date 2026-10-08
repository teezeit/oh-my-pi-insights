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
	for (let d = 1; d <= 10; d++) metas.push(session(`old${d}`, d, "openai/gpt-5.5", 10, 10));
	for (let d = 11; d <= 20; d++) metas.push(session(`new${d}`, d, "anthropic/claude-opus-5", 5, 4));

	const t = computeTemporalData(metas, new Map());

	assert.ok(t.delta, "expected a delta");
	assert.equal(t.delta.basis, "model_switch");
	assert.deepEqual(t.delta.before, { start: "2026-09-01", end: "2026-09-10", sessions: 10 });
	assert.deepEqual(t.delta.after, { start: "2026-09-11", end: "2026-09-20", sessions: 10 });
	assert.deepEqual(t.delta.cost_per_session, { before: 10, after: 5, pct: -50 });
	assert.deepEqual(t.delta.errors_per_session, { before: 10, after: 4, pct: -60 });

	// Every percentage the temporal block prints is one of the two deltas.
	const prose = [...t.diff_headlines, t.major_transition?.impact ?? "", t.trajectory.note].join(" | ");
	const pcts = [...prose.matchAll(/(\d+)%/g)].map((m) => Number(m[1]));
	assert.ok(pcts.length >= 2, prose);
	for (const p of pcts) assert.ok(p === 50 || p === 60, `stray ${p}% in: ${prose}`);
	assert.match(prose, /2026-09-01/);
	assert.match(prose, /2026-09-20/);
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
