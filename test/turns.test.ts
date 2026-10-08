// SPDX-FileCopyrightText: 2026 Hari Srinivasan <harisrini21@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	buildSessionMeta,
	aggregateData,
	type SessionMeta,
	type AggregatedData,
} from "../index.ts";

// Test helpers copied from friction.test.ts.

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
	completedAt?: number,
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
	if (completedAt) msg.completedAt = completedAt;

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

const SESSION = {
	type: "session",
	version: 3,
	id: "00000000-0000-7000-8000-000000000001",
	timestamp: "2026-09-07T10:00:00.000Z",
	cwd: "/Users/me/projects/webapp",
};

// ─────────────────────────────────────────────────────────────────────────────

test("two turns in one session with different tool_calls; worst_turns has highest first", () => {
	const at = Date.UTC(2026, 8, 7, 10, 0, 0);

	const meta = buildSessionMeta(
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
			human("first prompt", at),
			assistant(0, [], at + 5_000),
			toolResult("read", false),
			human("second prompt with more context", at + 15_000),
			assistant(0, [], at + 20_000),
			toolResult("read", false),
			toolResult("grep", false),
			toolResult("edit", false),
			human("third prompt", at + 30_000),
			assistant(0, [], at + 35_000),
		],
		[],
	);

	assert(meta.turn_count !== undefined);
	assert.equal(meta.turn_count, 3);

	assert(meta.worst_turns !== undefined);
	assert(meta.worst_turns.length > 0);
	// Worst turn should be the second one with 3 tool calls
	assert.equal(meta.worst_turns[0].tool_calls, 3);
	assert(meta.worst_turns[0].prompt.includes("second prompt"));
});

test("exploration_before_first_mutation: read, grep, edit, read -> 2 calls, mutated true", () => {
	const at = Date.UTC(2026, 8, 7, 10, 0, 0);

	const meta = buildSessionMeta(
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
			human("explore and edit", at),
			assistant(0, [], at + 5_000),
			toolResult("read", false),
			toolResult("grep", false),
			toolResult("edit", false),
			toolResult("read", false),
		],
		[],
	);

	assert(meta.worst_turns !== undefined);
	assert(meta.worst_turns.length > 0);
	const turn = meta.worst_turns[0];
	assert(turn.exploration_before_first_mutation !== undefined);
	assert.equal(turn.exploration_before_first_mutation, 2);
	assert(turn.mutated !== undefined);
	assert.equal(turn.mutated, true);
});

test("exploration_before_first_mutation: read, grep only -> 2 calls, mutated false", () => {
	const at = Date.UTC(2026, 8, 7, 10, 0, 0);

	const meta = buildSessionMeta(
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
			human("explore only", at),
			assistant(0, [], at + 5_000),
			toolResult("read", false),
			toolResult("grep", false),
		],
		[],
	);

	assert(meta.worst_turns !== undefined);
	const turn = meta.worst_turns[0];
	assert(turn.exploration_before_first_mutation !== undefined);
	assert.equal(turn.exploration_before_first_mutation, 2);
	assert(turn.mutated !== undefined);
	assert.equal(turn.mutated, false);
});

test("wall_sec uses completedAt when present, falls back to envelope timestamp", () => {
	const at = Date.UTC(2026, 8, 7, 10, 0, 0);

	// Turn with completedAt
	const meta1 = buildSessionMeta(
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
			human("ask", at),
			assistant(0, [], at + 5_000, undefined, undefined, at + 8_000), // completedAt 8 seconds later
		],
		[],
	);

	assert(meta1.worst_turns !== undefined);
	const turn1 = meta1.worst_turns[0];
	assert(turn1.wall_sec !== undefined);
	assert.equal(turn1.wall_sec, 8);

	// Turn without completedAt, uses envelope timestamp
	const meta2 = buildSessionMeta(
		{
			id: "other-id",
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
			human("ask", at),
			assistant(0, [], at + 7_000), // no completedAt, use this timestamp
		],
		[],
	);

	assert(meta2.worst_turns !== undefined);
	const turn2 = meta2.worst_turns[0];
	assert(turn2.wall_sec !== undefined);
	assert.equal(turn2.wall_sec, 7);
});

test("prompt truncation to 120 chars", () => {
	const at = Date.UTC(2026, 8, 7, 10, 0, 0);
	const longPrompt = "a".repeat(150);

	const meta = buildSessionMeta(
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
			human(longPrompt, at),
			assistant(0, [], at + 5_000),
		],
		[],
	);

	assert(meta.worst_turns !== undefined);
	const turn = meta.worst_turns[0];
	assert(turn.prompt !== undefined);
	assert.equal(turn.prompt.length, 120);
	assert.equal(turn.prompt, "a".repeat(120));
});

test("aborted flag true when turn's last assistant has stopReason 'aborted'", () => {
	const at = Date.UTC(2026, 8, 7, 10, 0, 0);

	const meta = buildSessionMeta(
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
			human("ask something", at),
			assistant(0, [], at + 5_000, "aborted"),
		],
		[],
	);

	assert(meta.worst_turns !== undefined);
	const turn = meta.worst_turns[0];
	assert(turn.aborted !== undefined);
	assert.equal(turn.aborted, true);
});

test("aggregateData worst_turns_corpus picks top 5 by tool_calls across sessions with session_id", () => {
	const at = Date.UTC(2026, 8, 7, 10, 0, 0);

	const meta1 = buildSessionMeta(
		{
			id: "session-1",
			path: "/sessions/proj/s1.jsonl",
			project_path: "/Users/me/projects/proj1",
			size: 1,
			created: new Date("2026-09-07T10:00:00.000Z"),
			modified: new Date("2026-09-07T10:30:00.000Z"),
			sidecars: [],
			signature: "1:1",
		},
		[
			{ ...SESSION, id: "session-1" },
			human("turn1", at),
			assistant(0, [], at + 5_000),
			toolResult("read", false),
			toolResult("grep", false),
			human("turn2 with many calls", at + 15_000),
			assistant(0, [], at + 20_000),
			toolResult("read", false),
			toolResult("grep", false),
			toolResult("edit", false),
			toolResult("write", false),
		],
		[],
	);

	const meta2 = buildSessionMeta(
		{
			id: "session-2",
			path: "/sessions/proj/s2.jsonl",
			project_path: "/Users/me/projects/proj2",
			size: 1,
			created: new Date("2026-09-07T10:35:00.000Z"),
			modified: new Date("2026-09-07T10:55:00.000Z"),
			sidecars: [],
			signature: "1:1",
		},
		[
			{ ...SESSION, id: "session-2" },
			human("turn with 3 calls", at + 30_000),
			assistant(0, [], at + 35_000),
			toolResult("read", false),
			toolResult("grep", false),
			toolResult("edit", false),
		],
		[],
	);

	const agg = aggregateData([meta1, meta2], new Map());

	assert(agg.worst_turns_corpus !== undefined);
	assert(agg.worst_turns_corpus.length > 0);
	// The turn with 4 tool calls should be first
	const topTurn = agg.worst_turns_corpus[0];
	assert(topTurn.session_id !== undefined);
	assert.equal(topTurn.session_id, "session-1");
	assert(topTurn.project !== undefined);
	assert(topTurn.prompt !== undefined);
	assert(topTurn.tool_calls !== undefined);
	assert.equal(topTurn.tool_calls, 4);
});

test("start_ts is ISO timestamp of human message that starts the turn", () => {
	const at = Date.UTC(2026, 8, 7, 10, 0, 0);

	const meta = buildSessionMeta(
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
			human("ask", at),
			assistant(0, [], at + 5_000),
		],
		[],
	);

	assert(meta.worst_turns !== undefined);
	const turn = meta.worst_turns[0];
	assert(turn.start_ts !== undefined);
	assert.equal(turn.start_ts, new Date(at).toISOString());
});

test("cost is sum of assistant usage.cost.total in the turn", () => {
	const at = Date.UTC(2026, 8, 7, 10, 0, 0);

	const meta = buildSessionMeta(
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
			human("ask", at),
			assistant(0.5, [], at + 5_000),
			toolResult("read", false),
			assistant(0.3, [], at + 10_000),
		],
		[],
	);

	assert(meta.worst_turns !== undefined);
	const turn = meta.worst_turns[0];
	assert(turn.cost !== undefined);
	assert.equal(turn.cost, 0.8);
});

test("llm_round_trips counts assistant messages in the turn", () => {
	const at = Date.UTC(2026, 8, 7, 10, 0, 0);

	const meta = buildSessionMeta(
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
			human("ask", at),
			assistant(0, [], at + 5_000),
			toolResult("read", false),
			assistant(0, [], at + 10_000),
			human("next", at + 15_000),
		],
		[],
	);

	assert(meta.worst_turns !== undefined);
	const turn = meta.worst_turns[0];
	assert(turn.llm_round_trips !== undefined);
	assert.equal(turn.llm_round_trips, 2);
});

test("turn_p50 and turn_p90 compute percentiles across all turns", () => {
	const at = Date.UTC(2026, 8, 7, 10, 0, 0);

	const meta = buildSessionMeta(
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
			human("turn1", at),
			assistant(0, [], at + 5_000),
			toolResult("read", false),
			human("turn2", at + 15_000),
			assistant(0, [], at + 20_000),
			toolResult("read", false),
			toolResult("grep", false),
			human("turn3", at + 30_000),
			assistant(0, [], at + 35_000),
			toolResult("read", false),
			toolResult("grep", false),
			toolResult("edit", false),
		],
		[],
	);

	assert(meta.turn_count !== undefined);
	assert.equal(meta.turn_count, 3);

	assert(meta.turn_p50 !== undefined);
	assert(meta.turn_p90 !== undefined);
	assert(meta.turn_p50.round_trips !== undefined);
	assert(meta.turn_p50.tool_calls !== undefined);
	assert(meta.turn_p90.round_trips !== undefined);
	assert(meta.turn_p90.tool_calls !== undefined);
});
