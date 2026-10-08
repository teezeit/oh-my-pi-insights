// SPDX-FileCopyrightText: 2026 Tobias Hoelzer (omp port)
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	aggregateData,
	buildFacts,
	buildSectionPrompts,
	buildSessionMeta,
	buildSharedDataBlock,
	computeTemporalData,
	generateMarkdown,
	type AggregatedData,
	type ScanSummary,
	type UserContext,
} from "../index.ts";

// `intent` on tool_execution_start is only written when intent tracing is on
// in the harness; the report must describe it only when the corpus actually
// carries it, never assume a fixed cutover date (B-generic).

function assistant(at: number) {
	return {
		type: "message",
		timestamp: new Date(at).toISOString(),
		message: {
			role: "assistant",
			model: "provider/model-a",
			usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			ttft: 100,
			duration: 100,
			content: [],
			timestamp: at,
		},
	};
}

function human(text: string, at: number) {
	return {
		type: "message",
		timestamp: new Date(at).toISOString(),
		message: { role: "user", attribution: "user", steering: null, content: [{ type: "text", text }], timestamp: at },
	};
}

function toolExecutionStart(toolCallId: string, toolName: string, startedAt: number, intent?: string) {
	return {
		type: "custom",
		customType: "tool_execution_start",
		timestamp: new Date(startedAt).toISOString(),
		data: { toolCallId, toolName, startedAt, ...(intent ? { intent } : {}) },
	};
}

function toolResult(toolName: string, toolCallId: string, at: number) {
	return {
		type: "message",
		timestamp: new Date(at).toISOString(),
		message: { role: "toolResult", toolName, isError: false, toolCallId, content: [] },
	};
}

const SESSION = {
	type: "session",
	version: 3,
	id: "01a07af7-bbe1-77b4-9c0e-e1295ebb1e38",
	timestamp: "2026-09-07T10:00:00.000Z",
	cwd: "/Users/me/projects/webapp",
};

function buildMetaWithIntent(withIntent: boolean) {
	const at = Date.UTC(2026, 8, 7, 10, 0, 0);
	return buildSessionMeta(
		{
			id: SESSION.id,
			path: "/sessions/proj/ts_id.jsonl",
			project_path: "/Users/me/projects/webapp",
			size: 1,
			created: new Date("2026-09-07T10:00:00.000Z"),
			modified: new Date("2026-09-07T10:30:00.000Z"),
			sidecars: [],
			signature: "1:1",
		},
		[
			SESSION,
			human("run stuff", at),
			toolExecutionStart("bash-call-1", "bash", at + 1_000, withIntent ? "explore the repo" : undefined),
			assistant(at + 5_000),
			toolResult("bash", "bash-call-1", at + 5_000),
		],
		[],
	);
}

test("buildSessionMeta counts tool_calls_with_intent only when the record carries a non-empty intent", () => {
	assert.equal(buildMetaWithIntent(true).tool_calls_with_intent, 1);
	assert.equal(buildMetaWithIntent(false).tool_calls_with_intent, 0);
});

test("aggregateData sums tool_calls_with_intent across the corpus", () => {
	const withIntent = { ...buildMetaWithIntent(true), session_id: "a" };
	const withoutIntent = { ...buildMetaWithIntent(false), session_id: "b" };
	const agg = aggregateData([withIntent, withoutIntent], new Map());
	assert.equal(agg.tool_calls_with_intent, 1);
});

function userCtx(): UserContext {
	return {
		existing_agents_md_rules: [],
		installed_skills: [],
		installed_managed_skills: [],
		installed_extensions: [],
		installed_hooks: [],
		mcp_servers: [],
		model_roles: {},
		fallback_chains: {},
		default_model: "",
		memory_backend: "off",
		autolearn_enabled: false,
		config_yml_flat: {},
	};
}

function aggWithIntent(toolCallsWithIntent: number): AggregatedData {
	const base = aggregateData([], new Map());
	return {
		...base,
		tool_duration_by_tool: { bash: { calls: 1, total_sec: 4, p50_sec: 4, p90_sec: 4 } },
		tool_time_share: [{ tool: "bash", total_sec: 4, share: 1 }],
		tool_calls_with_intent: toolCallsWithIntent,
	};
}

test("buildSharedDataBlock and friction_analysis prompt never mention intent when the corpus carries none", () => {
	const agg = aggWithIntent(0);
	const temporal = computeTemporalData([], new Map());
	const facts = buildFacts(agg, temporal);
	const data = buildSharedDataBlock(agg, temporal, userCtx(), facts);
	assert.doesNotMatch(data, /intent/i);

	const prompts = buildSectionPrompts(data, temporal, userCtx(), agg);
	assert.doesNotMatch(prompts.friction_analysis, /intent/i);
});

test("buildSharedDataBlock and friction_analysis prompt mention intent when the corpus carries it", () => {
	const agg = aggWithIntent(3);
	const temporal = computeTemporalData([], new Map());
	const facts = buildFacts(agg, temporal);
	const data = buildSharedDataBlock(agg, temporal, userCtx(), facts);
	assert.match(data, /intent/i);

	const prompts = buildSectionPrompts(data, temporal, userCtx(), agg);
	assert.match(prompts.friction_analysis, /intent/i);
});

const scan: ScanSummary = {
	sessions_dir: "/fixture/sessions",
	source: "omp",
	primary_logs: 0,
	duplicate_logs: 0,
	advisor_logs: 0,
	subagent_logs: 0,
	excluded_meta: 0,
	excluded_current: 0,
	excluded_unparsed: 0,
	excluded_not_substantive: 0,
	excluded_by_since: 0,
	excluded_tooling: 0,
	facet_failures: 0,
	facets_analyzed: 0,
	cost_unavailable: 0,
	included: 0,
	reused_stale_sections: false,
};

test("generateMarkdown's per-tool wall clock line never mentions intent when the corpus carries none", () => {
	const agg = aggWithIntent(0);
	const temporal = computeTemporalData([], new Map());
	const md = generateMarkdown(agg, {}, {}, temporal, scan, userCtx());
	const line = md.split("\n").find((l) => l.includes("Per-tool wall clock"));
	assert.ok(line, "per-tool wall clock line not found");
	assert.doesNotMatch(line!, /intent/i);
});

test("generateMarkdown's per-tool wall clock line mentions intent when the corpus carries it", () => {
	const agg = aggWithIntent(3);
	const temporal = computeTemporalData([], new Map());
	const md = generateMarkdown(agg, {}, {}, temporal, scan, userCtx());
	const line = md.split("\n").find((l) => l.includes("Per-tool wall clock"));
	assert.ok(line, "per-tool wall clock line not found");
	assert.match(line!, /intent/i);
});
