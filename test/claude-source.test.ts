// SPDX-FileCopyrightText: 2026 Hari Srinivasan <harisrini21@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createClaudeSessionSource, type SessionRef } from "../index.ts";

// ~/.claude/projects/<slug>/<uuid>.jsonl. Record shapes copied from the real
// corpus; the traps they encode are all verified there:
//   - cost lives in periodic `cost-state` records, not on messages
//   - one response can appear as several assistant entries sharing a requestId
//   - tool_result blocks name a tool_use_id, not the tool
//   - subagent turns are inline, flagged isSidechain

const SID = "00000000-0000-4000-8000-000000000003";
let root: string;
let source: ReturnType<typeof createClaudeSessionSource>;

const CWD = "/Users/me/projects/family-history";

function line(o: unknown): string {
	return `${JSON.stringify(o)}\n`;
}

function assistantEntry(at: string, requestId: string, usage: Record<string, number>, content: unknown[]) {
	return {
		type: "assistant",
		sessionId: SID,
		cwd: CWD,
		uuid: `${requestId}-${at}`,
		requestId,
		timestamp: at,
		message: { role: "assistant", model: "claude-opus-5", usage, content },
	};
}

before(async () => {
	root = await mkdtemp(join(tmpdir(), "claude-src-"));
	source = createClaudeSessionSource(root);
	const dir = join(root, "-Users-me-projects-family-history");
	await mkdir(dir, { recursive: true });

	const usage = {
		input_tokens: 10,
		output_tokens: 20,
		cache_read_input_tokens: 1000,
		cache_creation_input_tokens: 500,
	};

	await writeFile(
		join(dir, `${SID}.jsonl`),
		[
			line({ type: "last-prompt", sessionId: SID, leafUuid: "x" }),
			line({ type: "user", sessionId: SID, cwd: CWD, timestamp: "2026-09-20T22:08:04.000Z", message: { role: "user", content: "trace my great-grandmother" }, isSidechain: false }),
			// Same response logged twice under one requestId: usage must count once.
			line(assistantEntry("2026-09-20T22:08:06.000Z", "req-1", usage, [
				{ type: "tool_use", id: "tu-1", name: "Read", input: { file_path: "/tmp/notes.ts" } },
			])),
			line(assistantEntry("2026-09-20T22:08:07.000Z", "req-1", usage, [])),
			line({ type: "user", sessionId: SID, timestamp: "2026-09-20T22:08:10.000Z", isSidechain: false, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu-1", is_error: true }] } }),
			line(assistantEntry("2026-09-20T22:08:12.000Z", "req-2", usage, [
				{ type: "tool_use", id: "tu-2", name: "Bash", input: { command: "git commit -m x" } },
				{ type: "tool_use", id: "tu-3", name: "Task", input: {} },
			])),
			// Subagent prompt and an injected notice: neither is the human typing.
			line({ type: "user", sessionId: SID, timestamp: "2026-09-20T22:09:00.000Z", isSidechain: true, message: { role: "user", content: "subagent instructions" } }),
			line({ type: "user", sessionId: SID, timestamp: "2026-09-20T22:09:30.000Z", isMeta: true, message: { role: "user", content: "<system-reminder>" } }),
			line({ type: "user", sessionId: SID, cwd: CWD, timestamp: "2026-09-20T22:10:00.000Z", isSidechain: false, message: { role: "user", content: "now write it up" } }),
			// Two cost-states: the later one is authoritative.
			line({ type: "cost-state", sessionId: SID, totalCostUSD: 1.5, modelUsage: {} }),
			line({
				type: "cost-state",
				sessionId: SID,
				totalCostUSD: 3.0710155,
				totalLinesAdded: 40,
				totalLinesRemoved: 3,
				modelUsage: {
					"claude-opus-5[1m]": { inputTokens: 2272, outputTokens: 15411, costUSD: 3.0697375, cacheReadInputTokens: 3348585 },
					"claude-haiku-4-5-20251001": { inputTokens: 1153, outputTokens: 25, costUSD: 0.001278 },
				},
			}),
		].join(""),
	);

	// A session Claude Code never wrote a cost-state for.
	await writeFile(
		join(dir, "11111111-2222-3333-4444-555555555555.jsonl"),
		[
			line({ type: "user", sessionId: "11111111-2222-3333-4444-555555555555", cwd: CWD, timestamp: "2026-09-21T09:00:00.000Z", isSidechain: false, message: { role: "user", content: "quick question" } }),
			line(assistantEntry("2026-09-21T09:00:05.000Z", "req-9", usage, [])),
		].join(""),
	);
});

after(async () => {
	await rm(root, { recursive: true, force: true });
});

async function metaFor(id: string) {
	const { sessions } = await source.listSessions();
	const ref = sessions.find((s: SessionRef) => s.id === id);
	assert.ok(ref, `fixture session ${id} not listed`);
	return source.buildMeta(ref, await source.readEntries(ref.path), []);
}

test("lists sessions from the flat per-project layout", async () => {
	const { sessions, duplicate_logs } = await source.listSessions();
	assert.equal(sessions.length, 2);
	assert.equal(duplicate_logs, 0);
	assert.ok(sessions.every((s: SessionRef) => s.sidecars.length === 0));
});

test("cost comes from the last cost-state, never from tokens", async () => {
	const meta = await metaFor(SID);

	assert.equal(meta.total_cost, 3.0710155);
	assert.equal(meta.cost_recorded, true);
	// Claude Code reports one aggregate per session, so it cannot be split.
	assert.equal(meta.cost_primary, 3.0710155);
	assert.equal(meta.cost_advisor, 0);
	assert.equal(meta.cost_subagent, 0);
	assert.equal(meta.model_usage["claude-opus-5[1m]"]?.cost, 3.0697375);
	// Line counts are taken from cost-state, which is authoritative.
	assert.equal(meta.lines_added, 40);
	assert.equal(meta.lines_removed, 3);
});

test("a session with no cost-state is unavailable, not free", async () => {
	const meta = await metaFor("11111111-2222-3333-4444-555555555555");

	assert.equal(meta.cost_recorded, false);
	assert.equal(meta.total_cost, 0);
	// The tokens are still real; only the price is missing.
	assert.equal(meta.input_tokens, 10);
	assert.equal(meta.cache_read_tokens, 1000);
});

test("usage is deduplicated by requestId when the source kept no totals", async () => {
	// Without a cost-state there is nothing to supersede the per-message sum,
	// so the dedupe is what keeps a repeated response from counting twice.
	const meta = await metaFor("11111111-2222-3333-4444-555555555555");
	assert.equal(meta.assistant_message_count, 1);
	assert.equal(meta.input_tokens, 10);

	// The main fixture logs one response twice under req-1; cost-state is the
	// harness's own accounting and supersedes both.
	const withState = await metaFor(SID);
	assert.equal(withState.assistant_message_count, 3);
	assert.equal(withState.input_tokens, 2272 + 1153);
	assert.equal(withState.cache_read_tokens, 3348585);
});

test("tool errors are attributed to the tool that failed", async () => {
	const meta = await metaFor(SID);

	assert.equal(meta.tool_errors, 1);
	// tool_result names tu-1, which the assistant turn declared as Read.
	assert.deepEqual(meta.tool_error_categories, { "Read Failed": 1 });
	assert.deepEqual(meta.tool_counts, { Read: 1, Bash: 1, Task: 1 });
	assert.equal(meta.git_commits, 1);
	assert.equal(meta.uses_subagent, true);
	assert.deepEqual(meta.languages, { TypeScript: 1 });
});

test("sidechain and meta turns are not human activity", async () => {
	const meta = await metaFor(SID);

	assert.equal(meta.user_message_count, 2);
	assert.equal(meta.first_prompt, "trace my great-grandmother");
	assert.equal(meta.session_id, SID);
	assert.equal(meta.project_path, CWD);
	assert.equal(meta.start_time, "2026-09-20T22:08:04.000Z");
});

test("the transcript keeps human turns and tool names, drops sidechains", async () => {
	const { sessions } = await source.listSessions();
	const ref = sessions.find((s: SessionRef) => s.id === SID);
	assert.ok(ref);
	const entries = await source.readEntries(ref.path);
	const transcript = source.formatTranscript(entries, await metaFor(SID));

	assert.match(transcript, /\[User\]: trace my great-grandmother/);
	assert.match(transcript, /\[Tool: Read\]/);
	assert.equal(transcript.includes("subagent instructions"), false);
});
