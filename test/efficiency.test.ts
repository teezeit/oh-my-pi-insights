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

// Test helpers copied from turns.test.ts with extensions.

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

function toolResult(
	toolName: string,
	isError: boolean,
	errorText?: string,
	toolCallId?: string,
	timestamp?: number,
) {
	const content: Record<string, unknown>[] = [];
	if (errorText) {
		content.push({ type: "text", text: errorText });
	}

	return {
		type: "message",
		timestamp: new Date(timestamp ?? 1_693_910_400_000).toISOString(),
		message: {
			role: "toolResult",
			toolName,
			isError,
			toolCallId: toolCallId ?? `${toolName}-${Math.random()}`,
			content,
		},
	};
}

function toolExecutionStart(
	toolCallId: string,
	toolName: string,
	startedAt: number,
	intent?: string,
) {
	return {
		type: "custom",
		customType: "tool_execution_start",
		timestamp: new Date(startedAt).toISOString(),
		data: {
			toolCallId,
			toolName,
			startedAt,
			...(intent ? { intent } : {}),
		},
	};
}

const SESSION = {
	type: "session",
	version: 3,
	id: "01a07af7-bbe1-77b4-9c0e-e1295ebb1e38",
	timestamp: "2026-09-07T10:00:00.000Z",
	cwd: "/Users/me/projects/webapp",
};

// ─────────────────────────────────────────────────────────────────────────────

test("two tool starts paired by toolCallId: bash 4s, read 1s -> duration_by_tool and time_share", () => {
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
			human("run stuff", at),
			toolExecutionStart("bash-call-1", "bash", at + 1_000),
			toolExecutionStart("read-call-1", "read", at + 2_000),
			assistant(0, [], at + 5_000),
			toolResult("bash", false, undefined, "bash-call-1", at + 5_000), // 4 seconds: (5000 - 1000) / 1000
			toolResult("read", false, undefined, "read-call-1", at + 3_000), // 1 second: (3000 - 2000) / 1000
		],
		[],
	);

	assert(meta.tool_duration_by_tool !== undefined);
	assert(meta.tool_duration_by_tool.bash !== undefined);
	assert.equal(meta.tool_duration_by_tool.bash.calls, 1);
	assert.equal(meta.tool_duration_by_tool.bash.total_sec, 4);
	assert.equal(meta.tool_duration_by_tool.bash.p50_sec, 4);

	assert(meta.tool_duration_by_tool.read !== undefined);
	assert.equal(meta.tool_duration_by_tool.read.calls, 1);
	assert.equal(meta.tool_duration_by_tool.read.total_sec, 1);

	// tool_time_share: bash 4s / (4+1) = 0.8; read 1s / 5s = 0.2
	// Should be sorted desc, so bash first
	assert(meta.tool_time_share !== undefined);
	assert(meta.tool_time_share.length > 0);
	assert.equal(meta.tool_time_share[0].tool, "bash");
	assert.ok(Math.abs(meta.tool_time_share[0].share - 0.8) < 1e-9);
});

test("tool_execution_start with no matching toolResult is ignored", () => {
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
			toolExecutionStart("unpaired-1", "bash", at + 1_000),
			toolExecutionStart("paired-1", "read", at + 2_000),
			assistant(0, [], at + 5_000),
			toolResult("read", false, undefined, "paired-1", at + 3_000),
			// no result for unpaired-1
		],
		[],
	);

	assert(meta.tool_duration_by_tool !== undefined);
	// bash should not be in the map since it was unpaired
	assert(meta.tool_duration_by_tool.bash === undefined);
	// read should be present with 1 call
	assert(meta.tool_duration_by_tool.read !== undefined);
	assert.equal(meta.tool_duration_by_tool.read.calls, 1);
});

test("cache_hit_ratio for one assistant message ≈ 100/110", () => {
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
			assistant(0, [], at + 5_000), // usage: input 10, cacheRead 100
		],
		[],
	);

	assert(meta.cache_hit_ratio !== undefined);
	assert.ok(Math.abs(meta.cache_hit_ratio - 100 / 110) < 1e-9);
});

test("cache_hit_ratio is 0 when usage has zero input and cacheRead", () => {
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
			// No assistant messages, so no usage
		],
		[],
	);

	assert(meta.cache_hit_ratio !== undefined);
	assert.equal(meta.cache_hit_ratio, 0);
});

test("edits_by_file counts edit/write toolCall blocks with paths", () => {
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
			human("edit files", at),
			assistant(
				0,
				[
					{ type: "toolCall", id: "e1", name: "edit", arguments: { input: "[src/file1.ts#1A2B]\nPUT 1.=1:\n+line" } },
					{ type: "toolCall", id: "w1", name: "write", arguments: { path: "src/file1.ts", content: "code" } },
				],
				at + 5_000,
			),
			human("more edits", at + 10_000),
			assistant(
				0,
				[
					{ type: "toolCall", id: "e2", name: "edit", arguments: { input: "[src/file2.ts#3C4D]\nPUT 1.=1:\n+line" } },
					{ type: "toolCall", id: "e3", name: "edit", arguments: { input: "[src/file2.ts#3C4D]\nPUT 2.=2:\n+line" } },
					{ type: "toolCall", id: "w2", name: "write", arguments: { path: "src/file2.ts", content: "code" } },
				],
				at + 15_000,
			),
		],
		[],
	);

	assert(meta.edits_by_file !== undefined);
	// file1.ts: 1 edit, 1 write = 2
	// file2.ts: 2 edits, 1 write = 3
	assert.equal(meta.edits_by_file["src/file1.ts"], 2);
	assert.equal(meta.edits_by_file["src/file2.ts"], 3);
});

test("most_churned_files aggregates edits across sessions, top 10 by edits desc", () => {
	const at = Date.UTC(2026, 8, 7, 10, 0, 0);

	const meta1 = buildSessionMeta(
		{
			id: "session-1",
			path: "/sessions/proj/s1.jsonl",
			project_path: "/Users/me/projects/webapp",
			size: 1,
			created: new Date("2026-09-07T10:00:00.000Z"),
			modified: new Date("2026-09-07T10:30:00.000Z"),
			sidecars: [],
			signature: "1:1",
		},
		[
			{ ...SESSION, id: "session-1" },
			human("edit", at),
			assistant(
				0,
				[
					{ type: "toolCall", id: "e1", name: "edit", arguments: { input: "[src/hot.ts#1A2B]\nPUT 1.=1:\n+line" } },
					{ type: "toolCall", id: "e2", name: "edit", arguments: { input: "[src/hot.ts#1A2B]\nPUT 2.=2:\n+line" } },
					{ type: "toolCall", id: "e3", name: "edit", arguments: { input: "[src/hot.ts#1A2B]\nPUT 3.=3:\n+line" } },
					{ type: "toolCall", id: "w1", name: "write", arguments: { path: "src/hot.ts", content: "code" } },
				],
				at + 5_000,
			),
			human("edit another", at + 10_000),
			assistant(
				0,
				[
					{ type: "toolCall", id: "e4", name: "edit", arguments: { input: "[src/cold.ts#3C4D]\nPUT 1.=1:\n+line" } },
					{ type: "toolCall", id: "w2", name: "write", arguments: { path: "src/cold.ts", content: "code" } },
				],
				at + 15_000,
			),
		],
		[],
	);

	const meta2 = buildSessionMeta(
		{
			id: "session-2",
			path: "/sessions/proj/s2.jsonl",
			project_path: "/Users/me/projects/other",
			size: 1,
			created: new Date("2026-09-07T10:35:00.000Z"),
			modified: new Date("2026-09-07T10:55:00.000Z"),
			sidecars: [],
			signature: "1:1",
		},
		[
			{ ...SESSION, id: "session-2" },
			human("also edit", at + 30_000),
			assistant(
				0,
				[
					{ type: "toolCall", id: "e5", name: "edit", arguments: { input: "[src/hot.ts#1A2B]\nPUT 4.=4:\n+line" } },
					{ type: "toolCall", id: "e6", name: "edit", arguments: { input: "[src/hot.ts#1A2B]\nPUT 5.=5:\n+line" } },
					{ type: "toolCall", id: "w3", name: "write", arguments: { path: "src/hot.ts", content: "code" } },
				],
				at + 35_000,
			),
		],
		[],
	);

	const agg = aggregateData([meta1, meta2], new Map());

	assert(agg.most_churned_files !== undefined);
	assert(agg.most_churned_files.length > 0);
	// src/hot.ts: 3 edits + 1 write from session 1 + 2 edits + 1 write from session 2 = 7 edits, 2 sessions
	const hotFile = agg.most_churned_files.find((f) => f.path === "src/hot.ts");
	assert(hotFile !== undefined);
	assert.equal(hotFile.edits, 7);
	assert.equal(hotFile.sessions, 2);
	// src/cold.ts: 1 edit + 1 write from session 1 only = 2 edits, 1 session
	const coldFile = agg.most_churned_files.find((f) => f.path === "src/cold.ts");
	assert(coldFile !== undefined);
	assert.equal(coldFile.edits, 2);
	assert.equal(coldFile.sessions, 1);
	// hot should come before cold in the sorted list
	const hotIndex = agg.most_churned_files.findIndex((f) => f.path === "src/hot.ts");
	const coldIndex = agg.most_churned_files.findIndex((f) => f.path === "src/cold.ts");
	assert(hotIndex < coldIndex);
});

test("model price comparison is cache-invariant: equal list prices compare equal at any cache mix", () => {
	const at = Date.UTC(2026, 8, 7, 10, 0, 0);
	// Same list price for both models: input $5/Mtok, output $25/Mtok, cacheRead $0.50/Mtok.
	const priced = (model: string, input: number, cacheRead: number, output: number, ts: number) => {
		const cost = { input: input * 5e-6, output: output * 25e-6, cacheRead: cacheRead * 0.5e-6, cacheWrite: 0, total: 0 };
		cost.total = cost.input + cost.output + cost.cacheRead;
		return {
			type: "message",
			timestamp: new Date(ts).toISOString(),
			message: { role: "assistant", model, usage: { input, output, cacheRead, cacheWrite: 0, cost }, content: [], timestamp: ts },
		};
	};
	const sessionWith = (id: string, entry: unknown) =>
		buildSessionMeta(
			{
				id,
				path: `/sessions/proj/${id}.jsonl`,
				project_path: "/Users/me/projects/webapp",
				size: 1,
				created: new Date(at),
				modified: new Date(at + 60_000),
				sidecars: [],
				signature: "1:1",
			},
			[{ ...SESSION, id }, human("ask", at), entry as Record<string, unknown>],
			[],
		);

	const agg = aggregateData(
		[
			sessionWith("uncached", priced("model-a", 100_000, 0, 10_000, at + 1_000)),
			// 90% of input served from cache: blended $/token reads ~2.5x pricier.
			sessionWith("cached", priced("model-b", 10_000, 90_000, 10_000, at + 1_000)),
		],
		new Map(),
	);

	const a = agg.model_usage["model-a"]!;
	const b = agg.model_usage["model-b"]!;
	assert.deepEqual(a.list_price, { input_per_mtok: 5, output_per_mtok: 25 });
	assert.deepEqual(b.list_price, a.list_price);
	assert.equal(a.tier, b.tier);
});
