// SPDX-FileCopyrightText: 2026 Tobias Hoelzer (omp port)
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
	buildRetroContext,
	buildRetroPath,
	collectFailedToolLines,
	detectCorrections,
	followsAbortedTurn,
	isCorrectionMessage,
	quoteCorrections,
	retroExtension,
	slugifyProject,
	type RetroExtensionAPI,
	type RetroRequestData,
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

function toolErrorEntry(at: Date, toolCallId: string, text?: string, toolName = "bash"): Record<string, unknown> {
	return {
		type: "message",
		timestamp: ts(at),
		message: {
			role: "toolResult",
			toolCallId,
			toolName,
			isError: true,
			content: text === undefined ? [] : [{ type: "text", text }],
		},
	};
}

function emptySplit(): RetroRequestData["split"] {
	return {
		buckets: { model: 0, tools: 0, agents: 0, review: 0, ci: 0, you: 0, elsewhere: 0, idle: 0 },
		active_sec: 0,
		busy_by_tool: {},
		busy_by_command: {},
		subagent_busy_sec: 0,
		slowest_requests: [],
		you_gaps: [],
	};
}

function assistantAbortedEntry(at: Date): Record<string, unknown> {
	return {
		type: "message",
		timestamp: ts(at),
		message: { role: "assistant", stopReason: "aborted", content: [{ type: "text", text: "partial..." }] },
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
	assert.ok(result!.additionalContext.includes(`Log: ${file}`), "header names the session log file");
	assert.match(result!.additionalContext, /Project: \/x\/peach\/\.worktrees\/develop-content/);
	assert.match(result!.additionalContext, /# Retro \d{4}-\d{2}-\d{2} \d{2}:\d{2} - peach-develop-content/);
});

test("isCorrectionMessage: EN and DE positives", () => {
	assert.equal(isCorrectionMessage("No, that's not what I asked for"), true);
	assert.equal(isCorrectionMessage("not that one, the other file"), true);
	assert.equal(isCorrectionMessage("I said the backend, not the frontend"), true);
	assert.equal(isCorrectionMessage("please do it again, you missed a line"), true);
	assert.equal(isCorrectionMessage("stop editing that file"), true);
	assert.equal(isCorrectionMessage("don't do that"), true);
	assert.equal(isCorrectionMessage("this is wrong"), true);
	assert.equal(isCorrectionMessage("nein, das ist falsch"), true);
	assert.equal(isCorrectionMessage("mach das nochmal"), true);
	assert.equal(isCorrectionMessage("ich hab doch gesagt du sollst warten"), true);
});

test("isCorrectionMessage: false positives are guarded", () => {
	assert.equal(isCorrectionMessage("don't worry about it, looks fine"), false);
	assert.equal(isCorrectionMessage("no problem, go ahead"), false);
	assert.equal(isCorrectionMessage("stop on green means stop once the check passes"), false);
});

test("isCorrectionMessage: don't counts only when it is aimed at the agent", () => {
	assert.equal(isCorrectionMessage("I don't know what this is about"), false);
	assert.equal(isCorrectionMessage("we don't need that file anymore"), false);
	assert.equal(isCorrectionMessage("ok. don't push yet"), true);
	assert.equal(isCorrectionMessage("please don't merge it"), true);
	assert.equal(isCorrectionMessage("Dont touch main"), true);
});

test("isCorrectionMessage: plain requests are not corrections", () => {
	assert.equal(isCorrectionMessage("add a new endpoint for users"), false);
	assert.equal(isCorrectionMessage(""), false);
	assert.equal(isCorrectionMessage("   "), false);
});

test("followsAbortedTurn: true right after an aborted assistant turn, false otherwise", () => {
	const t0 = new Date("2026-10-31T09:00:00.000Z");
	const entries = [
		humanEntry(t0, "build the thing"),
		assistantAbortedEntry(new Date(t0.getTime() + 1000)),
		humanEntry(new Date(t0.getTime() + 2000), "hold on"),
		assistantEntry(new Date(t0.getTime() + 3000), 1),
		humanEntry(new Date(t0.getTime() + 4000), "continue please"),
	];
	assert.equal(followsAbortedTurn(entries, 2), true, "message right after the abort");
	assert.equal(followsAbortedTurn(entries, 4), false, "message after a normal, non-aborted turn");
	assert.equal(followsAbortedTurn(entries, 0), false, "first message has nothing before it");
});

test("detectCorrections: phrase matches and abort-follow, in order, text extracted verbatim", () => {
	const t0 = new Date("2026-10-31T10:00:00.000Z");
	const entries = [
		humanEntry(t0, "build the thing"),
		assistantAbortedEntry(new Date(t0.getTime() + 1000)),
		humanEntry(new Date(t0.getTime() + 2000), "hold on, let me rethink"),
		assistantEntry(new Date(t0.getTime() + 3000), 1),
		humanEntry(new Date(t0.getTime() + 4000), "no, not that one"),
	];
	const hits = detectCorrections(entries, 0);
	assert.deepEqual(
		hits.map((h) => h.reason),
		["abort-follow", "phrase"],
	);
	assert.equal(hits[0]!.text, "hold on, let me rethink");
	assert.equal(hits[1]!.text, "no, not that one");
});

test("detectCorrections: no hits when nothing in range matches", () => {
	const t0 = new Date("2026-10-31T11:00:00.000Z");
	const entries = [humanEntry(t0, "add a new endpoint"), assistantEntry(new Date(t0.getTime() + 1000), 2)];
	assert.deepEqual(detectCorrections(entries, 0), []);
});

test("quoteCorrections: caps at 5 hits and 200 chars each", () => {
	const hits = Array.from({ length: 7 }, (_, i) => ({ text: `correction number ${i}`, reason: "phrase" as const }));
	const quoted = quoteCorrections(hits);
	assert.equal(quoted.length, 5);
	assert.deepEqual(quoted, hits.slice(0, 5).map((h) => h.text));

	const longText = "x".repeat(250);
	assert.equal(quoteCorrections([{ text: longText, reason: "phrase" }])[0]!.length, 200);
});

test("collectFailedToolLines: first line, tool name prefix, skips ok results, caps at 5 and 200 chars", () => {
	const t0 = new Date("2026-10-31T12:00:00.000Z");
	const okResult = {
		type: "message",
		timestamp: ts(t0),
		message: { role: "toolResult", toolCallId: "tc-ok", toolName: "bash", isError: false, content: [] },
	};
	const manyErrors = Array.from({ length: 6 }, (_, i) =>
		toolErrorEntry(new Date(t0.getTime() + i * 1000), `tc-${i}`, `line one of error ${i}\nmore detail here`),
	);
	const entries = [okResult, ...manyErrors, toolErrorEntry(new Date(t0.getTime() + 60_000), "tc-long", "y".repeat(250))];
	const lines = collectFailedToolLines(entries, 0);
	assert.equal(lines.length, 5, "capped at 5");
	assert.equal(lines[0], "bash: line one of error 0");
	assert.ok(!lines.some((l) => l.includes("more detail here")), "only the first line is kept");
});

test("collectFailedToolLines: no output falls back to a placeholder", () => {
	const t0 = new Date("2026-10-31T12:30:00.000Z");
	const entries = [toolErrorEntry(t0, "tc-empty")];
	assert.deepEqual(collectFailedToolLines(entries, 0), ["bash: (no output)"]);
});

test("trigger: a correction fires the retro even under both time and tool-call thresholds", async () => {
	const humanAt = new Date("2026-10-31T13:00:00.000Z");
	const nowMs = humanAt.getTime() + 2 * 60_000;
	const entries = [humanEntry(humanAt, "no, not that, I said the other file"), assistantEntry(new Date(humanAt.getTime() + 30_000), 2)];
	const file = await writeSession("req-correction-trigger", entries);

	const host = fakeHost();
	retroExtension(host.pi, { dataDir, now: () => nowMs, env: {} });
	const result = await host.run({ session_id: SID, session_file: file });
	assert.ok(result, "a correction must trigger the retro regardless of thresholds");
	assert.match(result!.additionalContext, /Corrections quoted from this request:/);
	assert.match(result!.additionalContext, /"no, not that, I said the other file"/);
});

test("trigger: a message right after an aborted turn fires the retro under both thresholds", async () => {
	const humanAt = new Date("2026-10-31T13:10:00.000Z");
	const nowMs = humanAt.getTime() + 2 * 60_000;
	const entries = [
		humanEntry(new Date(humanAt.getTime() - 5000), "build the thing"),
		assistantAbortedEntry(humanAt),
		humanEntry(new Date(humanAt.getTime() + 1000), "let me think about this differently"),
		assistantEntry(new Date(humanAt.getTime() + 2000), 1),
	];
	const file = await writeSession("req-abort-follow-trigger", entries);

	const host = fakeHost();
	retroExtension(host.pi, { dataDir, now: () => nowMs, env: {} });
	const result = await host.run({ session_id: SID, session_file: file });
	assert.ok(result, "a message right after an abort must trigger the retro");
});

test("trigger: a known false positive does not fire the retro under both thresholds", async () => {
	const humanAt = new Date("2026-10-31T13:20:00.000Z");
	const nowMs = humanAt.getTime() + 2 * 60_000;
	const entries = [humanEntry(humanAt, "no problem, continue with the plan"), assistantEntry(new Date(humanAt.getTime() + 30_000), 2)];
	const file = await writeSession("req-false-positive", entries);

	const host = fakeHost();
	retroExtension(host.pi, { dataDir, now: () => nowMs, env: {} });
	const result = await host.run({ session_id: SID, session_file: file });
	assert.equal(result, undefined);
});

test("buildRetroContext: new sections, contract line format, and data block with corrections and failed tools", () => {
	const data: RetroRequestData = {
		wallClockMinutes: 45,
		toolCalls: 12,
		toolErrors: 1,
		split: emptySplit(),
		now: new Date(2026, 9, 31, 14, 0, 0),
		project: "oh-my-pi-insights",
		sessionId: SID,
		cwd: "/x/oh-my-pi-insights",
		sessionFile: "/x/sessions/log.jsonl",
		corrections: ["no, not that one"],
		failedTools: ["bash: command not found: foo"],
		triggeredByCorrectionOnly: false,
	};
	const context = buildRetroContext(data, "/data/retros/out.md");

	assert.match(context, /## Biggest time sink/);
	assert.match(context, /## Corrections and lessons/);
	assert.match(context, /## Improvement proposals/);
	assert.ok(!context.includes("## What went well"));
	assert.ok(!context.includes("## What went badly"));
	assert.match(context, /\[<target>\].*\| moment: "<quoted user or tool line, max 120 chars>"/);
	assert.match(context, /check, reviewer-standard, skill, pointer, preferences, none/);
	assert.match(context, /navigation, automated-check, coding-standard, global-AGENTS\.md, tool-economy, no-ops, information-access, user-preference/);
	assert.match(context, /Write "- none" if nothing qualifies/);
	assert.match(context, /Corrections quoted from this request:[\s\S]*- "no, not that one"/);
	assert.match(context, /Failed tool results from this request:[\s\S]*- bash: command not found: foo/);
});

test("buildRetroContext: empty corrections and failed tools render as none", () => {
	const data: RetroRequestData = {
		wallClockMinutes: 45,
		toolCalls: 12,
		toolErrors: 0,
		split: emptySplit(),
		now: new Date(2026, 9, 31, 14, 0, 0),
		project: "oh-my-pi-insights",
		sessionId: SID,
		cwd: "/x/oh-my-pi-insights",
		sessionFile: "/x/sessions/log.jsonl",
		corrections: [],
		failedTools: [],
		triggeredByCorrectionOnly: false,
	};
	const context = buildRetroContext(data, "/data/retros/out.md");
	assert.match(context, /Corrections quoted from this request:\n- none/);
	assert.match(context, /Failed tool results from this request:\n- none/);
});

test("buildRetroContext: first line names the correction when neither size threshold fired", () => {
	const base: RetroRequestData = {
		wallClockMinutes: 2,
		toolCalls: 1,
		toolErrors: 0,
		split: emptySplit(),
		now: new Date(2026, 9, 31, 14, 0, 0),
		project: "oh-my-pi-insights",
		sessionId: SID,
		cwd: "/x/oh-my-pi-insights",
		sessionFile: "/x/sessions/log.jsonl",
		corrections: ["no, not that one"],
		failedTools: [],
		triggeredByCorrectionOnly: true,
	};
	const correctionOnly = buildRetroContext(base, "/data/retros/out.md");
	assert.match(correctionOnly, /^This request contained a correction, so it gets a short retro\./);
	assert.ok(!correctionOnly.includes("This request ran long enough to warrant a retro."));

	const overThreshold = buildRetroContext({ ...base, triggeredByCorrectionOnly: false }, "/data/retros/out.md");
	assert.match(overThreshold, /^This request ran long enough to warrant a retro\./);
	assert.ok(!overThreshold.includes("This request contained a correction, so it gets a short retro."));
});

test("retro-prompt.md in the data dir replaces the built-in instructions; header and data block stay", async () => {
	const ownDir = join(root, "custom-prompt");
	await mkdir(ownDir, { recursive: true });
	await writeFile(join(ownDir, "retro-prompt.md"), "## My section\nReply with: Retro: {{retroPath}}\n", "utf-8");
	const humanAt = new Date("2026-10-31T15:00:00.000Z");
	const nowMs = humanAt.getTime() + 40 * 60_000;
	const file = await writeSession("req-custom-prompt", [humanEntry(humanAt), assistantEntry(new Date(humanAt.getTime() + 60_000), 3)]);

	const host = fakeHost();
	retroExtension(host.pi, { dataDir: ownDir, now: () => nowMs, env: {} });
	const context = (await host.run({ session_id: SID, session_file: file }))!.additionalContext;
	assert.match(context, /## My section/);
	assert.match(context, /Reply with: Retro: .*custom-prompt[\\/]retros[\\/].*\.md/);
	assert.ok(!context.includes("{{retroPath}}"));
	assert.ok(!context.includes("## Biggest time sink"), "built-in sections are replaced");
	assert.match(context, /Tool calls: 3/);
	assert.match(context, new RegExp(`Session: ${SID}`));
});

test("an empty retro-prompt.md falls back to the built-in instructions", async () => {
	const ownDir = join(root, "empty-prompt");
	await mkdir(ownDir, { recursive: true });
	await writeFile(join(ownDir, "retro-prompt.md"), "  \n", "utf-8");
	const humanAt = new Date("2026-10-31T16:00:00.000Z");
	const nowMs = humanAt.getTime() + 40 * 60_000;
	const file = await writeSession("req-empty-prompt", [humanEntry(humanAt), assistantEntry(new Date(humanAt.getTime() + 60_000), 3)]);

	const host = fakeHost();
	retroExtension(host.pi, { dataDir: ownDir, now: () => nowMs, env: {} });
	const context = (await host.run({ session_id: SID, session_file: file }))!.additionalContext;
	assert.match(context, /## Biggest time sink/);
	assert.match(context, /Retro: .*empty-prompt[\\/]retros[\\/]/);
});
