// SPDX-FileCopyrightText: 2026 Tobias Hoelzer (omp port)
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { test } from "node:test";
import { aggregateData, computeTemporalData, generateHTML, type SessionFacets } from "../index.ts";
import { meta } from "./helpers.ts";

test("every stat card and chart in the HTML report states its sample size", () => {
	const facetsMap = new Map<string, SessionFacets>();
	const metas = [];
	for (let i = 0; i < 5; i++) {
		const id = `s${i}`;
		metas.push(meta({
			session_id: id,
			start_time: new Date(Date.UTC(2026, 8, 1 + i, 9)).toISOString(),
			user_message_count: 4,
			user_response_times: [10, 20],
			message_hours: [9, 9, 10, 11],
			tool_counts: { bash: 3, read: 2 },
			tool_calls_by_tool: { bash: 3, read: 2 },
			tool_errors: 1,
			tool_error_categories: { "Shell Failed": 1 },
			languages: { TypeScript: 2 },
			model_usage: { "claude-opus-5": { input_tokens: 10, output_tokens: 5, cost: 1, message_count: 4 } },
		}));
		// Only 3 of the 5 sessions have facets; 2 of those report friction.
		if (i < 3) facetsMap.set(id, {
			session_id: id, underlying_goal: "g", goal_categories: { debugging: 1 }, outcome: "fully_achieved",
			user_satisfaction_counts: { satisfied: 2, frustrated: 1 }, assistant_helpfulness: "very_helpful",
			session_type: "single_task", friction_counts: i < 2 ? { buggy_code: 1 } : {},
			friction_detail: "", primary_success: "none", brief_summary: "x",
		});
	}
	const agg = aggregateData(metas, facetsMap);
	const html = generateHTML(agg, {}, {}, computeTemporalData(metas, facetsMap));

	const cardBlocks = html.split('<div class="stat-card"').slice(1).map((b) => b.split("\n</div>")[0]!);
	assert.ok(cardBlocks.length >= 12, `found ${cardBlocks.length} cards`);
	for (const block of cardBlocks) assert.match(block, /n=\d+/, `card without n: ${block.replace(/\s+/g, " ").slice(0, 120)}`);

	const charts = [...html.matchAll(/<div class="chart-box">\s*<h3>([^]*?)<\/h3>/g)].map((m) => m[1]!);
	assert.ok(charts.length >= 9, `found ${charts.length} charts`);
	for (const h of charts) assert.match(h, /n=\d+/, `chart without n: ${h}`);

	const chartN = (title: string) => charts.find((h) => h.startsWith(title))?.match(/n=(\d+)/)?.[1];
	assert.equal(chartN("Outcomes"), "3");
	assert.equal(chartN("Satisfaction"), "9");
	assert.equal(chartN("Friction Types"), "2");
	assert.equal(chartN("Top Tools"), "25");
	assert.equal(chartN("Response Times"), "10");
	assert.equal(chartN("Time of Day"), "20");

	const cardN = (label: string) => cardBlocks.find((b) => b.includes(`stat-label">${label}<`))?.match(/n=(\d+)/)?.[1];
	assert.equal(cardN("Interruptions"), "20");
	assert.equal(cardN("Tool Errors"), "25");
	assert.equal(cardN("Total Cost"), "5");
});
