// SPDX-FileCopyrightText: 2026 Tobias Hoelzer (omp port)
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { aggregateData, buildSessionMeta, computeTemporalData, generateHTML } from "../index.ts";

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

// ── Sections: plain, never collapsible ─────────────────────────────────────

test("report sections are plain <section> blocks with ids and no toggles anywhere", async () => {
	const html = await buildFixtureHtml();
	const ids = [...html.matchAll(/<section class="rpt-section" id="([^"]+)">/g)].map((m) => m[1]);
	for (const id of ["at-a-glance", "stats", "projects", "style", "what-works", "friction", "suggestions", "horizon", "model-efficiency"])
		assert.ok(ids.includes(id), `missing section ${id}`);
	assert.doesNotMatch(html, /<details\b|<summary\b/);
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
	const numbersIdx = html.indexOf('<div id="numbers">');
	assert.ok(numbersIdx > -1, "numbers block not found");
	const inside = html.slice(numbersIdx, html.indexOf("</section>", numbersIdx));
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
