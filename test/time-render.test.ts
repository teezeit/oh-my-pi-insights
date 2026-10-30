// SPDX-FileCopyrightText: 2026 Tobias Hoelzer (omp port)
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { test } from "node:test";
import { generateTimeHTML, renderTimeMarkdown, renderTimeSection, timeWidgetLines } from "../src/render/time.ts";
import type { TimeAggregate } from "../src/types.ts";

function agg(overrides: Partial<TimeAggregate> = {}): TimeAggregate {
	const buckets = { model: 7800, tools: 3600, agents: 1800, ci: 600, you: 1200, elsewhere: 300, idle: 900 };
	const active = buckets.model + buckets.tools + buckets.agents + buckets.ci + buckets.you + buckets.elsewhere;
	return {
		sessions: 12,
		date_range: { start: "2026-10-01", end: "2026-10-30" },
		buckets,
		active_sec: active,
		shares: {
			model: buckets.model / active,
			tools: buckets.tools / active,
			agents: buckets.agents / active,
			ci: buckets.ci / active,
			you: buckets.you / active,
			elsewhere: buckets.elsewhere / active,
			idle: buckets.idle / (active + buckets.idle),
		},
		busy_by_tool: { bash: 4000, read: 1200 },
		busy_by_command: { "npm test": 2400, "git push": 600 },
		subagent_busy_sec: 500,
		slowest_requests: [
			{ session_id: "abc-123", project: "jam/jar", prompt: "<script>alert(1)</script> fix the thing", wall_sec: 1800, active_sec: 1400, dominant_bucket: "tools" },
		],
		levers: [
			{ id: "slow_model", title: "Opus doing small work", detail: "Model time is dominated by claude-opus-5 on short requests.", share: 0.42, evidence_sessions: ["abc-123"] },
			{ id: "waiting_on_you", title: "Waiting on you", detail: "30% of active time is you responding to the agent.", share: 0.31, evidence_sessions: [] },
		],
		...overrides,
	};
}

function zeroAgg(): TimeAggregate {
	return {
		sessions: 0,
		date_range: { start: "", end: "" },
		buckets: { model: 0, tools: 0, agents: 0, ci: 0, you: 0, elsewhere: 0, idle: 0 },
		active_sec: 0,
		shares: { model: 0, tools: 0, agents: 0, ci: 0, you: 0, elsewhere: 0, idle: 0 },
		busy_by_tool: {},
		busy_by_command: {},
		subagent_busy_sec: 0,
		slowest_requests: [],
		levers: [],
	};
}

test("the time section shows all seven bucket labels with shares and durations, idle marked excluded", () => {
	const html = renderTimeSection(agg());
	for (const label of ["Model", "Tools", "Agents", "CI", "You", "You (busy elsewhere)", "Idle"]) {
		assert.ok(html.includes(label), `missing bucket label ${label}`);
	}
	assert.match(html, /\d+%/);
	assert.match(html, /\dh \d+m|\d+m|\d+s/);
	assert.ok(html.includes("excluded from active time"), "idle must be labelled as excluded from active time");
});

test("the time section shows the busy-elsewhere row with its share, duration and note, after You and before Idle", () => {
	const html = renderTimeSection(agg());
	const chartStart = html.indexOf('<div class="chart-box">');
	const chartEnd = html.indexOf("Subagent/advisor work ran");
	assert.ok(chartStart !== -1 && chartEnd !== -1 && chartStart < chartEnd, "bucket chart must render before the subagent summary line");
	// Rendered text only - not tied to how a row's markup is structured.
	const chartText = html
		.slice(chartStart, chartEnd)
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim();

	const youMatch = /\bYou\b(?!\s*\()/.exec(chartText);
	const elsewhereIdx = chartText.indexOf("You (busy elsewhere)");
	const idleMatch = /\bIdle\b/.exec(chartText);
	assert.ok(youMatch && elsewhereIdx !== -1 && idleMatch, "all three rows must be present");
	assert.ok(youMatch.index < elsewhereIdx && elsewhereIdx < idleMatch.index, "order must be You, You (busy elsewhere), Idle");
	assert.ok(
		chartText.includes("waited on you while you worked in another session; not counted as a speed lever"),
		"busy-elsewhere row must carry its note",
	);
	// 300s elsewhere of 15300s active = 2%
	assert.match(chartText, /You \(busy elsewhere\)[\s\S]{0,200}?2%[\s\S]{0,100}?5m/);
});

test("command text and prompts are HTML-escaped", () => {
	const html = renderTimeSection(agg());
	assert.ok(!html.includes("<script>alert(1)</script>"), "raw script tag must not appear unescaped");
	assert.ok(html.includes("&lt;script&gt;"), "prompt must be escaped");
});

test("generateTimeHTML includes an Explanation block only when opts.explain is given", () => {
	const withExplain = generateTimeHTML(agg(), { explain: "<b>why</b> this matters" });
	assert.ok(withExplain.includes("Explanation"));
	assert.ok(withExplain.includes("&lt;b&gt;why&lt;/b&gt;"));

	const withoutExplain = generateTimeHTML(agg());
	assert.ok(!withoutExplain.includes("Explanation"));
});

test("generateTimeHTML sets the title and reuses the report stylesheet", () => {
	const html = generateTimeHTML(agg());
	assert.ok(html.includes("Where the time goes"));
	assert.ok(html.includes(":root"));
	assert.ok(html.includes("2026-10-01"));
});

test("markdown section has the heading and a row per bucket, including busy-elsewhere with its note", () => {
	const md = renderTimeMarkdown(agg());
	assert.ok(md.startsWith("## Where the Time Goes"));
	for (const label of ["Model", "Tools", "Agents", "CI", "You", "You (busy elsewhere)", "Idle"]) {
		assert.ok(md.includes(label), `missing markdown row for ${label}`);
	}
	assert.ok(md.includes("waited on you while you worked in another session; not counted as a speed lever"));
	const youLine = md.split("\n").findIndex((l) => l.startsWith("| You |"));
	const elsewhereLine = md.split("\n").findIndex((l) => l.startsWith("| You (busy elsewhere)"));
	const idleLine = md.split("\n").findIndex((l) => l.startsWith("| Idle"));
	assert.ok(youLine !== -1 && elsewhereLine !== -1 && idleLine !== -1);
	assert.ok(youLine < elsewhereLine && elsewhereLine < idleLine, "order must be You, You (busy elsewhere), Idle");
});

test("the widget is at most 10 lines and includes a busy-elsewhere line with share and duration", () => {
	const lines = timeWidgetLines(agg());
	assert.ok(lines.length <= 10, `expected <=10 lines, got ${lines.length}`);
	assert.ok(lines[0].length > 0);
	const elsewhereLine = lines.find((l) => l.startsWith("You (busy elsewhere)"));
	assert.ok(elsewhereLine, "widget must include a busy-elsewhere line");
	assert.match(elsewhereLine!, /\d+%/);
	assert.match(elsewhereLine!, /\dh \d+m|\d+m|\d+s/);
});

test("a zero-session aggregate renders a no-data state without NaN, in every entry point", () => {
	const z = zeroAgg();
	const html = renderTimeSection(z);
	assert.ok(!html.includes("NaN"));
	assert.ok(/no data/i.test(html));

	const page = generateTimeHTML(z);
	assert.ok(!page.includes("NaN"));

	const md = renderTimeMarkdown(z);
	assert.ok(!md.includes("NaN"));

	const widget = timeWidgetLines(z);
	assert.ok(widget.every((l) => !l.includes("NaN")));
});

test("date_range renders as a local calendar date, not a raw ISO timestamp", () => {
	const isoAgg = agg({ date_range: { start: "2026-10-16T11:51:56.354Z", end: "2026-10-23T09:00:00.000Z" } });
	const html = renderTimeSection(isoAgg);
	assert.ok(!/T\d{2}:/.test(html), "ISO time-of-day must not leak into the rendered page");
	assert.ok(html.includes("2026-10-16") || html.includes("2026-10-15"), "expected a calendar date for the ISO start");

	const page = generateTimeHTML(isoAgg);
	assert.ok(!/T\d{2}:/.test(page), "ISO time-of-day must not leak into the standalone page header");

	const md = renderTimeMarkdown(isoAgg);
	assert.ok(!/T\d{2}:/.test(md), "ISO time-of-day must not leak into markdown");
});

test("the page header separator is a real character, never a double-escaped entity", () => {
	const page = generateTimeHTML(agg());
	assert.ok(!page.includes("&amp;nbsp;"), "separator must not be double-escaped");
});

test("slowest requests table has an Active column and is sorted by active_sec", () => {
	const multi = agg({
		slowest_requests: [
			{ session_id: "slow-wall", project: "p", prompt: "mostly idle", wall_sec: 5000, active_sec: 100, dominant_bucket: "tools" },
			{ session_id: "slow-active", project: "p", prompt: "mostly busy", wall_sec: 600, active_sec: 590, dominant_bucket: "model" },
		],
	});
	const html = renderTimeSection(multi);
	assert.ok(html.includes(">Active<"), "table must have an Active column header");
	const activeIdx = html.indexOf("slow-active");
	const wallIdx = html.indexOf("slow-wall");
	assert.ok(activeIdx >= 0 && wallIdx >= 0 && activeIdx < wallIdx, "higher active_sec must rank first");
});
