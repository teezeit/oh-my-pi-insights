// SPDX-FileCopyrightText: 2026 Hari Srinivasan <harisrini21@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import {
	aggregateData,
	buildSessionMeta,
	computeTemporalData,
	detectConcurrentSessions,
	generateMarkdown,
	type ScanSummary,
	type SessionMeta,
	type UserContext,
} from "../index.ts";

const GOLDEN = join(import.meta.dirname, "golden", "report.md");

function meta(overrides: Partial<SessionMeta>): SessionMeta {
	const base = buildSessionMeta(
		{
			id: "00000000-0000-7000-0000-000000000000",
			path: "/sessions/proj/log.jsonl",
			project_path: "/Users/me/projects/peach",
			size: 1,
			created: new Date("2026-09-01T09:00:00.000Z"),
			modified: new Date("2026-09-01T09:30:00.000Z"),
			sidecars: [],
			signature: "1:1",
		},
		[],
		[],
	);
	return { ...base, project_path: "/Users/me/projects/peach", ...overrides };
}

test("concurrent-session detection needs interleaving inside the window", () => {
	const t = (min: number) => new Date(Date.UTC(2026, 8, 1, 9, min)).toISOString();

	// A and B interleave: A, B, A within 30 minutes.
	assert.deepEqual(
		detectConcurrentSessions([
			{ session_id: "A", user_message_timestamps: [t(0), t(10)] },
			{ session_id: "B", user_message_timestamps: [t(5)] },
		]),
		{ overlap_events: 1, sessions_involved: 2, user_messages_during: 3 },
	);

	// Same interleaving, but the second A message falls outside the window.
	assert.equal(
		detectConcurrentSessions([
			{ session_id: "A", user_message_timestamps: [t(0), t(100)] },
			{ session_id: "B", user_message_timestamps: [t(5)] },
		]).overlap_events,
		0,
	);

	// Sequential work is not parallel work.
	assert.equal(
		detectConcurrentSessions([
			{ session_id: "A", user_message_timestamps: [t(0), t(5)] },
			{ session_id: "B", user_message_timestamps: [t(40), t(45)] },
		]).overlap_events,
		0,
	);
});

test("aggregate totals equal the sum of the per-session buckets", () => {
	const metas = [
		meta({ session_id: "s1", total_cost: 6, cost_primary: 3, cost_advisor: 1, cost_subagent: 2 }),
		meta({ session_id: "s2", total_cost: 4, cost_primary: 4, cost_advisor: 0, cost_subagent: 0 }),
	];

	const agg = aggregateData(metas, new Map());

	assert.equal(agg.total_sessions, 2);
	assert.equal(agg.total_cost, 10);
	assert.equal(
		agg.total_cost,
		agg.total_cost_primary + agg.total_cost_advisor + agg.total_cost_subagent,
	);
	assert.equal(agg.total_cost_advisor, 1);
	assert.equal(agg.total_cost_subagent, 2);
	// With no facets the LLM-derived charts stay empty rather than guessing.
	assert.equal(agg.sessions_with_facets, 0);
	assert.deepEqual(agg.outcomes, {});
});

test("weekly diff reports a model shift and gates small cost moves", () => {
	const day = (d: number) => new Date(Date.UTC(2026, 8, d, 9)).toISOString();
	const withModel = (id: string, start: string, model: string, cost: number) =>
		meta({
			session_id: id,
			start_time: start,
			total_cost: cost,
			cost_primary: cost,
			model_usage: { [model]: { input_tokens: 1, output_tokens: 1, cost, message_count: 1 } },
		});

	const temporal = computeTemporalData(
		[
			withModel("old1", day(1), "openai/gpt-5.5", 10),
			withModel("old2", day(2), "openai/gpt-5.5", 10),
			withModel("new1", day(10), "anthropic/claude-opus-5", 10),
		],
		new Map(),
	);

	assert.ok(
		temporal.diff_headlines.some((h) => h.includes("gpt-5.5") && h.includes("claude-opus-5")),
		`expected a model-shift headline, got ${JSON.stringify(temporal.diff_headlines)}`,
	);
	// Cost is flat, so the >15% noise gate must suppress a cost headline.
	assert.equal(
		temporal.diff_headlines.some((h) => h.startsWith("Cost")),
		false,
	);
});

test("the markdown report matches the golden file", async () => {
	const metas = [
		meta({
			session_id: "s1",
			start_time: "2026-09-01T09:00:00.000Z",
			total_cost: 6,
			cost_primary: 3,
			cost_advisor: 1,
			cost_subagent: 2,
			utility_cost: 0.5,
			input_tokens: 1_500_000,
			output_tokens: 250_000,
			cache_read_tokens: 40_000_000,
			cache_write_tokens: 2_000_000,
			user_message_count: 12,
			duration_minutes: 30,
			tool_counts: { bash: 40, read: 25, edit: 10, "xd://mcp__posthog_exec": 3 },
			tool_errors: 4,
			tool_error_categories: { "Shell Failed": 3, "Edit Failed": 1 },
			languages: { TypeScript: 12, Markdown: 4 },
			git_commits: 3,
			git_pushes: 2,
			lines_added: 400,
			lines_removed: 120,
			files_modified: 9,
			steering_messages: 2,
			user_interruptions: 2,
			thinking_escalations: 3,
			model_switches: 1,
			compactions: 1,
			median_ttft_ms: 2400,
			median_response_ms: 3000,
			user_response_times: [30, 60, 90],
			message_hours: [9, 10],
			sidecar_counts: { advisor: 1, subagent: 2 },
			model_usage: {
				"claude-opus-5": { input_tokens: 1_400_000, output_tokens: 240_000, cost: 5.5, message_count: 40 },
				"openai/gpt-5.5": { input_tokens: 100_000, output_tokens: 10_000, cost: 0.5, message_count: 6 },
			},
		}),
		meta({
			session_id: "s2",
			start_time: "2026-09-02T14:00:00.000Z",
			project_path: "/Users/me/projects/jar",
			total_cost: 4,
			cost_primary: 4,
			input_tokens: 500_000,
			output_tokens: 80_000,
			user_message_count: 5,
			duration_minutes: 15,
			tool_counts: { bash: 10, grep: 6 },
			tool_errors: 1,
			tool_error_categories: { "Read Failed": 1 },
			languages: { Go: 5 },
			median_ttft_ms: 1800,
			message_hours: [14],
			model_usage: {
				"claude-opus-5": { input_tokens: 500_000, output_tokens: 80_000, cost: 4, message_count: 20 },
			},
		}),
	];

	const scan: ScanSummary = {
		sessions_dir: "/fixture/sessions",
		primary_logs: 4,
		facet_failures: 1,
		facets_analyzed: 1,
		duplicate_logs: 1,
		advisor_logs: 1,
		subagent_logs: 2,
		excluded_meta: 1,
		excluded_current: 1,
		excluded_unparsed: 0,
		excluded_not_substantive: 1,
		excluded_by_since: 0,
		included: 2,
		reused_stale_sections: false,
	};

	const userCtx: UserContext = {
		existing_agents_md_rules: ["never commit without running the tests"],
		installed_skills: ["orca-cli"],
		installed_managed_skills: ["landing-peach-backend-change", "make-it-work"],
		installed_extensions: ["orca-agent-status"],
		installed_hooks: ["pre/eval.ts"],
		mcp_servers: ["atlassian", "outline"],
		model_roles: { default: "anthropic/claude-opus-5", smol: "anthropic/claude-haiku-4-5" },
		fallback_chains: { default: ["anthropic/claude-opus-5", "github-copilot/gpt-5.6-terra"] },
		default_model: "anthropic/claude-opus-5",
	};

	const agg = aggregateData(metas, new Map());
	const temporal = computeTemporalData(metas, new Map());
	const rendered = generateMarkdown(agg, {}, {}, temporal, scan, userCtx)
		// The header stamps today's date and the manifest path is homedir-relative;
		// everything else must be byte-stable across machines.
		.replace(/Generated .*$/m, "Generated <date>")
		.replace(/`[^`]*session-set\.json`/, "`<data-dir>/session-set.json`");

	if (process.env.UPDATE_GOLDEN) {
		await writeFile(GOLDEN, rendered, "utf-8");
	}

	assert.equal(rendered, await readFile(GOLDEN, "utf-8"));
});
