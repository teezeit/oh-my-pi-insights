// SPDX-FileCopyrightText: 2026 Hari Srinivasan <harisrini21@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createOmpSessionSource } from "../index.ts";

// A fixture tree, not the user's corpus: the bugs this covers are all in
// layout handling, so the layout has to be real files on disk.
//
//   <root>/-proj-a/2026-09-07T10-00-00-000Z_<A>.jsonl
//   <root>/-proj-a/2026-09-07T10-00-00-000Z_<A>/__advisor.jsonl
//   <root>/-proj-a/2026-09-07T10-00-00-000Z_<A>/Scout.jsonl
//   <root>/-proj-a/2026-09-07T10-00-00-000Z_<A>/Scout/Scout.Nested.jsonl
//   <root>/-proj-a/2026-09-07T10-00-00-000Z_<A>/7.bash.log        <- spill
//   <root>/-proj-a/2026-09-08T11-00-00-000Z_<B>.jsonl             <- no sidecars
//   <root>/-proj-b/2026-09-07T10-00-00-000Z_<A>.jsonl             <- duplicate of A, smaller
//   <root>/loose.jsonl                                            <- not in a project dir

const ID_A = "01a07af7-bbe1-77b4-9c0e-e1295ebb1e38";
const ID_B = "01a082a3-9969-7034-951e-8ba58ae3288f";

let root: string;

function sessionLine(id: string, cwd: string): string {
	return `${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-09-07T10:00:00.000Z", cwd })}\n`;
}

before(async () => {
	root = await mkdtemp(join(tmpdir(), "omp-insights-scan-"));

	const projA = join(root, "-proj-a");
	const dirA = join(projA, `2026-09-07T10-00-00-000Z_${ID_A}`);
	await mkdir(join(dirA, "Scout"), { recursive: true });

	await writeFile(`${dirA}.jsonl`, sessionLine(ID_A, "/proj/a") + "x".repeat(500));
	await writeFile(join(dirA, "__advisor.jsonl"), sessionLine("advisor-id", "/proj/a"));
	await writeFile(join(dirA, "Scout.jsonl"), sessionLine("scout-id", "/proj/a"));
	await writeFile(join(dirA, "Scout", "Scout.Nested.jsonl"), sessionLine("nested-id", "/proj/a"));
	await writeFile(join(dirA, "7.bash.log"), "tool output spill, not a transcript");

	await writeFile(
		join(projA, `2026-09-08T11-00-00-000Z_${ID_B}.jsonl`),
		sessionLine(ID_B, "/proj/a"),
	);

	const projB = join(root, "-proj-b");
	await mkdir(projB, { recursive: true });
	// Same session id, fewer bytes: the copy that must lose the dedupe.
	await writeFile(join(projB, `2026-09-07T10-00-00-000Z_${ID_A}.jsonl`), sessionLine(ID_A, "/proj/a"));

	await writeFile(join(root, "loose.jsonl"), sessionLine("loose-id", "/nowhere"));
});

after(async () => {
	await rm(root, { recursive: true, force: true });
});

test("session ids come from the filename and sidecars never surface as sessions", async () => {
	const { sessions } = await createOmpSessionSource(root).listSessions();

	assert.deepEqual(
		sessions.map((s) => s.id).sort(),
		[ID_A, ID_B].sort(),
		"only top-level logs are sessions; advisor and subagent ids must not appear",
	);
});

test("sidecars are classified and collected recursively, spill is ignored", async () => {
	const { sessions } = await createOmpSessionSource(root).listSessions();
	const a = sessions.find((s) => s.id === ID_A);
	assert.ok(a);

	assert.deepEqual(
		a.sidecars.map((s) => `${s.kind}:${s.name}`).sort(),
		["advisor:__advisor", "subagent:Scout", "subagent:Scout/Scout.Nested"].sort(),
	);
	// *.bash.log / *.read.log / *.eval.log carry no messages and no cost.
	assert.equal(
		a.sidecars.some((s) => s.path.endsWith(".log")),
		false,
	);

	const b = sessions.find((s) => s.id === ID_B);
	assert.deepEqual(b?.sidecars, []);
});

test("a session copied under two project dirs is counted once, largest wins", async () => {
	const scan = await createOmpSessionSource(root).listSessions();

	assert.equal(scan.duplicate_logs, 1);
	assert.equal(scan.sessions.filter((s) => s.id === ID_A).length, 1);
	// The larger copy is the complete one, and it is the one carrying sidecars.
	const a = scan.sessions.find((s) => s.id === ID_A);
	assert.ok(a?.path.includes("-proj-a"));
	assert.equal(a?.sidecars.length, 3);
});

test("the signature covers the primary log and every sidecar", async () => {
	const source = createOmpSessionSource(root);
	const before = (await source.listSessions()).sessions.find((s) => s.id === ID_A);
	assert.ok(before);
	assert.match(before.signature, /^\d+:\d+(\.\d+)?(\|[^|]+=\d+:\d+(\.\d+)?){3}$/);

	// Appending to a sidecar must invalidate the parent's cached stats, because
	// its cost is folded into the parent's total.
	const advisor = before.sidecars.find((s) => s.kind === "advisor");
	assert.ok(advisor);
	await writeFile(advisor.path, sessionLine("advisor-id", "/proj/a") + "more\n");

	const after = (await source.listSessions()).sessions.find((s) => s.id === ID_A);
	assert.notEqual(after?.signature, before.signature);
});

test("a missing sessions directory yields an empty scan, not a throw", async () => {
	const scan = await createOmpSessionSource(join(root, "does-not-exist")).listSessions();
	assert.deepEqual(scan, { sessions: [], duplicate_logs: 0 });
});

test("readEntries skips partial trailing lines from a live session", async () => {
	const source = createOmpSessionSource(root);
	const path = join(root, "partial.jsonl");
	await writeFile(
		path,
		`${sessionLine("partial-id", "/proj/a")}{"type":"message","id":"a"}\n{"type":"messa`,
	);

	const entries = await source.readEntries(path);
	assert.deepEqual(
		entries.map((e) => e.type),
		["session", "message"],
	);
});
