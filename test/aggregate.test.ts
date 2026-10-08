// SPDX-FileCopyrightText: 2026 Tobias Hoelzer (omp port)
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { test } from "node:test";
import { aggregateData, buildSessionMeta, computeTemporalData, generateHTML } from "../index.ts";
import { meta } from "./helpers.ts";

// Local wall-clock time: active time is bucketed per local calendar day.
const at = (day: number, hour: number, min = 0) => new Date(2026, 8, day, hour, min);
const local = (day: number, hour: number, min = 0) => at(day, hour, min).toISOString();
const span = (id: string, day: number, hour: number, min: number, minutes: number) =>
	meta({
		session_id: id,
		start_time: local(day, hour, min),
		active_intervals: [[local(day, hour, min), new Date(at(day, hour, min).getTime() + minutes * 60_000).toISOString()]],
	});

test("active time is the union of overlapping sessions, not their sum", () => {
	const agg = aggregateData([span("a", 1, 9, 0, 60), span("b", 1, 9, 30, 60), span("c", 1, 9, 45, 5)], new Map());

	// 9:00-10:30 covered once; a plain sum would read 2.08h.
	assert.equal(agg.total_duration_hours, 1.5);
	assert.deepEqual(agg.active_hours_by_day, { "2026-09-01": 1.5 });
});

test("active time never exceeds 24h on any day, however many sessions overlap", () => {
	const metas = [];
	for (let day = 1; day <= 30; day++) {
		for (let i = 0; i < 10; i++) metas.push(span(`d${day}-${i}`, day, 8, 0, 600));
	}
	const agg = aggregateData(metas, new Map());

	assert.equal(Object.keys(agg.active_hours_by_day).length, 30);
	for (const [day, hours] of Object.entries(agg.active_hours_by_day)) {
		assert.ok(hours <= 24, `${day} has ${hours}h`);
		assert.equal(hours, 10);
	}
	assert.equal(agg.total_duration_hours, 300);
});

test("a session running past midnight is split across both days", () => {
	const agg = aggregateData([span("late", 1, 23, 0, 120)], new Map());
	assert.deepEqual(agg.active_hours_by_day, { "2026-09-01": 1, "2026-09-02": 1 });
});

test("a session left open counts only its runs of activity, not the idle gap", () => {
	const msg = (d: Date, role: string) => ({
		type: "message",
		timestamp: d.toISOString(),
		message: role === "user"
			? { role, attribution: "user", content: [{ type: "text", text: "go" }], timestamp: d.getTime() }
			: { role, content: [], timestamp: d.getTime() },
	});
	const m = buildSessionMeta(
		{
			id: "idle",
			path: "/sessions/proj/idle.jsonl",
			project_path: "/Users/me/projects/peach",
			size: 1,
			created: at(1, 9),
			modified: at(1, 13, 10),
			sidecars: [],
			signature: "1:1",
		},
		[
			{ type: "session", version: 3, id: "idle", timestamp: local(1, 9), cwd: "/Users/me/projects/peach" },
			msg(at(1, 9), "user"),
			msg(at(1, 9, 5), "assistant"),
			msg(at(1, 13), "user"),
			msg(at(1, 13, 10), "toolResult"),
		],
		[],
	);

	assert.deepEqual(m.active_intervals, [[local(1, 9), local(1, 9, 5)], [local(1, 13), local(1, 13, 10)]]);
	const agg = aggregateData([m], new Map());
	assert.equal(agg.total_duration_hours, 0.25);
});

test("interruption card and rate share one numerator with an aborted/steered breakdown", () => {
	const agg = aggregateData(
		[
			meta({
				session_id: "s",
				user_message_count: 20,
				steering_messages: 2,
				user_interruptions: 2,
				aborted_generations: 3,
				aborted_at_session_end: 1,
			}),
		],
		new Map(),
	);

	assert.equal(agg.total_interruptions, 4);
	assert.equal(Math.round(agg.interruption_rate * agg.total_messages), agg.total_interruptions);
	assert.equal(agg.interruptions_aborted, 2);
	assert.equal(agg.interruptions_steered, 2);

	const html = generateHTML(agg, {}, {}, computeTemporalData([], new Map()));
	const card = html.match(/<div class="stat-card">\s*<div class="stat-value">(\d+)<\/div>\s*<div class="stat-label">Interruptions<\/div>\s*<div class="stat-sub">([^<]*)<\/div>/);
	assert.ok(card, "interruptions card not found");
	assert.equal(card[1], "4");
	assert.match(card[2]!, /aborted 2 \/ steered 2/);
});
