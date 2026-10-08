// SPDX-FileCopyrightText: 2026 Tobias Hoelzer (omp port)
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	aggregateData,
	computeTemporalData,
	configDiff,
	diffConfigAddition,
	flattenYaml,
	generateHTML,
	generateMarkdown,
	parseSimpleYaml,
	type ScanSummary,
	type UserContext,
} from "../index.ts";

test("configDiff reports only changed keys, unchanged keys omitted (D18)", () => {
	const live = {
		default: "anthropic/claude-opus-5",
		plan: "anthropic/claude-opus-5",
		smol: "anthropic/claude-haiku-4-5",
	};
	const proposed = {
		default: "anthropic/claude-opus-5", // unchanged
		plan: "anthropic/claude-opus-5-5", // changed
	};

	const diff = configDiff(live, proposed);

	assert.deepEqual(diff, [{ key: "plan", from: "anthropic/claude-opus-5", to: "anthropic/claude-opus-5-5" }]);
});

test("a proposed key absent from live reports from: (unset)", () => {
	const diff = configDiff({}, { tiny: "anthropic/claude-haiku-4-5" });
	assert.deepEqual(diff, [{ key: "tiny", from: "(unset)", to: "anthropic/claude-haiku-4-5" }]);
});

test("no proposed keys yields an empty diff", () => {
	assert.deepEqual(configDiff({ default: "x" }, {}), []);
});

test("diffConfigAddition diffs a YAML-shaped addition against the live flattened config (D18)", () => {
	const live = { "modelRoles.plan": "anthropic/claude-opus-5" };
	const diff = diffConfigAddition(live, "modelRoles:\n  plan: anthropic/claude-opus-5-5");
	assert.deepEqual(diff, [{ key: "modelRoles.plan", from: "anthropic/claude-opus-5", to: "anthropic/claude-opus-5-5" }]);
});

test("diffConfigAddition returns null for a plain-English addition (no YAML key: value to parse)", () => {
	assert.equal(diffConfigAddition({}, "Never commit without running the changed test file first."), null);
});

test("diffConfigAddition returns null when the parsed addition matches the live config exactly", () => {
	const live = { "memory.backend": "mnemopi" };
	assert.equal(diffConfigAddition(live, "memory:\n  backend: mnemopi"), null);
});

test("flattenYaml dots nested keys and drops array values", () => {
	const parsed = parseSimpleYaml("modelRoles:\n  default: anthropic/claude-opus-5\nretry:\n  fallbackChains:\n    default:\n      - anthropic/claude-opus-5\n      - github-copilot/gpt-5.6-terra\n");
	assert.deepEqual(flattenYaml(parsed), { "modelRoles.default": "anthropic/claude-opus-5" });
});

const baseUserCtx: UserContext = {
	existing_agents_md_rules: [],
	installed_skills: [],
	installed_managed_skills: [],
	installed_extensions: [],
	installed_hooks: [],
	mcp_servers: [],
	model_roles: {},
	fallback_chains: {},
	default_model: "",
	memory_backend: "learn",
	config_yml_flat: {},
};

const baseScan: ScanSummary = {
	sessions_dir: "/fixture/sessions",
	source: "omp",
	cost_unavailable: 0,
	primary_logs: 0,
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

test("the HTML report renders a config.yml addition as a key diff when it parses as YAML (D18)", () => {
	const sections = {
		suggestions: {
			config_additions: [
				{ addition: "modelRoles:\n  plan: anthropic/claude-opus-5-5", why: "Plan model is stale.", where: "~/.omp/agent/config.yml" },
			],
		},
	};
	const userCtx: UserContext = { ...baseUserCtx, config_yml_flat: { "modelRoles.plan": "anthropic/claude-opus-5" } };
	const agg = aggregateData([], new Map());
	const temporal = computeTemporalData([], new Map());
	const html = generateHTML(agg, sections, {}, temporal, { userCtx });

	assert.match(html, /<div class="config-diff-row"><code>modelRoles\.plan<\/code>: <span class="config-diff-old">anthropic\/claude-opus-5<\/span> . <span class="config-diff-new">anthropic\/claude-opus-5-5<\/span><\/div>/);
	assert.ok(!/<h3>modelRoles:/.test(html), "the raw YAML snippet must not also render as the card heading");
});

test("the HTML report falls back to the raw addition text when it isn't YAML-shaped, or where isn't config.yml (D18)", () => {
	const sections = {
		suggestions: {
			config_additions: [
				{ addition: "Never commit without running the changed test file first.", why: "3 sessions pushed with a failing test.", where: "AGENTS.md" },
				{ addition: "modelRoles:\n  plan: anthropic/claude-opus-5-5", why: "Plan model is stale.", where: "~/.omp/agent/extensions/" },
			],
		},
	};
	const userCtx: UserContext = { ...baseUserCtx, config_yml_flat: { "modelRoles.plan": "anthropic/claude-opus-5" } };
	const agg = aggregateData([], new Map());
	const temporal = computeTemporalData([], new Map());
	const html = generateHTML(agg, sections, {}, temporal, { userCtx });

	assert.match(html, /<h3>Never commit without running the changed test file first\.<\/h3>/);
	assert.match(html, /<h3>modelRoles:\n  plan: anthropic\/claude-opus-5-5<\/h3>/);
	assert.ok(!html.includes('class="config-diff"'));
});

test("the Markdown export renders the same key diff for a config.yml addition (D18)", () => {
	const sections = {
		suggestions: {
			config_additions: [
				{ addition: "modelRoles:\n  plan: anthropic/claude-opus-5-5", why: "Plan model is stale.", where: "~/.omp/agent/config.yml" },
			],
		},
	};
	const userCtx: UserContext = { ...baseUserCtx, config_yml_flat: { "modelRoles.plan": "anthropic/claude-opus-5" } };
	const agg = aggregateData([], new Map());
	const temporal = computeTemporalData([], new Map());
	const md = generateMarkdown(agg, sections, {}, temporal, baseScan, userCtx);

	assert.match(md, /- `~\/\.omp\/agent\/config\.yml`: modelRoles\.plan: anthropic\/claude-opus-5 -> anthropic\/claude-opus-5-5 \(Plan model is stale\.\)/);
});
