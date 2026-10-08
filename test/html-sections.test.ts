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

// ── D16: collapsible sections ──────────────────────────────────────────────

test("every rpt-section is a <details> with an id; only at-a-glance opens by default (D16)", async () => {
	const html = await buildFixtureHtml();
	const sections = [...html.matchAll(/<details class="rpt-section" id="([^"]+)"( open)?>/g)];
	assert.ok(sections.length >= 9, `found ${sections.length} report sections`);

	const openIds = sections.filter((m) => m[2]).map((m) => m[1]);
	assert.deepEqual(openIds.sort(), ["at-a-glance"]);

	const closedIds = sections.filter((m) => !m[2]).map((m) => m[1]);
	for (const id of ["stats", "projects", "style", "what-works", "friction", "suggestions", "horizon", "model-efficiency"])
		assert.ok(closedIds.includes(id), `${id} should be closed by default`);
});

test("the What Changed block opens by default when present (D16)", async () => {
	const sections = JSON.parse(await readFile(FIXTURE, "utf-8"));
	const temporal = {
		diff_headlines: ["Cost per session down 20%"],
		major_transition: null,
		anomalies: [],
		delta: null,
	} as any;
	const agg = aggregateData([], new Map());
	const html = generateHTML(agg, sections, {}, temporal);
	assert.match(html, /<details class="rpt-section" id="what-changed" open>/);
});

test("copyable-prompt blocks render inside a nested, closed <details> (D16)", async () => {
	const html = await buildFixtureHtml();
	const nested = [...html.matchAll(/<details class="nested"[^>]*>/g)];
	assert.ok(nested.length >= 2, `found ${nested.length} nested details`);
	for (const m of nested) assert.ok(!/\bopen\b/.test(m[0]), `nested details must not be open: ${m[0]}`);

	// The usage-pattern's copyable prompt text is still present in the DOM
	// (just hidden), so copy-from-box keeps working on a collapsed block.
	assert.match(html, /Scout src\/render for every call site of generateHTML before editing\./);
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

	// s-aaa111 has a known path: rendered as a link.
	assert.match(html, /<a href="file:\/\/\/sessions\/proj\/log0\.jsonl">s-aaa111<\/a>/);
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

// ── D21: demoted charts ─────────────────────────────────────────────────────

test("time-of-day, languages and response-time charts sit inside a collapsed Numbers details (D21)", async () => {
	const html = await buildFixtureHtml();
	const match = html.match(/<details class="nested" id="numbers">([\s\S]*?)<\/details>/);
	assert.ok(match, "numbers details not found");
	assert.ok(!/\bopen\b/.test(match![0].split("\n")[0] ?? ""));

	const inside = match![1]!;
	for (const title of ["Languages", "Response Times", "Time of Day"]) assert.match(inside, new RegExp(`<h3>${title}`));

	// The other charts stay directly in the Stats section, not demoted.
	const beforeNumbers = html.slice(0, html.indexOf('<details class="nested" id="numbers">'));
	for (const title of ["Goal Categories", "Outcomes", "Satisfaction", "Top Tools", "Friction Types", "Tool Errors"])
		assert.match(beforeNumbers, new RegExp(`<h3>${title}`));
});

// ── Budget ───────────────────────────────────────────────────────────────────

function visibleWordCount(html: string): number {
	const stripped = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "");
	const tokens = stripped.split(/(<\/?details\b[^>]*>)/gi);
	const stack: boolean[] = [];
	let words = 0;
	for (const tok of tokens) {
		const open = tok.match(/^<details\b([^>]*)>$/i);
		if (open) {
			stack.push(/\bopen\b/.test(open[1]!));
			continue;
		}
		if (/^<\/details>$/i.test(tok)) {
			stack.pop();
			continue;
		}
		if (stack.some((v) => v === false)) continue;
		const text = tok.replace(/<[^>]+>/g, " ");
		words += text.split(/\s+/).filter(Boolean).length;
	}
	return words;
}

test("visible words in the default (collapsed) view stay under 1000 (Budget)", async () => {
	const html = await buildFixtureHtml();
	const words = visibleWordCount(html);
	assert.ok(words < 1000, `visible word count ${words} >= 1000`);
});
