// SPDX-FileCopyrightText: 2026 Hari Srinivasan <harisrini21@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	buildSessionMeta,
	extractSessionStats,
	extractSidecarUsage,
	isMetaSession,
	readUsage,
	toolErrorCategory,
} from "../index.ts";

// The record shapes below are the ones omp writes; see HANDOVER.md "Session
// data: omp vs Pi". Timestamps on messages are epoch ms, on envelopes ISO.

const usage = (cost: number, extra: Record<string, number> = {}) => ({
	input: 10,
	output: 5,
	cacheRead: 100,
	cacheWrite: 20,
	totalTokens: 135,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
	...extra,
});

function assistant(cost: number, blocks: unknown[] = [], at = 1_788_000_000_000) {
	return {
		type: "message",
		timestamp: new Date(at).toISOString(),
		message: {
			role: "assistant",
			model: "claude-opus-5",
			usage: usage(cost),
			ttft: 1200,
			duration: 3400,
			content: blocks,
			timestamp: at,
		},
	};
}

function human(text: string, at: number, steering: boolean | null = null) {
	return {
		type: "message",
		timestamp: new Date(at).toISOString(),
		message: {
			role: "user",
			attribution: "user",
			steering,
			content: [{ type: "text", text }],
			timestamp: at,
		},
	};
}

function toolResult(toolName: string, isError: boolean) {
	return {
		type: "message",
		timestamp: "2026-09-07T10:00:00.000Z",
		message: { role: "toolResult", toolName, isError, content: [] },
	};
}

const SESSION = {
	type: "session",
	version: 3,
	id: "01a07af7-bbe1-77b4-9c0e-e1295ebb1e38",
	timestamp: "2026-09-07T10:00:00.000Z",
	cwd: "/Users/me/projects/peach",
};

test("readUsage reads the recorded cost and never invents one", () => {
	assert.deepEqual(readUsage(usage(0.25)), {
		input: 10,
		output: 5,
		cacheRead: 100,
		cacheWrite: 20,
		cost: 0.25,
	});
	// Missing, malformed and non-numeric usage must all be zero, not NaN: a NaN
	// would poison every total downstream.
	for (const bad of [undefined, null, {}, { cost: null }, { input: "10", cost: { total: "1" } }]) {
		const parsed = readUsage(bad);
		assert.deepEqual(parsed, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
	}
});

test("cost comes from both assistant messages and model_usage records", () => {
	const stats = extractSessionStats([
		SESSION,
		assistant(1.5),
		{
			type: "model_usage",
			timestamp: "2026-09-07T10:01:00.000Z",
			purpose: "auto-thinking",
			role: "tiny",
			model: "claude-haiku-4-5",
			usage: usage(0.25),
		},
	]);

	assert.equal(stats.totals.cost, 1.75);
	// Out-of-band calls are inside the total and also tracked separately.
	assert.equal(stats.utilityCost, 0.25);
	assert.equal(stats.totals.cacheRead, 200);
	assert.equal(stats.modelUsage["claude-opus-5"]?.cost, 1.5);
	assert.equal(stats.modelUsage["claude-haiku-4-5"]?.cost, 0.25);
	assert.equal(stats.sessionId, SESSION.id);
	assert.equal(stats.projectPath, "/Users/me/projects/peach");
});

test("tool errors count the isError flag, not error-shaped output text", () => {
	const stats = extractSessionStats([
		SESSION,
		// A successful grep whose output happens to contain error wording: the
		// regex bucketing this port deleted would have counted it as a failure.
		toolResult("grep", false),
		toolResult("bash", true),
		toolResult("bash", true),
		toolResult("edit", true),
	]);

	assert.equal(stats.toolErrors, 3);
	assert.deepEqual(stats.toolErrorCategories, { "Shell Failed": 2, "Edit Failed": 1 });
});

test("toolErrorCategory keeps MCP servers distinguishable and never returns empty", () => {
	assert.equal(toolErrorCategory("bash"), "Shell Failed");
	assert.equal(toolErrorCategory("mcp__atlassian_getjiraissue"), "MCP: atlassian");
	assert.equal(toolErrorCategory("some_new_tool"), "Some New Tool Failed");
	assert.equal(toolErrorCategory(""), "Unknown Tool");
});

test("an xd:// write counts as its device, not as a file write", () => {
	const stats = extractSessionStats([
		SESSION,
		assistant(0, [
			{ type: "toolCall", id: "t1", name: "write", arguments: { path: "xd://mcp__posthog_exec", content: "{}" } },
			{ type: "toolCall", id: "t2", name: "write", arguments: { path: "src/real.ts", content: "a\nb\n" } },
		]),
	]);

	assert.equal(stats.toolCounts["xd://mcp__posthog_exec"], 1);
	// The device call must not inflate write volume, file counts or line counts.
	assert.equal(stats.toolCounts.write, 1);
	assert.equal(stats.filesModified, 1);
	assert.equal(stats.linesAdded, 3);
	assert.equal(stats.usesMcp, true);
	assert.deepEqual(stats.languages, { TypeScript: 1 });
});

test("edit-tool line accounting reads the hashline patch", () => {
	const patch = [
		"[src/a.ts#1A2B]",
		"PUT 4.=9:",
		"+one",
		"+two",
		"CUT 20.=20",
		"[docs/b.md#3C4D]",
		"PUT >2:",
		"+bullet",
	].join("\n");

	const stats = extractSessionStats([
		SESSION,
		assistant(0, [{ type: "toolCall", id: "e1", name: "edit", arguments: { input: patch } }]),
	]);

	// Three `+` rows added; 6 lines replaced by PUT 4.=9 plus 1 by CUT 20.=20.
	assert.equal(stats.linesAdded, 3);
	assert.equal(stats.linesRemoved, 7);
	// Paths come from the section headers, since omp's edit tool has no path arg.
	assert.equal(stats.filesModified, 2);
	assert.deepEqual(stats.languages, { TypeScript: 1, Markdown: 1 });
});

test("duplicate tool call ids are counted once", () => {
	const call = { type: "toolCall", id: "same", name: "bash", arguments: { command: "git commit -m x" } };
	const stats = extractSessionStats([SESSION, assistant(0, [call]), assistant(0, [call])]);

	assert.equal(stats.toolCounts.bash, 1);
	assert.equal(stats.gitCommits, 1);
});

test("human activity ignores non-user attribution and records steering", () => {
	const at = Date.UTC(2026, 8, 7, 10, 0, 0);
	const stats = extractSessionStats([
		SESSION,
		human("first ask", at),
		assistant(0, [], at + 10_000),
		human("interrupting", at + 40_000, true),
		{
			type: "message",
			timestamp: new Date(at + 50_000).toISOString(),
			message: {
				role: "user",
				attribution: "tool",
				content: [{ type: "text", text: "injected notice" }],
				timestamp: at + 50_000,
			},
		},
	]);

	assert.equal(stats.userMessageCount, 2);
	assert.equal(stats.steeringMessages, 1);
	assert.equal(stats.firstPrompt, "first ask");
	// 30s gap between the assistant reply and the next human message.
	assert.deepEqual(stats.userResponseTimes, [30]);
	assert.equal(stats.messageHours.length, 2);
});

test("escalation and compaction records are counted", () => {
	const stats = extractSessionStats([
		SESSION,
		{ type: "thinking_level_change", timestamp: "2026-09-07T10:01:00.000Z", thinkingLevel: "high" },
		{ type: "model_change", timestamp: "2026-09-07T10:02:00.000Z", model: "anthropic/claude-opus-5" },
		{ type: "model_change", timestamp: "2026-09-07T10:03:00.000Z", model: "openai/gpt-5.5" },
		{ type: "compaction", timestamp: "2026-09-07T10:04:00.000Z", summary: "..." },
	]);

	assert.equal(stats.thinkingEscalations, 1);
	assert.equal(stats.modelSwitches, 2);
	assert.equal(stats.compactions, 1);
});

test("isMetaSession rejects this pipeline's own sessions and keeps real ones", () => {
	const at = Date.UTC(2026, 8, 7, 10, 0, 0);
	assert.equal(
		isMetaSession([SESSION, human("Analyze this session and extract structured facets", at)]),
		true,
	);
	assert.equal(
		isMetaSession([SESSION, human("RESPOND WITH ONLY A VALID JSON OBJECT", at)]),
		true,
	);
	assert.equal(isMetaSession([SESSION, human("fix the login bug", at)]), false);
});

test("sidecar spend folds into the parent and stays broken out", () => {
	const advisor = extractSidecarUsage([
		SESSION,
		assistant(2, [{ type: "toolCall", id: "a1", name: "read", arguments: { path: "x.ts" } }]),
		toolResult("read", true),
	]);
	const subagent = extractSidecarUsage([SESSION, assistant(3)]);

	const meta = buildSessionMeta(
		{
			id: SESSION.id,
			path: "/sessions/proj/ts_id.jsonl",
			project_path: "",
			size: 1,
			created: new Date("2026-09-07T10:00:00.000Z"),
			modified: new Date("2026-09-07T10:30:00.000Z"),
			sidecars: [],
			signature: "1:2",
		},
		[SESSION, assistant(5), human("do the thing", Date.UTC(2026, 8, 7, 10, 20, 0))],
		[
			{ kind: "advisor", usage: advisor },
			{ kind: "subagent", usage: subagent },
		],
	);

	assert.equal(meta.cost_primary, 5);
	assert.equal(meta.cost_advisor, 2);
	assert.equal(meta.cost_subagent, 3);
	// The parent-attributed total must equal the three buckets: this identity is
	// what the jq cross-check reconciles against the logs.
	assert.equal(meta.total_cost, 10);
	assert.equal(meta.total_cost, meta.cost_primary + meta.cost_advisor + meta.cost_subagent);

	// Sidecar tool volume is reported, never mixed into the human-facing counts.
	assert.deepEqual(meta.sidecar_counts, { advisor: 1, subagent: 1 });
	assert.equal(meta.sidecar_tool_calls, 1);
	assert.equal(meta.sidecar_tool_errors, 1);
	assert.equal(meta.tool_errors, 0);
	assert.deepEqual(meta.tool_counts, {});
	assert.equal(meta.user_message_count, 1);
	assert.equal(meta.uses_subagent, true);

	// Per-model message counts must not gain a phantom message per sidecar.
	assert.equal(meta.model_usage["claude-opus-5"]?.message_count, 3);
	assert.equal(meta.model_usage["claude-opus-5"]?.cost, 10);

	assert.equal(meta.log_signature, "1:2");
	assert.equal(meta.start_time, "2026-09-07T10:00:00.000Z");
	// Duration comes from the log's own last timestamp, not the file mtime.
	assert.equal(meta.duration_minutes, 20);
});
