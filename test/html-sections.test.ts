// SPDX-FileCopyrightText: 2026 Tobias Hoelzer (omp port)
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { aggregateData, buildSessionMeta, computeTemporalData, generateHTML } from "../index.ts";
import { meta } from "./helpers.ts";

const FIXTURE = join(import.meta.dirname, "fixtures", "d-sections.json");

function buildFixtureHtml(sessionPaths: Record<string, string> = {}) {
	return readFile(FIXTURE, "utf-8").then((raw) => {
		const sections = JSON.parse(raw);
		const metas = [];
		for (let i = 0; i < 6; i++) {
			metas.push(
				buildSessionMeta(
					{
						id: `s-${i}`,
						path: `/sessions/proj/log${i}.jsonl`,
						project_path: "/Users/me/projects/acme",
						size: 1,
						created: new Date(Date.UTC(2026, 8, 1 + i, 9)),
						modified: new Date(Date.UTC(2026, 8, 1 + i, 9, 30)),
						sidecars: [],
						signature: "1:1",
					},
					[],
					[],
				),
			);
		}
		const agg = aggregateData(metas, new Map());
		const temporal = computeTemporalData(metas, new Map());
		const synthesis = {
			whats_working: "Fast iteration on small, well-scoped edits.",
			whats_hindering: "Stale context reloads on resumed sessions.",
			quick_wins: "Add the AGENTS.md rule about running the changed test first.",
			ambitious_workflows: "Autonomous dependency bumps with full-suite verification.",
		};
		return generateHTML(agg, sections, synthesis, temporal, { sessionPaths });
	});
}

// ── Sections: only Top Actions and Summary stay open; everything else collapses ──

test("Top Actions and Summary are plain <section> blocks, never <details>", async () => {
	const html = await buildFixtureHtml();
	const ids = [...html.matchAll(/<section class="rpt-section" id="([^"]+)">/g)].map((m) => m[1]);
	assert.deepEqual(ids.sort(), ["action-list", "at-a-glance"]);
});

test("every other section is a collapsed <details> without the open attribute", async () => {
	const html = await buildFixtureHtml();
	for (const id of ["stats", "projects", "style", "what-works", "friction", "suggestions", "horizon", "model-efficiency"]) {
		assert.match(html, new RegExp(`<details class="rpt-section" id="${id}">\\s*<summary><h2>`), `${id} is not a collapsed <details>`);
		assert.doesNotMatch(html, new RegExp(`<details[^>]*id="${id}"[^>]*\\bopen\\b`), `${id} must not default open`);
	}
});

test("nested heavy chart blocks (Numbers, Flagged Sessions) are also collapsed <details>", async () => {
	const html = await buildFixtureHtml();
	assert.match(html, /<details class="nested-collapse" id="numbers"[^>]*>\s*<summary><h3>Languages, time of day, response times<\/h3>/);
	assert.doesNotMatch(html, /<details[^>]*id="numbers"[^>]*\bopen\b/);
});

test("changes render as a non-collapsible 'Since Last Report' block inside Summary, not a standalone section", async () => {
	const sections = JSON.parse(await readFile(FIXTURE, "utf-8"));
	const temporal = {
		diff_headlines: ["Cost per session down 20%"],
		major_transition: null,
		anomalies: [],
		delta: null,
	} as any;
	const agg = aggregateData([], new Map());
	const html = generateHTML(agg, sections, {}, temporal);
	assert.match(html, /since-last-report[\s\S]*Cost per session down 20%/);
	assert.doesNotMatch(html, /id="what-changed"/);
});

test("a model change produces exactly one model-shift line in the rendered HTML summary", async () => {
	const sections = JSON.parse(await readFile(FIXTURE, "utf-8"));
	const day = (d: number) => new Date(Date.UTC(2026, 8, d, 9)).toISOString();
	const withModel = (id: string, d: number, model: string) =>
		meta({
			session_id: id,
			start_time: day(d),
			total_cost: 10,
			cost_primary: 10,
			model_usage: { [model]: { input_tokens: 1, output_tokens: 1, cost: 10, message_count: 1 } },
		});
	const metas = [];
	for (let d = 1; d <= 10; d++) metas.push(withModel(`old${d}`, d, "openai/gpt-5.5"));
	for (let d = 11; d <= 20; d++) metas.push(withModel(`new${d}`, d, "anthropic/claude-opus-5"));

	const agg = aggregateData(metas, new Map());
	const temporal = computeTemporalData(metas, new Map());
	const html = generateHTML(agg, sections, {}, temporal);

	const block = html.match(/<div class="at-a-glance-part since-last-report">[\s\S]*?<\/div>/);
	assert.ok(block, "Since Last Report block not found");
	const shiftMentions = (block![0].match(/shifted/gi) ?? []).length;
	assert.equal(shiftMentions, 1, `expected exactly one model-shift line, got: ${block![0]}`);
});

// ── Issue #13: trajectory rendered + delta-null reason shown ───────────────

test("Since Last Report shows the trajectory line (n=20 vs n=59) and a no-previous-week reason when delta is null", async () => {
	const sections = JSON.parse(await readFile(FIXTURE, "utf-8"));
	const start = Date.UTC(2026, 8, 1, 0);
	const stepMs = (6 * 86400000) / 78; // 79 sessions spread across 6 days, well inside one week
	const metas = [];
	for (let i = 0; i < 79; i++) {
		const older = i < 59; // first 59 = older window, last 20 = recent window
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
	assert.equal(temporal.delta, null, "all 79 sessions fall inside one week, so no previous week exists for a delta");
	assert.ok(temporal.trajectory.windows, "trajectory must be sufficient (20 recent vs 59 older)");

	const html = generateHTML(agg, sections, {}, temporal);
	const block = html.match(/<div class="at-a-glance-part since-last-report">[\s\S]*?<\/div>/);
	assert.ok(block, "Since Last Report block must not vanish when the trajectory has content");
	assert.match(block![0], /Last 20 vs previous 59 sessions/);
	assert.match(block![0], /No previous week inside this report window/);
});

test("Since Last Report has no trajectory line when the trajectory is insufficient", async () => {
	const sections = JSON.parse(await readFile(FIXTURE, "utf-8"));
	const metas = [meta({ session_id: "solo" })];
	const agg = aggregateData(metas, new Map());
	const temporal = computeTemporalData(metas, new Map());
	assert.equal(temporal.trajectory.windows, undefined);

	const html = generateHTML(agg, sections, {}, temporal);
	assert.ok(!html.includes("Last 20 vs previous"));
});

test("copyable prompts are shown directly, not behind a toggle", async () => {
	const html = await buildFixtureHtml();
	assert.match(html, /<div class="copy-box">Scout src\/render for every call site of generateHTML before editing\.<\/div>/);
});

test("no script beyond the existing copy-to-clipboard script is added (D16)", async () => {
	const html = await buildFixtureHtml();
	const scriptTags = html.match(/<script\b/g) ?? [];
	assert.equal(scriptTags.length, 1);
	assert.match(html, /function copyFromBox/);
});

// ── D19: traceable evidence ────────────────────────────────────────────────

test("every stat card carries a title with a definition, n and window (D19)", async () => {
	const html = await buildFixtureHtml();
	const cards = [...html.matchAll(/<div class="stat-card" title="([^"]+)">/g)].map((m) => m[1]);
	assert.ok(cards.length >= 10, `found ${cards.length} stat cards`);
	for (const title of cards) assert.match(title, /n=\d+.*\.\.\d{4}-\d{2}-\d{2}\)$|n=\d+ .*\)$/);

	const sessionsTitle = cards.find((t) => t.includes("substantive sessions in the report"));
	assert.ok(sessionsTitle, "Sessions card must quote its fact definition");
	assert.match(sessionsTitle!, /n=\d+ sessions/);
	assert.match(sessionsTitle!, /\d{4}-\d{2}-\d{2}\.\.\d{4}-\d{2}-\d{2}/);
});

test("evidence_sessions on a friction/config/suggestion item links known ids to file://<session_path> (D19)", async () => {
	const html = await buildFixtureHtml({ "s-aaa111": "/sessions/proj/log0.jsonl" });

	// s-aaa111 has a known path: rendered as the omp -r command plus a file icon link.
	assert.match(html, /omp -r s-aaa111/);
	assert.match(html, /<a class="file-icon-link" href="file:\/\/\/sessions\/proj\/log0\.jsonl"/);
	// s-bbb222 has no known path: dropped, not linked to a dead href.
	assert.ok(!html.includes("s-bbb222"));
});

test("an item with no evidence_sessions renders no evidence line", async () => {
	const html = await buildFixtureHtml();
	// The second config_addition in the fixture carries no evidence_sessions.
	const idx = html.indexOf("Set retry.fallbackChains.default");
	const slice = html.slice(idx, idx + 400);
	assert.ok(!slice.includes('class="evidence"'));
});

// ── D21: secondary charts ───────────────────────────────────────────────────

test("languages, response-time and time-of-day charts follow the primary charts in the Stats section (D21)", async () => {
	const html = await buildFixtureHtml();
	const numbersIdx = html.indexOf('id="numbers"');
	assert.ok(numbersIdx > -1, "numbers block not found");
	const inside = html.slice(numbersIdx, html.indexOf("</details>", numbersIdx));
	for (const title of ["Languages", "Response Times", "Time of Day"]) assert.match(inside, new RegExp(`<h3>${title}`));
	const before = html.slice(html.indexOf('id="stats"'), numbersIdx);
	for (const title of ["Goal Categories", "Outcomes", "Satisfaction", "Top Tools", "Friction Types", "Tool Errors"])
		assert.match(before, new RegExp(`<h3>${title}`));
});

test("a friction card's type is a pill that links to its row in the Friction Types chart", async () => {
	const sections = { friction_analysis: { ongoing: [{ category: "Agent Too Slow", description: "d", examples: [] }, { category: "Novel Thing", description: "d", examples: [] }] } };
	const agg = { ...aggregateData([], new Map()), friction: { agent_too_slow: 4 } };
	const html = generateHTML(agg, sections, {}, computeTemporalData([], new Map()));
	assert.match(html, /<div class="bar-row" id="friction-type-agent-too-slow">[\s\S]*?<span class="category-pill friction">Agent Too Slow<\/span>/);
	assert.match(html, /<a class="category-pill friction" href="#friction-type-agent-too-slow"[^>]*>Agent Too Slow<\/a>/);
	// A type the chart does not show stays a pill but is not a dead link.
	assert.match(html, /<span class="category-pill friction">Novel Thing<\/span>/);
	assert.doesNotMatch(html, /href="#friction-type-novel-thing"/);
});

test("a friction type still present in agg.friction is not rendered under Resolved, even though the chart still shows it", async () => {
	const prevSections = { friction_analysis: { ongoing: [{ category: "Wrong Approach", description: "d", examples: [] }] } };
	const sections = { friction_analysis: { ongoing: [{ category: "Other Thing", description: "d", examples: [] }] } };
	const agg = { ...aggregateData([], new Map()), friction: { wrong_approach: 14 } };
	const html = generateHTML(agg, sections, {}, computeTemporalData([], new Map()), { prevSections });

	// The chart still shows it (same deterministic data Resolved must agree with).
	assert.match(html, /id="friction-type-wrong-approach"/);
	// But it must not be claimed resolved: the reportDiff-derived "not in this
	// run's friction list anymore" phrasing never fires, and no Resolved
	// block names it.
	assert.ok(!html.includes("not in this run's friction list anymore"));
	assert.equal(html.indexOf(">Resolved<"), -1, "no Resolved section should render when nothing clears the agg.friction gate");
});

test("a resolved category whose slug contains a current friction slug as a token run is still treated as present (free-form LLM labels)", async () => {
	const sections = {
		friction_analysis: {
			resolved: [
				{ category: "User Rejected Action / destructive overreach", note: "no longer happens" },
				{ category: "Flaky Test Retries", note: "fixed the CI timeout" },
			],
		},
	};
	const agg = { ...aggregateData([], new Map()), friction: { user_rejected_action: 3 } };
	const html = generateHTML(agg, sections, {}, computeTemporalData([], new Map()));

	// Still present, loosely matched against the chart's slug "user-rejected-
	// action" as a token run (not exact slug equality): must not render under
	// Resolved.
	assert.ok(!html.includes("no longer happens"), "still-present type must not render under Resolved");
	// Genuinely absent from agg.friction: still renders as resolved.
	assert.ok(html.includes("fixed the CI timeout"), "genuinely absent type must still render under Resolved");
});
