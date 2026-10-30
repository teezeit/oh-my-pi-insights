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
//
// A second parent/fork pair covers sidecars: omp also copies the parent's
// subagent/advisor sidecar logs byte for byte into the fork's sidecar
// directory, so dedupe must apply there too, not just to the primary log.
//
//   <root>/-proj/2026-09-07T14-00-00-000Z_<SIDECAR_PARENT_ID>.jsonl
//   <root>/-proj/2026-09-07T14-00-00-000Z_<SIDECAR_PARENT_ID>/shared-sub.jsonl
//   <root>/-proj/2026-09-07T15-00-00-000Z_<SIDECAR_FORK_ID>.jsonl        <- parentSession: SIDECAR_PARENT_ID
//   <root>/-proj/2026-09-07T15-00-00-000Z_<SIDECAR_FORK_ID>/shared-sub.jsonl    <- byte-identical copy
//   <root>/-proj/2026-09-07T15-00-00-000Z_<SIDECAR_FORK_ID>/fork-only-sub.jsonl <- genuinely new sidecar

const PARENT_ID = "00000000-0000-7000-8000-00000000a001";
const FORK_ID = "00000000-0000-7000-8000-00000000a002";
const ORPHAN_ID = "00000000-0000-7000-8000-00000000a003";
const MISSING_PARENT_ID = "00000000-0000-7000-8000-00000000a999";
const SIDECAR_PARENT_ID = "00000000-0000-7000-8000-00000000a004";
const SIDECAR_FORK_ID = "00000000-0000-7000-8000-00000000a005";
const PATH_PARENT_ID = "00000000-0000-7000-8000-00000000a008";
const PATH_FORK_ID = "00000000-0000-7000-8000-00000000a009";

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

	// Sidecar fixture: a parent session with a subagent sidecar, and a fork
	// of it whose sidecar directory holds a byte-identical copy of that
	// sidecar plus one genuinely new sidecar of its own.
	const sharedSubagentHeader = sessionHeader("00000000-0000-7000-8000-00000000a006");
	const sharedSubagentAssistant = assistantWithBashCommit("shared-sub-asst-1", 3.0, 300, "tc-sub-shared", 1_788_000_300_000);
	const sharedSubagentLines = [sharedSubagentHeader, sharedSubagentAssistant];
	const sharedSubagentContent = sharedSubagentLines.map((l) => JSON.stringify(l)).join("\n") + "\n";

	const forkOnlySubagentHeader = sessionHeader("00000000-0000-7000-8000-00000000a007");
	const forkOnlySubagentAssistant = assistantWithBashCommit("fork-only-sub-asst-1", 4.0, 400, "tc-sub-forkonly", 1_788_000_310_000);
	const forkOnlySubagentLines = [forkOnlySubagentHeader, forkOnlySubagentAssistant];
	const forkOnlySubagentContent = forkOnlySubagentLines.map((l) => JSON.stringify(l)).join("\n") + "\n";

	const scParentAssistant = assistantWithBashCommit("sc-parent-asst-1", 0.5, 50, "tc-sc-parent", 1_788_000_290_000);
	const scParentLines = [sessionHeader(SIDECAR_PARENT_ID), human("sc-parent-human-1", "spin up a subagent", 1_788_000_280_000), scParentAssistant];
	const scParentDirName = `2026-09-07T14-00-00-000Z_${SIDECAR_PARENT_ID}`;
	await writeFile(join(projDir, `${scParentDirName}.jsonl`), scParentLines.map((l) => JSON.stringify(l)).join("\n") + "\n");
	await mkdir(join(projDir, scParentDirName), { recursive: true });
	await writeFile(join(projDir, scParentDirName, "shared-sub.jsonl"), sharedSubagentContent);

	const scForkAssistant = assistantWithBashCommit("sc-fork-asst-1", 0.25, 25, "tc-sc-fork", 1_788_000_320_000);
	const scForkLines = [
		sessionHeader(SIDECAR_FORK_ID, SIDECAR_PARENT_ID),
		human("sc-parent-human-1", "spin up a subagent", 1_788_000_280_000),
		scParentAssistant,
		human("sc-fork-human-1", "spin up another one", 1_788_000_315_000),
		scForkAssistant,
	];
	const scForkDirName = `2026-09-07T15-00-00-000Z_${SIDECAR_FORK_ID}`;
	await writeFile(join(projDir, `${scForkDirName}.jsonl`), scForkLines.map((l) => JSON.stringify(l)).join("\n") + "\n");
	await mkdir(join(projDir, scForkDirName), { recursive: true });
	// Byte-identical copy of the parent's sidecar: same ids, same content.
	await writeFile(join(projDir, scForkDirName, "shared-sub.jsonl"), sharedSubagentContent);
	// Genuinely new sidecar: only this fork has it.
	await writeFile(join(projDir, scForkDirName, "fork-only-sub.jsonl"), forkOnlySubagentContent);

	// Real-world fork shape observed in production omp logs (2026-10): the
	// fork's `parentSession` header field is the parent's absolute log path,
	// not a bare session id. The dedupe walk must treat this the same as the
	// bare-id form, or a fork like this double-counts every record it shares
	// with its parent (e.g. two `worst_turn` facts for the same turn).
	const pathSharedHuman = human("path-shared-human-1", "please commit this too", 1_788_000_400_000);
	const pathSharedAssistant = assistantWithBashCommit("path-shared-asst-1", 6.0, 600, "tc-path-shared", 1_788_000_410_000);
	const pathSharedToolResult = toolResultError("path-shared-toolresult-1", "tc-path-shared", 1_788_000_420_000);

	const pathNewHuman = human("path-fork-human-2", "now commit the rest too", 1_788_000_500_000);
	const pathNewAssistant = assistantWithBashCommit("path-fork-asst-2", 7.0, 700, "tc-path-fork", 1_788_000_510_000);
	const pathNewToolResult = toolResultError("path-fork-toolresult-2", "tc-path-fork", 1_788_000_520_000);

	const pathParentLines = [sessionHeader(PATH_PARENT_ID), pathSharedHuman, pathSharedAssistant, pathSharedToolResult];
	const pathParentPath = join(projDir, `2026-09-07T16-00-00-000Z_${PATH_PARENT_ID}.jsonl`);
	await writeFile(pathParentPath, pathParentLines.map((l) => JSON.stringify(l)).join("\n") + "\n");

	const pathForkLines = [
		sessionHeader(PATH_FORK_ID, pathParentPath),
		pathSharedHuman,
		pathSharedAssistant,
		pathSharedToolResult,
		pathNewHuman,
		pathNewAssistant,
		pathNewToolResult,
	];
	await writeFile(
		join(projDir, `2026-09-07T17-00-00-000Z_${PATH_FORK_ID}.jsonl`),
		pathForkLines.map((l) => JSON.stringify(l)).join("\n") + "\n",
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
	const sidecars = await Promise.all(
		ref.sidecars.map(async (sidecar) => ({
			kind: sidecar.kind,
			usage: source.readSidecar(await source.readEntries(sidecar.path)),
		})),
	);
	return source.buildMeta(ref, entries, sidecars);
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

test("a fork's cost_subagent counts only its own sidecar, not the parent's copied one", async () => {
	const forkMeta = await buildMetaFor(SIDECAR_FORK_ID);

	assert.equal(
		forkMeta.cost_subagent,
		4.0,
		"only the fork-only sidecar's cost, not 3.0 (copied) + 4.0 (new)",
	);
});

test("the parent's own cost_subagent is unaffected by the fork's copied sidecar", async () => {
	const parentMeta = await buildMetaFor(SIDECAR_PARENT_ID);

	assert.equal(parentMeta.cost_subagent, 3.0);
});

test("a fork whose parentSession is an absolute path (not a bare id) still dedupes against its parent", async () => {
	const forkMeta = await buildMetaFor(PATH_FORK_ID);

	assert.equal(forkMeta.assistant_message_count, 1, "only the new assistant message, not the copied one too");
	assert.equal(forkMeta.user_message_count, 1, "only the new human message");
	assert.equal(forkMeta.total_cost, 7.0, "only the new assistant's cost, not 6.0 (shared) + 7.0 (new)");
	assert.equal(forkMeta.input_tokens, 700, "only the new assistant's input tokens");
	assert.equal(forkMeta.tool_counts.bash, 1, "only the new bash tool call");
	assert.equal(forkMeta.git_commits, 1, "only the new git commit, not the shared one counted again");
	assert.equal(forkMeta.tool_errors, 1, "only the new tool error, not the shared one counted again");
});

test("the path-parentSession fork's parent meta is unaffected by the fork existing", async () => {
	const parentMeta = await buildMetaFor(PATH_PARENT_ID);

	assert.equal(parentMeta.assistant_message_count, 1);
	assert.equal(parentMeta.user_message_count, 1);
	assert.equal(parentMeta.total_cost, 6.0);
	assert.equal(parentMeta.input_tokens, 600);
	assert.equal(parentMeta.tool_counts.bash, 1);
	assert.equal(parentMeta.git_commits, 1);
	assert.equal(parentMeta.tool_errors, 1);
});
