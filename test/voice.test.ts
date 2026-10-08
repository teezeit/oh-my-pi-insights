// SPDX-FileCopyrightText: 2026 Tobias Hoelzer (omp port)
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { test } from "node:test";
import { aggregateData, computeTemporalData, generateHTML, generateMarkdown, type ScanSummary, type SessionFacets, type UserContext } from "../index.ts";
import { meta } from "./helpers.ts";

// C14: naming and voice. C15: fun_ending is gone from both the sections type
// and the render output.

function fixtureUserCtx(): UserContext {
	return {
		existing_agents_md_rules: [],
		installed_skills: [],
		installed_managed_skills: [],
		installed_extensions: [],
		installed_hooks: [],
		mcp_servers: [],
		model_roles: { default: "anthropic/claude-opus-5" },
		fallback_chains: {},
		default_model: "anthropic/claude-opus-5",
		memory_backend: "learn",
	};
}

function fixtureScan(): ScanSummary {
	return {
		sessions_dir: "/fixture/sessions",
		source: "omp",
		cost_unavailable: 0,
		primary_logs: 1,
		facet_failures: 0,
		facets_analyzed: 0,
		duplicate_logs: 0,
		advisor_logs: 0,
		subagent_logs: 0,
		excluded_meta: 0,
		excluded_current: 0,
		excluded_unparsed: 0,
		excluded_not_substantive: 0,
		excluded_by_since: 0,
		excluded_tooling: 0,
		included: 1,
		reused_stale_sections: false,
	};
}

test("rendered HTML report has no 'Pi' naming or third-person 'the user' voice", () => {
	const metas = [meta({ session_id: "s1" })];
	const facetsMap = new Map<string, SessionFacets>();
	const agg = aggregateData(metas, facetsMap);
	const temporal = computeTemporalData(metas, facetsMap);
	const sections = {
		interaction_style: { narrative: "You iterate quickly and steer often.", key_pattern: "Fast iteration." },
		what_works: { intro: "Solid wins.", impressive_workflows: [{ title: "Ticket pipeline", description: "You batch reviews well." }] },
		friction_analysis: { intro: "Some friction remains.", ongoing: [{ category: "Browser automation", description: "Browser calls fail often.", examples: ["ex"] }] },
		suggestions: { stop_doing: [{ what: "Retrying stale sessions", why: "Evidence.", alternative: "Start fresh." }] },
		on_the_horizon: { intro: "Ambitious workflows ahead.", opportunities: [{ title: "Autonomous pipeline", whats_possible: "Self-correcting runs.", how_to_try: "Try it.", copyable_prompt: "do it" }] },
	};
	const synthesis = { whats_working: "You ship fast.", whats_hindering: "You stop to debug often." };

	const html = generateHTML(agg, sections, synthesis, temporal);

	assert.doesNotMatch(html, /\bPi\b/);
	assert.doesNotMatch(html, /\bthe user\b/i);
});

test("rendered HTML report has no fun_ending block", () => {
	const metas = [meta({ session_id: "s1" })];
	const agg = aggregateData(metas, new Map());
	const temporal = computeTemporalData(metas, new Map());
	const html = generateHTML(agg, { fun_ending: { headline: "A funny moment", detail: "it happened" } }, {}, temporal);
	assert.doesNotMatch(html, /fun-box/);
	assert.doesNotMatch(html, /A funny moment/);
});

test("rendered Markdown report has no 'Pi' naming or third-person 'the user' voice", () => {
	const metas = [meta({ session_id: "s1" })];
	const agg = aggregateData(metas, new Map());
	const temporal = computeTemporalData(metas, new Map());
	const md = generateMarkdown(agg, {}, {}, temporal, fixtureScan(), fixtureUserCtx());
	assert.doesNotMatch(md, /\bPi\b/);
	assert.doesNotMatch(md, /\bthe user\b/i);
});
