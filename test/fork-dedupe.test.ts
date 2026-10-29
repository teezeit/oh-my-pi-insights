// SPDX-FileCopyrightText: 2026 Tobias Hoelzer (omp port)
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createOmpSessionSource } from "../index.ts";

// omp forks a session by writing a new log whose header carries
// `parentSession` and which embeds a full copy of the parent's history up to
// the fork point: same record ids, same usage/cost, same tool calls. This
// fixture builds that shape on disk - a parent log and a fork log sharing an
// identical-by-id prefix, plus genuinely new records appended after the fork
// point - so the regression is about record ids, not line position.
//
//   <root>/-proj/2026-09-07T10-00-00-000Z_<PARENT_ID>.jsonl
//   <root>/-proj/2026-09-07T12-00-00-000Z_<FORK_ID>.jsonl        <- parentSession: PARENT_ID
//   <root>/-proj/2026-09-07T13-00-00-000Z_<ORPHAN_ID>.jsonl      <- parentSession: id of a log that doesn't exist

const PARENT_ID = "00000000-0000-7000-8000-00000000a001";
const FORK_ID = "00000000-0000-7000-8000-00000000a002";
const ORPHAN_ID = "00000000-0000-7000-8000-00000000a003";
const MISSING_PARENT_ID = "00000000-0000-7000-8000-00000000a999";

let root: string;

function usage(cost: number, input: number) {
	return { input, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: input + 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } };
}

function sessionHeader(id: string, parentSession?: string) {
	return {
		type: "session",
		version: 3,
		id,
		timestamp: "2026-09-07T10:00:00.000Z",
		cwd: "/Users/me/projects/webapp",
		...(parentSession ? { parentSession } : {}),
	};
}

function human(id: string, text: string, at: number) {
	return {
		type: "message",
		id,
		timestamp: new Date(at).toISOString(),
		message: { role: "user", attribution: "user", steering: null, content: [{ type: "text", text }], timestamp: at },
	};
}

// `toolCallId` lets two assistant messages each carry their own content-block
// toolCall id - reusing one id across the shared and new assistant message
// would make the "dedupe by id" assertion trivially true for the wrong
// reason (content-block id collision, not entry id collision).
function assistantWithBashCommit(id: string, cost: number, input: number, toolCallId: string, at: number) {
	return {
		type: "message",
		id,
		timestamp: new Date(at).toISOString(),
		message: {
			role: "assistant",
			model: "claude-opus-5",
			usage: usage(cost, input),
			content: [{ type: "toolCall", id: toolCallId, name: "bash", arguments: { command: "git commit -m wip" } }],
			timestamp: at,
		},
	};
}

function toolResultError(id: string, toolCallId: string, at: number) {
	return {
		type: "message",
		id,
		timestamp: new Date(at).toISOString(),
		message: { role: "toolResult", toolName: "bash", toolCallId, isError: true, content: [{ type: "text", text: "fatal: not a git repository" }] },
	};
}

before(async () => {
	root = await mkdtemp(join(tmpdir(), "omp-insights-forkdedupe-"));
	const projDir = join(root, "-proj");
	await mkdir(projDir, { recursive: true });

	// Shared prefix: identical ids in both the parent's log and the fork's
	// copy of it.
	const sharedHuman = human("shared-human-1", "please commit this", 1_788_000_000_000);
	const sharedAssistant = assistantWithBashCommit("shared-asst-1", 1.0, 100, "tc-shared", 1_788_000_010_000);
	const sharedToolResult = toolResultError("shared-toolresult-1", "tc-shared", 1_788_000_020_000);

	// New records: appended after the fork point, ids never seen in the
	// parent.
	const newHuman = human("fork-human-2", "now commit the rest", 1_788_000_100_000);
	const newAssistant = assistantWithBashCommit("fork-asst-2", 2.0, 200, "tc-fork", 1_788_000_110_000);
	const newToolResult = toolResultError("fork-toolresult-2", "tc-fork", 1_788_000_120_000);

	const parentLines = [sessionHeader(PARENT_ID), sharedHuman, sharedAssistant, sharedToolResult];
	await writeFile(
		join(projDir, `2026-09-07T10-00-00-000Z_${PARENT_ID}.jsonl`),
		parentLines.map((l) => JSON.stringify(l)).join("\n") + "\n",
	);

	const forkLines = [
		sessionHeader(FORK_ID, PARENT_ID),
		sharedHuman,
		sharedAssistant,
		sharedToolResult,
		newHuman,
		newAssistant,
		newToolResult,
	];
	await writeFile(
		join(projDir, `2026-09-07T12-00-00-000Z_${FORK_ID}.jsonl`),
		forkLines.map((l) => JSON.stringify(l)).join("\n") + "\n",
	);

	// A fork whose parent log is not on disk (deleted, moved, or simply
	// outside this scan): must count everything, never crash.
	const orphanAssistant = assistantWithBashCommit("orphan-asst-1", 5.0, 500, "tc-orphan", 1_788_000_200_000);
	const orphanLines = [sessionHeader(ORPHAN_ID, MISSING_PARENT_ID), human("orphan-human-1", "hello", 1_788_000_190_000), orphanAssistant];
	await writeFile(
		join(projDir, `2026-09-07T13-00-00-000Z_${ORPHAN_ID}.jsonl`),
		orphanLines.map((l) => JSON.stringify(l)).join("\n") + "\n",
	);
});

after(async () => {
	await rm(root, { recursive: true, force: true });
});

async function buildMetaFor(sessionId: string) {
	const source = createOmpSessionSource(root);
	const { sessions } = await source.listSessions();
	const ref = sessions.find((s) => s.id === sessionId);
	assert.ok(ref, `fixture must contain a log for ${sessionId}`);
	const entries = await source.readEntries(ref.path);
	return source.buildMeta(ref, entries, []);
}

test("a fork's meta counts only the records not already counted in its parent", async () => {
	const forkMeta = await buildMetaFor(FORK_ID);

	assert.equal(forkMeta.assistant_message_count, 1, "only the new assistant message, not the copied one too");
	assert.equal(forkMeta.user_message_count, 1, "only the new human message");
	assert.equal(forkMeta.total_cost, 2.0, "only the new assistant's cost, not 1.0 (shared) + 2.0 (new)");
	assert.equal(forkMeta.input_tokens, 200, "only the new assistant's input tokens");
	assert.equal(forkMeta.tool_counts.bash, 1, "only the new bash tool call");
	assert.equal(forkMeta.git_commits, 1, "only the new git commit, not the shared one counted again");
	assert.equal(forkMeta.tool_errors, 1, "only the new tool error, not the shared one counted again");
});

test("the parent's own meta is unaffected by a fork existing", async () => {
	const parentMeta = await buildMetaFor(PARENT_ID);

	assert.equal(parentMeta.assistant_message_count, 1);
	assert.equal(parentMeta.user_message_count, 1);
	assert.equal(parentMeta.total_cost, 1.0);
	assert.equal(parentMeta.input_tokens, 100);
	assert.equal(parentMeta.tool_counts.bash, 1);
	assert.equal(parentMeta.git_commits, 1);
	assert.equal(parentMeta.tool_errors, 1);
});

test("a fork whose parent log is missing counts everything and does not throw", async () => {
	const orphanMeta = await buildMetaFor(ORPHAN_ID);

	assert.equal(orphanMeta.assistant_message_count, 1);
	assert.equal(orphanMeta.user_message_count, 1);
	assert.equal(orphanMeta.total_cost, 5.0);
	assert.equal(orphanMeta.input_tokens, 500);
	assert.equal(orphanMeta.git_commits, 1);
	assert.equal(orphanMeta.tool_errors, 0);
});
