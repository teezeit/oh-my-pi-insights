// SPDX-FileCopyrightText: 2026 Tobias Hoelzer (omp port)
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aggregateData, computeTemporalData, generateHTML, resolveTargetPath, type SessionFacets } from "../index.ts";
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

test("the action list is a numbered <ol> with no checkbox inputs", () => {
	const metas = [meta({ session_id: "s1" })];
	const agg = aggregateData(metas, new Map());
	const temporal = computeTemporalData(metas, new Map());
	const sections = {
		suggestions: {
			config_additions: [{ addition: "Add a rule", why: "because", where: "AGENTS.md" }],
			stop_doing: [{ what: "Retrying", why: "wastes time", alternative: "Start fresh" }],
		},
	};
	const html = generateHTML(agg, sections, {}, temporal);
	const actionListBlock = html.slice(html.indexOf('id="action-list"'), html.indexOf("</ol>"));
	assert.match(actionListBlock, /<ol class="action-list">/);
	assert.ok(!/type="checkbox"/.test(actionListBlock), "action list must not contain checkboxes");
});

test("Summary has no standalone what-changed section; 'Since Last Report' only renders when temporal changes exist", () => {
	const metas = [meta({ session_id: "s1" })];
	const agg = aggregateData(metas, new Map());
	const temporalNoChange = computeTemporalData(metas, new Map());
	const htmlNoChange = generateHTML(agg, {}, {}, temporalNoChange);
	assert.ok(!htmlNoChange.includes("Since Last Report"));
	assert.ok(!htmlNoChange.includes('id="what-changed"'));
	assert.ok(!htmlNoChange.includes(">What Changed<"));

	const temporalWithChange = { ...temporalNoChange, diff_headlines: ["Cost dropped 20%"] };
	const htmlWithChange = generateHTML(agg, {}, {}, temporalWithChange);
	assert.ok(htmlWithChange.includes("Since Last Report"));
	assert.match(htmlWithChange, /Cost dropped 20%/);
});

test("evidence links show the `omp -r <id>` replay command with a copy button", () => {
	const metas = [meta({ session_id: "sess-evidence-1" })];
	const agg = aggregateData(metas, new Map());
	const temporal = computeTemporalData(metas, new Map());
	const sections = {
		friction_analysis: {
			ongoing: [{ category: "Flaky tool", description: "desc", examples: [], evidence_sessions: ["sess-evidence-1"] }],
		},
	};
	const sessionPaths = { "sess-evidence-1": "/fixture/sessions/sess-evidence-1.jsonl" };
	const html = generateHTML(agg, sections, {}, temporal, { sessionPaths });
	assert.match(html, /omp -r sess-evidence-1/);
	assert.match(html, /class="evidence-cmd"/);
});

test("summary elements carry the chevron class with no native details marker", () => {
	const metas = [meta({ session_id: "s1" })];
	const agg = aggregateData(metas, new Map());
	const temporal = computeTemporalData(metas, new Map());
	const html = generateHTML(agg, {}, {}, temporal);
	assert.match(html, /<summary class="chevron-summary">/);
	assert.match(html, /summary\.chevron-summary::-webkit-details-marker \{ display: none; \}/);
	assert.match(html, /summary\.chevron-summary::after/);
});

test("cost label switches to API-equivalent when subscription_cost is positive", () => {
	const metas = [meta({ session_id: "s1" })];
	const agg = aggregateData(metas, new Map());
	const temporal = computeTemporalData(metas, new Map());
	const aggWithSub = { ...agg, subscription_cost: 2.5, billed_cost: 0.5 };
	const html = generateHTML(aggWithSub, {}, {}, temporal);
	assert.match(html, /API-equivalent Cost/);
	assert.match(html, /billed: \$0\.50/);
});

test("How You Work renders C2 blocks and still accepts the legacy narrative shape", () => {
	const metas = [meta({ session_id: "s1" })];
	const agg = aggregateData(metas, new Map());
	const temporal = computeTemporalData(metas, new Map());
	const htmlBlocks = generateHTML(agg, {
		interaction_style: {
			blocks: [{ title: "Fast iterator", body: "Short loops." }, { title: "Heavy steerer", body: "Steers often." }],
			key_pattern: "Iterate then steer.",
		},
	}, {}, temporal);
	assert.match(htmlBlocks, /style-block-card/);
	assert.match(htmlBlocks, /Fast iterator/);
	assert.match(htmlBlocks, /Iterate then steer\./);

	const htmlNarrative = generateHTML(agg, {
		interaction_style: { narrative: "You iterate quickly.", key_pattern: "Fast." },
	}, {}, temporal);
	assert.match(htmlNarrative, /You iterate quickly\./);
});

const FIXTURE = join(import.meta.dirname, "fixtures", "d-sections.json");

test("rendered HTML report contains no emoji/pictograph characters anywhere", async () => {
	const sections = JSON.parse(await readFile(FIXTURE, "utf-8"));
	const metas = [meta({ session_id: "s1" })];
	const agg = aggregateData(metas, new Map());
	const temporal = computeTemporalData(metas, new Map());
	const synthesis = {
		whats_working: "Fast iteration \u{1F680} on small edits.",
		whats_hindering: "Stale context \u2728 reloads.",
	};
	const html = generateHTML(agg, { ...sections, fun_ending: { headline: "Nice \u2705 run" } }, synthesis, temporal);
	const emojiMatch = html.match(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
	assert.equal(emojiMatch, null, `found emoji character: ${emojiMatch?.[0]}`);
});

test("every copy button has a non-empty title tooltip and never bare 'Copy' text", async () => {
	const sections = JSON.parse(await readFile(FIXTURE, "utf-8"));
	const agg = aggregateData([], new Map());
	const temporal = computeTemporalData([], new Map());
	const html = generateHTML(agg, sections, {}, temporal, { sessionPaths: { "s-aaa111": "/sessions/proj/log0.jsonl" } });

	const buttons = [...html.matchAll(/<button class="copy-btn[^"]*"([^>]*)>([^<]*)<\/button>/g)];
	assert.ok(buttons.length >= 3, `found ${buttons.length} copy buttons`);
	for (const [, attrs, text] of buttons) {
		assert.notEqual(text!.trim(), "Copy", `bare "Copy" button text: ${text}`);
		assert.match(attrs!, /\btitle="[^"]+"/, `copy button missing a non-empty title: ${attrs}`);
	}
});

test("config addition meta row shows an APPLIES TO label with a file target, not a bare path on the title", async () => {
	const sections = JSON.parse(await readFile(FIXTURE, "utf-8"));
	const agg = aggregateData([], new Map());
	const temporal = computeTemporalData([], new Map());
	const html = generateHTML(agg, sections, {}, temporal);

	// A link when the target exists on this machine, plain text otherwise; resolveTargetPath has its own deterministic test.
	assert.match(html, /<span class="meta-label">APPLIES TO<\/span> <(span|a) class="file-target[^"]*"[^>]*><svg[\s\S]*?<\/svg><span>AGENTS\.md<\/span>/);
	assert.doesNotMatch(html, /<h3 class="advice-title">[^<]*AGENTS\.md[^<]*<\/h3>/);
});

test("resolveTargetPath links only targets that exist: ~/ and absolute paths directly, bare names via the agent dir", async () => {
	const root = await mkdtemp(join(tmpdir(), "omp-insights-target-"));
	try {
		const agentDir = join(root, "agent");
		await mkdir(join(root, "home", "x"), { recursive: true });
		await mkdir(agentDir, { recursive: true });
		await writeFile(join(agentDir, "AGENTS.md"), "");
		await writeFile(join(root, "home", "x", "f.ts"), "");
		const home = join(root, "home");
		assert.equal(resolveTargetPath("AGENTS.md", agentDir, home), join(agentDir, "AGENTS.md"));
		assert.equal(resolveTargetPath("RULES.md", agentDir, home), null);
		assert.equal(resolveTargetPath("~/x/f.ts", agentDir, home), join(home, "x", "f.ts"));
		assert.equal(resolveTargetPath("~/x/missing.ts", agentDir, home), null);
		assert.equal(resolveTargetPath("src/foo.ts", agentDir, home), null);
	} finally {
		await rm(root, { recursive: true });
	}
});

test("evidence line orders the replay command, then the copy button, then the file icon link, with no bare short-id anchor", async () => {
	const agg = aggregateData([], new Map());
	const temporal = computeTemporalData([], new Map());
	const sections = {
		friction_analysis: {
			ongoing: [{ category: "Flaky tool", description: "desc", examples: [], evidence_sessions: ["sess-evidence-1"] }],
		},
	};
	const sessionPaths = { "sess-evidence-1": "/fixture/sessions/sess-evidence-1.jsonl" };
	const html = generateHTML(agg, sections, {}, temporal, { sessionPaths });

	const evidenceBlock = html.slice(html.indexOf('<div class="evidence">'), html.indexOf("</div>", html.indexOf('<div class="evidence">')) + 6);
	const cmdIdx = evidenceBlock.indexOf("omp -r sess-evidence-1");
	const btnIdx = evidenceBlock.indexOf("Copy command");
	const iconIdx = evidenceBlock.indexOf("file-icon-link");
	assert.ok(cmdIdx >= 0 && btnIdx > cmdIdx && iconIdx > btnIdx, `expected command < button < icon order, got ${cmdIdx}, ${btnIdx}, ${iconIdx}`);
	assert.ok(!/<a href="file:\/\/[^"]*">sess-evidence-1<\/a>/.test(html), "bare short-id anchor must not be rendered");
});
