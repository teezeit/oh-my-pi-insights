// SPDX-FileCopyrightText: 2026 Hari Srinivasan <harisrini21@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	buildSessionMeta,
	extractSessionStats,
	aggregateData,
	type SessionMeta,
} from "../index.ts";

// Test helpers match the pattern in stats.test.ts.

const usage = (cost: number, extra: Record<string, number> = {}) => ({
	input: 10,
	output: 5,
	cacheRead: 100,
	cacheWrite: 20,
	totalTokens: 135,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
	...extra,
});

function assistant(
	cost: number,
	blocks: unknown[] = [],
	at = 1_788_000_000_000,
	stopReason?: string,
	errorMessage?: string,
) {
	const msg: Record<string, unknown> = {
		role: "assistant",
		model: "claude-opus-5",
		usage: usage(cost),
		ttft: 1200,
		duration: 3400,
		content: blocks,
		timestamp: at,
	};
	if (stopReason) msg.stopReason = stopReason;
	if (errorMessage) msg.errorMessage = errorMessage;

	return {
		type: "message",
		timestamp: new Date(at).toISOString(),
		message: msg,
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

function toolResult(toolName: string, isError: boolean, errorText?: string) {
	const content: Record<string, unknown>[] = [];
	if (errorText) {
		content.push({ type: "text", text: errorText });
	}

	return {
		type: "message",
		timestamp: "2026-09-07T10:00:00.000Z",
		message: {
			role: "toolResult",
			toolName,
			isError,
			toolCallId: `${toolName}-${Math.random()}`,
			content,
		},
	};
}

function ttsrInjection(rules: string[]) {
	return {
		type: "ttsr_injection",
		timestamp: "2026-09-07T10:00:00.000Z",
		injectedRules: rules,
	};
}

function resetBoundary() {
	return {
		type: "reset_boundary",
		timestamp: "2026-09-07T10:00:00.000Z",
	};
}

const SESSION = {
	type: "session",
	version: 3,
	id: "00000000-0000-7000-8000-000000000001",
	timestamp: "2026-09-07T10:00:00.000Z",
	cwd: "/Users/me/projects/webapp",
};

// ─────────────────────────────────────────────────────────────────────────────

test("error classification: rate_limit from 429", () => {
	const at = Date.UTC(2026, 8, 7, 10, 0, 0);
	const stats = extractSessionStats([
		SESSION,
		assistant(0, [], at, "error", "429 Too Many Requests"),
		human("retry", at + 10_000),
	]);

	// Stats do not yet have error_classes; test will fail on missing field.
	// The field must exist once the implementation lands.
	assert(stats.error_classes !== undefined, "error_classes must exist");
	assert.equal(stats.error_classes.rate_limit, 1);
	assert.equal(stats.error_classes.quota, 0);
	assert.equal(stats.error_classes.auth, 0);
	assert.equal(stats.error_classes.other, 0);
});

test("error classification: quota from 'quota' text", () => {
	const at = Date.UTC(2026, 8, 7, 10, 0, 0);
	const stats = extractSessionStats([
		SESSION,
		assistant(0, [], at, "error", "Quota exceeded for this model"),
		human("next", at + 10_000),
	]);

	assert(stats.error_classes !== undefined);
	assert.equal(stats.error_classes.quota, 1);
	assert.equal(stats.error_classes.rate_limit, 0);
});

test("error classification: auth from 401 or api key", () => {
	const at = Date.UTC(2026, 8, 7, 10, 0, 0);
	const stats = extractSessionStats([
		SESSION,
		assistant(0, [], at, "error", "401 Unauthorized"),
		assistant(0, [], at + 5_000, "error", "Invalid API key"),
		human("retry", at + 10_000),
	]);

	assert(stats.error_classes !== undefined);
	assert.equal(stats.error_classes.auth, 2);
});

test("error classification: other for unmatched errors", () => {
	const at = Date.UTC(2026, 8, 7, 10, 0, 0);
	const stats = extractSessionStats([
		SESSION,
		assistant(0, [], at, "error", "Connection timeout"),
		assistant(0, [], at + 5_000, "error", "Unknown error"),
		human("next", at + 10_000),
	]);

	assert(stats.error_classes !== undefined);
	assert.equal(stats.error_classes.other, 2);
	assert.equal(stats.error_classes.rate_limit, 0);
});

test("aborted_generations counts stopReason === 'aborted'", () => {
	const at = Date.UTC(2026, 8, 7, 10, 0, 0);
	const stats = extractSessionStats([
		SESSION,
		assistant(0, [], at, "aborted"),
		human("interrupted", at + 10_000),
		assistant(0, [], at + 15_000, "aborted"),
		human("again", at + 25_000),
	]);

	assert(stats.aborted_generations !== undefined);
	assert.equal(stats.aborted_generations, 2);
});

test("aborted_at_session_end is 1 only when last message is an aborted assistant message", () => {
	const at = Date.UTC(2026, 8, 7, 10, 0, 0);
	// Case 1: last message is aborted
	const stats1 = extractSessionStats([
		SESSION,
		assistant(0, [], at),
		human("ask", at + 10_000),
		assistant(0, [], at + 15_000, "aborted"),
	]);

	assert(stats1.aborted_at_session_end !== undefined);
	assert.equal(stats1.aborted_at_session_end, 1);

	// Case 2: last message is not aborted
	const stats2 = extractSessionStats([
		SESSION,
		assistant(0, [], at, "aborted"),
		human("ask", at + 10_000),
		assistant(0, [], at + 15_000),
	]);

	assert(stats2.aborted_at_session_end !== undefined);
	assert.equal(stats2.aborted_at_session_end, 0);

	// Case 3: last message is aborted but it's a human message
	const stats3 = extractSessionStats([
		SESSION,
		assistant(0, [], at, "aborted"),
		human("ask", at + 10_000),
	]);

	assert(stats3.aborted_at_session_end !== undefined);
	assert.equal(stats3.aborted_at_session_end, 0);
});

test("tool_not_found excluded from tool_errors_by_tool but counted in tool_not_found", () => {
	const at = Date.UTC(2026, 8, 7, 10, 0, 0);
	const stats = extractSessionStats([
		SESSION,
		assistant(0, [{ type: "toolCall", id: "t1", name: "read", arguments: {} }], at),
		toolResult("read", true, "Tool bash not found in registry"),
		assistant(0, [{ type: "toolCall", id: "t2", name: "write", arguments: {} }], at + 5_000),
		toolResult("write", true, "Actual error"),
		human("next", at + 10_000),
	]);

	assert(stats.tool_errors_by_tool !== undefined);
	assert(stats.tool_not_found !== undefined);
	// bash has the "not found" message; should NOT be in tool_errors_by_tool
	assert.equal(stats.tool_errors_by_tool.bash, undefined);
	// bash should be in tool_not_found
	assert.equal(stats.tool_not_found.bash, 1);
	// write is a real error, should be in tool_errors_by_tool
	assert.equal(stats.tool_errors_by_tool.write, 1);
});

test("tool_calls_by_tool counts all toolResult entries", () => {
	const at = Date.UTC(2026, 8, 7, 10, 0, 0);
	const stats = extractSessionStats([
		SESSION,
		assistant(0, [{ type: "toolCall", id: "t1", name: "read", arguments: {} }], at),
		toolResult("read", false),
		assistant(
			0,
			[
				{ type: "toolCall", id: "t2", name: "read", arguments: {} },
				{ type: "toolCall", id: "t3", name: "write", arguments: {} },
			],
			at + 5_000,
		),
		toolResult("read", false),
		toolResult("write", false),
		human("next", at + 10_000),
	]);

	assert(stats.tool_calls_by_tool !== undefined);
	assert.equal(stats.tool_calls_by_tool.read, 2);
	assert.equal(stats.tool_calls_by_tool.write, 1);
});

test("ttsr_injections counts top-level entries with type 'ttsr_injection'", () => {
	const at = Date.UTC(2026, 8, 7, 10, 0, 0);
	const stats = extractSessionStats([
		SESSION,
		ttsrInjection(["rule1", "rule2"]),
		human("ask", at + 10_000),
		ttsrInjection(["rule3"]),
		assistant(0, [], at + 15_000),
	]);

	assert(stats.ttsr_injections !== undefined);
	assert.equal(stats.ttsr_injections, 2);
});

test("ttsr_rules merges rule counts across injections within a session", () => {
	const at = Date.UTC(2026, 8, 7, 10, 0, 0);
	const stats = extractSessionStats([
		SESSION,
		ttsrInjection(["rule1", "rule2", "rule1"]),
		human("ask", at + 10_000),
		ttsrInjection(["rule2", "rule3"]),
		assistant(0, [], at + 15_000),
	]);

	assert(stats.ttsr_rules !== undefined);
	assert.equal(stats.ttsr_rules.rule1, 2);
	assert.equal(stats.ttsr_rules.rule2, 2);
	assert.equal(stats.ttsr_rules.rule3, 1);
});

test("reset_boundaries counts entries with type 'reset_boundary'", () => {
	const at = Date.UTC(2026, 8, 7, 10, 0, 0);
	const stats = extractSessionStats([
		SESSION,
		resetBoundary(),
		human("ask", at + 10_000),
		resetBoundary(),
		assistant(0, [], at + 15_000),
		resetBoundary(),
	]);

	assert(stats.reset_boundaries !== undefined);
	assert.equal(stats.reset_boundaries, 3);
});

test("interruption_rate = (sum aborted_generations - sum aborted_at_session_end + sum steering_messages) / sum human user messages", () => {
	const at = Date.UTC(2026, 8, 7, 10, 0, 0);

	// Session 1: 2 aborted, 1 aborted_at_session_end, 1 steering, 3 human messages
	const meta1 = buildSessionMeta(
		{
			id: SESSION.id,
			path: "/sessions/proj/s1.jsonl",
			project_path: "",
			size: 1,
			created: new Date("2026-09-07T10:00:00.000Z"),
			modified: new Date("2026-09-07T10:30:00.000Z"),
			sidecars: [],
			signature: "1:1",
		},
		[
			SESSION,
			assistant(0, [], at, "stop"),
			human("first", at + 5_000),
			assistant(0, [], at + 10_000, "aborted"),
			human("second", at + 15_000, true), // steering
			assistant(0, [], at + 20_000, "aborted"),
			human("third", at + 25_000), // final message is not aborted
		],
		[],
	);

	// Session 2: 1 aborted, 1 aborted_at_session_end (same message), 0 steering, 2 human messages
	const meta2 = buildSessionMeta(
		{
			id: "other-id",
			path: "/sessions/proj/s2.jsonl",
			project_path: "",
			size: 1,
			created: new Date("2026-09-07T10:35:00.000Z"),
			modified: new Date("2026-09-07T10:55:00.000Z"),
			sidecars: [],
			signature: "1:1",
		},
		[
			SESSION,
			human("ask0", at + 28_000),
			human("ask1", at + 30_000),
			assistant(0, [], at + 35_000, "aborted"), // this is also aborted_at_session_end
		],
		[],
	);

	const agg = aggregateData([meta1, meta2], new Map());

	assert(agg.interruption_rate !== undefined);
	// numerator: (2 + 1 + 0 + 1) - (0 + 1) = 3
	// denominator: 3 + 2 = 5
	// interruption_rate = 3 / 5 = 0.6
	assert.equal(agg.interruption_rate, 0.6);
});

test("aggregateData merges tool_errors_by_tool and tool_not_found across sessions", () => {
	const at = Date.UTC(2026, 8, 7, 10, 0, 0);

	const meta1 = buildSessionMeta(
		{
			id: SESSION.id,
			path: "/sessions/proj/s1.jsonl",
			project_path: "",
			size: 1,
			created: new Date("2026-09-07T10:00:00.000Z"),
			modified: new Date("2026-09-07T10:30:00.000Z"),
			sidecars: [],
			signature: "1:1",
		},
		[
			SESSION,
			assistant(0, [{ type: "toolCall", id: "t1", name: "bash", arguments: {} }], at),
			toolResult("bash", true, "Tool bash not found"),
			assistant(0, [{ type: "toolCall", id: "t2", name: "read", arguments: {} }], at + 5_000),
			toolResult("read", true, "Error"),
			human("next", at + 10_000),
		],
		[],
	);

	const meta2 = buildSessionMeta(
		{
			id: "other-id",
			path: "/sessions/proj/s2.jsonl",
			project_path: "",
			size: 1,
			created: new Date("2026-09-07T10:35:00.000Z"),
			modified: new Date("2026-09-07T10:55:00.000Z"),
			sidecars: [],
			signature: "1:1",
		},
		[
			SESSION,
			assistant(0, [{ type: "toolCall", id: "t3", name: "read", arguments: {} }], at + 30_000),
			toolResult("read", true, "Error"),
			human("next", at + 35_000),
		],
		[],
	);

	const agg = aggregateData([meta1, meta2], new Map());

	// Verify that tool_errors_by_tool is not undefined
	assert(agg.tool_errors_by_tool !== undefined);
	// Verify that tool_not_found is not undefined
	assert(agg.tool_not_found !== undefined);
	// bash should only be in tool_not_found, not tool_errors_by_tool
	assert.equal(agg.tool_errors_by_tool.bash, undefined);
	assert.equal(agg.tool_not_found.bash, 1);
	// read errors should accumulate across sessions
	assert.equal(agg.tool_errors_by_tool.read, 2);
});

test("aggregateData merges ttsr_rules across sessions", () => {
	const at = Date.UTC(2026, 8, 7, 10, 0, 0);

	const meta1 = buildSessionMeta(
		{
			id: SESSION.id,
			path: "/sessions/proj/s1.jsonl",
			project_path: "",
			size: 1,
			created: new Date("2026-09-07T10:00:00.000Z"),
			modified: new Date("2026-09-07T10:30:00.000Z"),
			sidecars: [],
			signature: "1:1",
		},
		[
			SESSION,
			ttsrInjection(["rule1", "rule2"]),
			human("ask", at + 10_000),
		],
		[],
	);

	const meta2 = buildSessionMeta(
		{
			id: "other-id",
			path: "/sessions/proj/s2.jsonl",
			project_path: "",
			size: 1,
			created: new Date("2026-09-07T10:35:00.000Z"),
			modified: new Date("2026-09-07T10:55:00.000Z"),
			sidecars: [],
			signature: "1:1",
		},
		[
			SESSION,
			ttsrInjection(["rule1", "rule3"]),
			human("ask", at + 30_000),
		],
		[],
	);

	const agg = aggregateData([meta1, meta2], new Map());

	assert(agg.ttsr_rules !== undefined);
	assert.equal(agg.ttsr_rules.rule1, 2);
	assert.equal(agg.ttsr_rules.rule2, 1);
	assert.equal(agg.ttsr_rules.rule3, 1);
});
