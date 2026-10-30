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

test("facts expose billed/subscription split and per-provider cost", () => {
	const metas = [
		meta({ session_id: "p1", total_cost: 5, cost_primary: 5, cost_by_provider: { anthropic: 5 } }),
		meta({ session_id: "p2", total_cost: 3, cost_primary: 3, cost_by_provider: { openai: 3 } }),
	];
	const agg = aggregateData(metas, new Map(), [], { anthropic: "subscription", openai: "api_key" });
	const facts = buildFacts(agg, computeTemporalData(metas, new Map()));
	const byId = new Map(facts.map((f) => [f.id, f]));

	assert.equal(byId.get("billed_cost")!.value, 3);
	assert.equal(byId.get("billed_cost")!.unit, "usd");
	assert.equal(byId.get("subscription_cost")!.value, 5);
	assert.equal(byId.get("cost_by_provider.anthropic")!.value, 5);
	assert.match(byId.get("cost_by_provider.anthropic")!.definition, /not billed/);
	assert.equal(byId.get("cost_by_provider.openai")!.value, 3);
	assert.match(byId.get("cost_by_provider.openai")!.definition, /actually billed/);
});

test("delta.* facts are omitted below MIN_WINDOW_SESSIONS and present once the window clears it", () => {
	const day = (d: number) => new Date(Date.UTC(2026, 8, d, 9)).toISOString();
	const withModel = (id: string, d: number, model: string, cost: number) =>
		meta({
			session_id: id,
			start_time: day(d),
			total_cost: cost,
			cost_primary: cost,
			model_usage: { [model]: { input_tokens: 1, output_tokens: 1, cost, message_count: 1 } },
		});

	// 10 vs 10: insufficient, no delta.* facts to quote.
	const small = [];
	for (let d = 1; d <= 10; d++) small.push(withModel(`old${d}`, d, "openai/gpt-5.5", 10));
	for (let d = 11; d <= 20; d++) small.push(withModel(`new${d}`, d, "anthropic/claude-opus-5", 5));
	const smallTemporal = computeTemporalData(small, new Map());
	assert.equal(smallTemporal.delta?.insufficient, true);
	const smallFacts = buildFacts(aggregateData(small, new Map()), smallTemporal);
	const smallDeltaFacts = smallFacts.filter((f) => f.id.startsWith("delta."));
	assert.deepEqual(smallDeltaFacts, [], `expected no delta.* facts, got ${JSON.stringify(smallDeltaFacts.map((f) => f.id))}`);

	// 20 vs 20: sufficient, delta.* facts present with the real numbers.
	const large = [];
	for (let d = 1; d <= 20; d++) large.push(withModel(`old${d}`, d, "openai/gpt-5.5", 10));
	for (let d = 21; d <= 40; d++) large.push(withModel(`new${d}`, d, "anthropic/claude-opus-5", 5));
	const largeTemporal = computeTemporalData(large, new Map());
	assert.equal(largeTemporal.delta?.insufficient, false);
	const largeFacts = buildFacts(aggregateData(large, new Map()), largeTemporal);
	const byId = new Map(largeFacts.map((f) => [f.id, f]));
	assert.equal(byId.get("delta.cost_per_session")?.value, -50);
});

test("trajectory.* facts are present once both windows clear MIN_WINDOW_SESSIONS, and absent when insufficient", () => {
	const start = Date.UTC(2026, 8, 1, 0);
	const stepMs = (6 * 86400000) / 78; // 79 sessions spread across 6 days, well inside one week
	const metas = [];
	for (let i = 0; i < 79; i++) {
		const older = i < 59;
		metas.push(meta({
			session_id: `s${i}`,
			start_time: new Date(start + i * stepMs).toISOString(),
			total_cost: older ? 10 : 5,
			cost_primary: older ? 10 : 5,
			tool_errors: older ? 2 : 1,
			model_usage: { "anthropic/claude-opus-5": { input_tokens: 1, output_tokens: 1, cost: older ? 10 : 5, message_count: 1 } },
		}));
	}
	const agg = aggregateData(metas, new Map());
	const temporal = computeTemporalData(metas, new Map());
	const facts = buildFacts(agg, temporal);
	const byId = new Map(facts.map((f) => [f.id, f]));

	const costPct = byId.get("trajectory.cost_per_session")!;
	assert.equal(costPct.unit, "pct");
	assert.equal(costPct.value, -50);
	assert.equal(costPct.n, 79);
	assert.equal(byId.get("trajectory.cost_per_session.recent")!.value, 5);
	assert.equal(byId.get("trajectory.cost_per_session.older")!.value, 10);

	// Insufficient: a single session has no trajectory.* facts at all.
	const soloTemporal = computeTemporalData([meta({ session_id: "solo" })], new Map());
	const soloFacts = buildFacts(aggregateData([meta({ session_id: "solo" })], new Map()), soloTemporal);
	assert.deepEqual(soloFacts.filter((f) => f.id.startsWith("trajectory.")), []);
});
