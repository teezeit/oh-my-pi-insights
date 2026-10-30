// SPDX-FileCopyrightText: 2026 Tobias Hoelzer (omp port)
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
	buildRetroPath,
	retroExtension,
	slugifyProject,
	type RetroExtensionAPI,
	type SessionStopContext,
	type SessionStopEvent,
	type SessionStopResult,
} from "../index.ts";

const SID = "00000000-0000-7000-8000-00000000retr";

let root: string;
let dataDir: string;

before(async () => {
	root = await mkdtemp(join(tmpdir(), "omp-insights-retro-"));
	dataDir = join(root, "omp-insights");
	await mkdir(dataDir, { recursive: true });
});

after(async () => {
	await rm(root, { recursive: true, force: true });
});

function ts(date: Date): string {
	return date.toISOString();
}

function humanEntry(at: Date, text = "do the thing"): Record<string, unknown> {
	return {
		type: "message",
		timestamp: ts(at),
		message: { role: "user", attribution: "user", content: text },
	};
}

function sessionHeaderEntry(at: Date, cwd: string, id = SID): Record<string, unknown> {
	return { type: "session", id, timestamp: ts(at), cwd };
}

function assistantEntry(at: Date, toolCallCount: number): Record<string, unknown> {
	const content: Array<Record<string, unknown>> = [];
	for (let i = 0; i < toolCallCount; i++) {
		content.push({ type: "toolCall", id: `tc-${at.getTime()}-${i}`, name: "bash", arguments: { command: "echo hi" } });
	}
	return {
		type: "message",
		timestamp: ts(at),
		message: { role: "assistant", content },
	};
}

function toolErrorEntry(at: Date, toolCallId: string): Record<string, unknown> {
	return {
		type: "message",
		timestamp: ts(at),
		message: { role: "toolResult", toolCallId, toolName: "bash", isError: true, content: [] },
	};
}

async function writeSession(name: string, entries: Array<Record<string, unknown>>): Promise<string> {
	const path = join(root, `${name}.jsonl`);
	await writeFile(path, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");
	return path;
}

type FakeHost = {
	pi: RetroExtensionAPI;
	run: (event: SessionStopEvent, ctx?: Partial<SessionStopContext>) => Promise<SessionStopResult | undefined>;
};

function fakeHost(): FakeHost {
	let handler:
		| ((event: SessionStopEvent, ctx: SessionStopContext) => Promise<SessionStopResult | undefined> | SessionStopResult | undefined)
		| null = null;
	const pi: RetroExtensionAPI = {
		on(event, h) {
			assert.equal(event, "session_stop");
			handler = h;
		},
	};
	return {
		pi,
		run: async (event, ctx) => {
			assert.ok(handler, "handler not registered");
			return await handler!(event, { hasUI: true, ...ctx });
		},
	};
}

test("40 minute request with 5 tool calls triggers a retro with the full payload", async () => {
	const humanAt = new Date("2026-10-30T09:00:00.000Z");
	const nowMs = humanAt.getTime() + 40 * 60_000;
	const entries = [humanEntry(humanAt), assistantEntry(new Date(humanAt.getTime() + 60_000), 5)];
	const file = await writeSession("req-40min", entries);

	const host = fakeHost();
	retroExtension(host.pi, { dataDir, now: () => nowMs, env: {} });

	const result = await host.run({ session_id: SID, session_file: file });
	assert.ok(result, "expected a retro result");
	assert.equal(result!.continue, true);
	assert.match(result!.additionalContext, /retros[\\/]/);
	assert.match(result!.additionalContext, /Tool calls: 5/);
	assert.match(result!.additionalContext, /Time sink: <one line>/);
	assert.match(result!.additionalContext, /Proposal: <one line>/);
	assert.match(result!.additionalContext, /Retro: .*retros[\\/]/);
	assert.match(result!.additionalContext, /proposals-only pass/i);
	assert.match(result!.additionalContext, /do not edit any rule, hook, skill, config or code/i);

	const retrosDir = join(dataDir, "retros");
	const files = await readdir(retrosDir);
	assert.deepEqual(files, [], "hook only creates the retros dir; the agent writes the file itself");
});

test("2 minute request with 120 tool calls triggers via the tool-call threshold", async () => {
	const humanAt = new Date("2026-10-30T10:00:00.000Z");
	const nowMs = humanAt.getTime() + 2 * 60_000;
	const entries = [humanEntry(humanAt), assistantEntry(new Date(humanAt.getTime() + 30_000), 120)];
	const file = await writeSession("req-120calls", entries);

	const host = fakeHost();
	retroExtension(host.pi, { dataDir, now: () => nowMs, env: {} });

	const result = await host.run({ session_id: SID, session_file: file });
	assert.ok(result);
	assert.match(result!.additionalContext, /Tool calls: 120/);
});

test("2 minutes and 5 tool calls stays under both thresholds: no retro", async () => {
	const humanAt = new Date("2026-10-30T11:00:00.000Z");
	const nowMs = humanAt.getTime() + 2 * 60_000;
	const entries = [humanEntry(humanAt), assistantEntry(new Date(humanAt.getTime() + 30_000), 5)];
	const file = await writeSession("req-short", entries);

	const host = fakeHost();
	retroExtension(host.pi, { dataDir, now: () => nowMs, env: {} });

	const result = await host.run({ session_id: SID, session_file: file });
	assert.equal(result, undefined);
});

test("skip conditions: stop_hook_active, no UI, aborted stop reason, missing session file", async () => {
	const humanAt = new Date("2026-10-30T12:00:00.000Z");
	const nowMs = humanAt.getTime() + 40 * 60_000;
	const entries = [humanEntry(humanAt), assistantEntry(new Date(humanAt.getTime() + 60_000), 5)];
	const file = await writeSession("req-skip", entries);

	const host1 = fakeHost();
	retroExtension(host1.pi, { dataDir, now: () => nowMs, env: {} });
	assert.equal(
		await host1.run({ session_id: SID, session_file: file, stop_hook_active: true }),
		undefined,
	);

	const host2 = fakeHost();
	retroExtension(host2.pi, { dataDir, now: () => nowMs, env: {} });
	assert.equal(
		await host2.run({ session_id: SID, session_file: file }, { hasUI: false }),
		undefined,
	);

	const host3 = fakeHost();
	retroExtension(host3.pi, { dataDir, now: () => nowMs, env: {} });
	assert.equal(
		await host3.run({
			session_id: SID,
			session_file: file,
			last_assistant_message: { stopReason: "aborted" },
		}),
		undefined,
	);

	const host4 = fakeHost();
	retroExtension(host4.pi, { dataDir, now: () => nowMs, env: {} });
	assert.equal(
		await host4.run({ session_id: SID, session_file: join(root, "does-not-exist.jsonl") }),
		undefined,
	);
});

test("env thresholds override the defaults", async () => {
	const humanAt = new Date("2026-10-30T13:00:00.000Z");
	const nowMs = humanAt.getTime() + 2 * 60_000;
	const entries = [humanEntry(humanAt), assistantEntry(new Date(humanAt.getTime() + 30_000), 4)];
	const file = await writeSession("req-env-override", entries);

	const original = process.env.OMP_INSIGHTS_RETRO_MIN_TOOL_CALLS;
	try {
		const host = fakeHost();
		retroExtension(host.pi, { dataDir, now: () => nowMs, env: { OMP_INSIGHTS_RETRO_MIN_TOOL_CALLS: "3" } });
		const result = await host.run({ session_id: SID, session_file: file });
		assert.ok(result, "expected the lowered threshold to trigger a retro");
	} finally {
		if (original === undefined) delete process.env.OMP_INSIGHTS_RETRO_MIN_TOOL_CALLS;
		else process.env.OMP_INSIGHTS_RETRO_MIN_TOOL_CALLS = original;
	}
});

test("only entries after the last human message count toward the trigger", async () => {
	const firstHumanAt = new Date("2026-10-30T14:00:00.000Z");
	const lastHumanAt = new Date("2026-10-30T14:05:00.000Z");
	const nowMs = lastHumanAt.getTime() + 2 * 60_000;
	const entries = [
		humanEntry(firstHumanAt, "first, long-running ask"),
		assistantEntry(new Date(firstHumanAt.getTime() + 60_000), 200),
		toolErrorEntry(new Date(firstHumanAt.getTime() + 61_000), "tc-old"),
		humanEntry(lastHumanAt, "second, short ask"),
		assistantEntry(new Date(lastHumanAt.getTime() + 30_000), 2),
	];
	const file = await writeSession("req-last-human-only", entries);

	const host = fakeHost();
	retroExtension(host.pi, { dataDir, now: () => nowMs, env: {} });

	const result = await host.run({ session_id: SID, session_file: file });
	assert.equal(result, undefined, "the earlier long request must not trigger the retro for the current short one");
});

test("slugifyProject: worktree and plain paths, special chars, missing cwd", () => {
	assert.equal(slugifyProject("/x/peach/.worktrees/develop-content"), "peach-develop-content");
	assert.equal(slugifyProject("/x/oh-my-pi-insights/.orca/worktrees/port-stage-1"), "oh-my-pi-insights-port-stage-1");
	assert.equal(slugifyProject("/x/tobias/oh-my-pi-insights"), "oh-my-pi-insights");
	assert.equal(slugifyProject("/x/My Repo!/"), "my-repo");
	assert.equal(slugifyProject(undefined), "unknown");
	assert.equal(slugifyProject(""), "unknown");
});

test("buildRetroPath: date, project and last-8-chars session id suffix", () => {
	const now = new Date(2026, 9, 30, 18, 1, 0);
	const id = "01a18dc2-061e-73d8-a2bc-0b1f5d4f9ebf";
	const path = buildRetroPath("/data", now, id, "peach-develop-content");
	assert.equal(path, join("/data", "retros", "2026-10-30T18-01_peach-develop-content_5d4f9ebf.md"));
});

test("buildRetroPath: missing session id falls back to unknown", () => {
	const now = new Date(2026, 9, 30, 18, 1, 0);
	const path = buildRetroPath("/data", now, "", "unknown");
	assert.equal(path, join("/data", "retros", "2026-10-30T18-01_unknown_unknown.md"));
});

test("retro path and header pick up the project slug and full session id from the session's cwd", async () => {
	const humanAt = new Date("2026-10-30T18:00:00.000Z");
	const nowMs = humanAt.getTime() + 40 * 60_000;
	const fullId = "01a18dc2-061e-73d8-a2bc-0b1f5d4f9ebf";
	const entries = [
		sessionHeaderEntry(humanAt, "/x/peach/.worktrees/develop-content", fullId),
		humanEntry(humanAt),
		assistantEntry(new Date(humanAt.getTime() + 60_000), 5),
	];
	const file = await writeSession("req-project-header", entries);

	const host = fakeHost();
	retroExtension(host.pi, { dataDir, now: () => nowMs, env: {} });

	const result = await host.run({ session_id: fullId, session_file: file });
	assert.ok(result, "expected a retro result");
	assert.match(result!.additionalContext, /retros[\\/].*peach-develop-content_5d4f9ebf\.md/);
	assert.match(result!.additionalContext, new RegExp(`Session: ${fullId}`));
	assert.match(result!.additionalContext, new RegExp(`Reopen: omp -r ${fullId}`));
	assert.match(result!.additionalContext, /Project: \/x\/peach\/\.worktrees\/develop-content/);
	assert.match(result!.additionalContext, /# Retro \d{4}-\d{2}-\d{2} \d{2}:\d{2} - peach-develop-content/);
});
