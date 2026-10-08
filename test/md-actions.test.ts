// SPDX-FileCopyrightText: 2026 Tobias Hoelzer (omp port)
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { aggregateData, computeTemporalData, generateMarkdown, type ScanSummary, type UserContext } from "../index.ts";

const FIXTURE = join(import.meta.dirname, "fixtures", "d-sections.json");

const scan: ScanSummary = {
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
	included: 0,
	reused_stale_sections: false,
};

const userCtx: UserContext = {
	existing_agents_md_rules: [],
	installed_skills: [],
	installed_managed_skills: [],
	installed_extensions: [],
	installed_hooks: [],
	mcp_servers: [],
	memory_backend: "learn",
	autolearn_enabled: false,
	model_roles: {},
	fallback_chains: {},
	default_model: "",
	config_yml_flat: {},
};

test("generateMarkdown starts with the action list as a numbered list (not `- [ ]`)", async () => {
	const sections = JSON.parse(await readFile(FIXTURE, "utf-8"));
	const agg = aggregateData([], new Map());
	const temporal = computeTemporalData([], new Map());
	const md = generateMarkdown(agg, sections, {}, temporal, scan, userCtx);

	const headings = [...md.matchAll(/^## .+$/gm)].map((m) => m[0]);
	assert.equal(headings[0], "## Top Actions");

	const actionBlock = md.slice(md.indexOf(headings[0]!), md.indexOf(headings[1]!));
	assert.ok(!actionBlock.includes("- [ ]"), "action list must not use checkbox markdown");
	const numberedLines = actionBlock.split("\n").filter((l) => /^\d+\. /.test(l));
	assert.equal(numberedLines.length, 5);
	assert.ok(numberedLines[0]!.startsWith("1. "));
});

test("an empty suggestions section renders no Top Actions heading", async () => {
	const agg = aggregateData([], new Map());
	const temporal = computeTemporalData([], new Map());
	const md = generateMarkdown(agg, {}, {}, temporal, scan, userCtx);
	assert.ok(!md.includes("Top Actions"));
});

test("rendered Markdown report contains no emoji/pictograph characters anywhere", async () => {
	const sections = JSON.parse(await readFile(FIXTURE, "utf-8"));
	const agg = aggregateData([], new Map());
	const temporal = computeTemporalData([], new Map());
	const synthesis = { whats_working: "Fast iteration \u{1F680} on small edits." };
	const md = generateMarkdown(agg, { ...sections, fun_ending: { headline: "Nice \u2705 run" } }, synthesis, temporal, scan, userCtx);
	const emojiMatch = md.match(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
	assert.equal(emojiMatch, null, `found emoji character: ${emojiMatch?.[0]}`);
});

test("Top Actions renders as `1. **Title**` with the reason and copyable text as a fenced block", async () => {
	const sections = JSON.parse(await readFile(FIXTURE, "utf-8"));
	const agg = aggregateData([], new Map());
	const temporal = computeTemporalData([], new Map());
	const md = generateMarkdown(agg, sections, {}, temporal, scan, userCtx);
	assert.match(md, /1\. \*\*Never commit without running the changed test file first\.\*\*/);
	assert.match(md, /```\n {3}Never commit without running the changed test file first\.\n {3}```/);
});
