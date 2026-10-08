// SPDX-FileCopyrightText: 2026 Tobias Hoelzer (omp port)
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import {
	aggregateData,
	buildFacts,
	checkFacts,
	computeTemporalData,
	type Fact,
	type SessionFacets,
} from "../index.ts";
import { meta } from "./helpers.ts";

const FIXTURES = join(import.meta.dirname, "fixtures");

test("checker flags percentages and dollar amounts that no fact backs", async () => {
	const { sections, synthesis } = JSON.parse(await readFile(join(FIXTURES, "sections.json"), "utf-8"));
	const facts: Fact[] = JSON.parse(await readFile(join(FIXTURES, "facts.json"), "utf-8"));

	const flags = checkFacts({ ...sections, at_a_glance: synthesis }, facts);
	const flagged = flags.map((f) => `${f.unit}:${f.value}`).sort();

	assert.deepEqual(flagged, ["pct:22", "pct:31", "pct:43", "pct:70", "pct:86", "usd:999"].sort());
	// Each flag points at where the number was written.
	const f22 = flags.find((f) => f.value === 22)!;
	assert.equal(f22.path, "interaction_style.narrative");
	assert.equal(flags.find((f) => f.value === 31)!.path, "friction_analysis.ongoing.0.description");
});

test("facts carry the report's own numbers with n and window", () => {
	const facetsMap = new Map<string, SessionFacets>();
	const metas = [];
	for (let i = 0; i < 16; i++) {
		const id = `s${i}`;
		metas.push(meta({
			session_id: id,
			start_time: new Date(Date.UTC(2026, 8, 1 + i, 9)).toISOString(),
			user_message_count: 10,
			steering_messages: i < 7 ? 1 : 0,
			aborted_generations: i === 0 ? 1 : 0,
			aborted_at_session_end: i === 0 ? 1 : 0,
			total_cost: 2,
			cost_primary: 2,
		}));
		facetsMap.set(id, {
			session_id: id, underlying_goal: "", goal_categories: {}, outcome: i < 15 ? "fully_achieved" : "not_achieved",
			user_satisfaction_counts: {}, assistant_helpfulness: "", session_type: "single_task", friction_counts: {},
			friction_detail: "", primary_success: "none", brief_summary: "x",
		});
	}
	const agg = aggregateData(metas, facetsMap);
	const facts = buildFacts(agg, computeTemporalData(metas, facetsMap));
	const byId = new Map(facts.map((f) => [f.id, f]));

	const rate = byId.get("interruption_rate")!;
	assert.equal(rate.unit, "pct");
	assert.equal(rate.value, 4.4);
	assert.equal(rate.n, 160);
	assert.equal(rate.window, "2026-09-01..2026-09-16");

	// Unweighted: 15 of 16 sessions, not the decay-weighted chart share.
	const success = byId.get("success_rate")!;
	assert.equal(success.value, 93.8);
	assert.equal(success.n, 16);

	assert.equal(byId.get("total_cost")!.value, 32);
	assert.equal(byId.get("total_cost")!.unit, "usd");

	// A sentence quoting these exact numbers passes the checker.
	assert.deepEqual(checkFacts({ s: { t: "4.4% interrupted, 94% succeeded, $32.00 spent" } }, facts), []);
});
