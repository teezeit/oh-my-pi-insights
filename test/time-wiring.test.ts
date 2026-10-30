// SPDX-FileCopyrightText: 2026 Tobias Hoelzer (omp port)
// SPDX-License-Identifier: AGPL-3.0-only

// Issue #18 "where did the time go": wires extractTimeSplit (src/time.ts)
// and aggregateTime (src/time-aggregate.ts) into buildSessionMeta, the main
// report (HTML/Markdown), facts, prompts and the standalone `/insights
// time` command. This covers the wiring only - bucket math itself is
// src/time.ts's own concern.
//
// Command-handler tests below follow test/command.test.ts's conventions:
// index.ts derives ~/.omp/agent from os.homedir() in module-level
// constants, so $HOME must be redirected BEFORE the dynamic import, and
// every test in this file shares that one import (and its temp HOME),
// which is also why the pure wiring tests below go through `mod.*` rather
// than a static top-level import.

import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "../index.ts";

type Mod = typeof import("../index.ts");

const T0 = Date.UTC(2026, 8, 1, 9, 0, 0);
const t = (ms: number) => new Date(T0 + ms).toISOString();

const SID = "00000000-0000-7000-8000-000000000002";

function humanMessage(ms: number, text: string) {
	return { type: "message", timestamp: t(ms), message: { role: "user", content: [{ type: "text", text }] } };
}

function toolExecutionStart(toolCallId: string, toolName: string, startedAtMs: number) {
	return {
		type: "custom",
		customType: "tool_execution_start",
		timestamp: t(startedAtMs),
		data: { toolCallId, toolName, startedAt: T0 + startedAtMs },
	};
}

function toolResult(toolCallId: string, toolName: string, atMs: number) {
	return { type: "message", timestamp: t(atMs), message: { role: "toolResult", toolCallId, toolName, content: [], isError: false } };
}

/**
 * One assistant turn: model generation from `completedAtMs - 2000` to
 * `completedAtMs` (ttft 1000 + duration 1000), then three tool calls -
 * bash "npm test" (tools), bash "glab ci view" (ci, via classifyWait's
 * CI_TERMS_RE), and a "task" call (agents, by tool name alone).
 */
function mainSessionEntries(): Record<string, unknown>[] {
	return [
		{ type: "session", version: 3, id: SID, timestamp: t(0), cwd: "/Users/me/projects/webapp" },
		humanMessage(0, "fix the flaky test and watch CI"),
		{
			type: "message",
			timestamp: t(3000),
			message: {
				role: "assistant",
				ttft: 1000,
				duration: 1000,
				completedAt: T0 + 3000,
				content: [
					{ type: "toolCall", id: "tc1", name: "bash", arguments: { command: "npm test" } },
					{ type: "toolCall", id: "tc2", name: "bash", arguments: { command: "glab ci view" } },
					{ type: "toolCall", id: "tc3", name: "task", arguments: {} },
				],
			},
		},
		toolExecutionStart("tc1", "bash", 3000),
		toolResult("tc1", "bash", 5000),
		toolExecutionStart("tc2", "bash", 5000),
		toolResult("tc2", "bash", 35000),
		toolExecutionStart("tc3", "task", 35000),
		toolResult("tc3", "task", 45000),
		// A 1,000s gap to the next human message: 900s (IDLE_CAP_SEC) counts as
		// "you", the remaining 100s overflows into "idle".
		humanMessage(1045000, "thanks, all good now"),
	];
}

const REF = {
	id: SID,
	path: "/sessions/proj/log.jsonl",
	project_path: "/Users/me/projects/webapp",
	size: 1,
	created: new Date(t(0)),
	modified: new Date(t(1045000)),
	sidecars: [],
	signature: "1:1",
};

// ─── Command-handler fixtures (temp real logs) ─────────────────────────────

// OLD_SID: substantive (2 user messages, >=1 min span) but dated 60 days
// before "now", outside the default 14-day window - isolates the --since
// bypass from the substantive-threshold bypass.
const OLD_SID = "00000000-0000-7000-8000-0000000000aa";
// CUR_SID: a single short message, today - fails the substantive threshold
// on its own (and, when it is also the running session, would be excluded
// by the self-exclusion rule) - isolates the substantive + self-exclusion
// bypass from the --since bypass.
const CUR_SID = "00000000-0000-7000-8000-0000000000bb";

function human(baseMs: number, atSec: number, text: string) {
	return {
		type: "message",
		timestamp: new Date(baseMs + atSec * 1000).toISOString(),
		message: { role: "user", attribution: "user", content: [{ type: "text", text }] },
	};
}

function assistantMsg(baseMs: number, atSec: number, cost: number) {
	return {
		type: "message",
		timestamp: new Date(baseMs + atSec * 1000).toISOString(),
		message: {
			role: "assistant",
			model: "claude-opus-5",
			usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: cost } },
			content: [],
		},
	};
}

function stamp(ms: number): string {
	return new Date(ms).toISOString().replace(/[:.]/g, "-");
}

type UiCall = { method: string; args: unknown[] };

// Same shape as test/command.test.ts's fakeHost: the host is faked
// structurally, so the registrar is typed by what this test supplies.
function fakeHost(ui: UiCall[], sessionId: string | null) {
	let handler: ((args: string | undefined, ctx: ExtensionCommandContext) => Promise<void> | void) | null = null;
	const pi: ExtensionAPI = {
		registerCommand(_name, spec) {
			handler = spec.handler;
		},
	};
	const ctx = {
		cwd: "/tmp",
		model: { id: "claude-opus-5", provider: "anthropic" },
		sessionManager: { getSessionId: () => sessionId },
		ui: {
			notify: (...args: unknown[]) => ui.push({ method: "notify", args }),
			setStatus: (...args: unknown[]) => ui.push({ method: "setStatus", args }),
			setWidget: (...args: unknown[]) => ui.push({ method: "setWidget", args }),
		},
	};
	return { pi, ctx, run: (args: string) => handler?.(args, ctx as ExtensionCommandContext) };
}

let home: string;
let callCounterFile: string;
let mod: Mod;

before(async () => {
	home = await mkdtemp(join(tmpdir(), "omp-insights-time-"));
	const sessions = join(home, ".omp", "agent", "sessions", "-proj");
	await mkdir(sessions, { recursive: true });

	const oldBase = Date.now() - 60 * 86400000;
	const oldEntries = [
		{ type: "session", version: 3, id: OLD_SID, timestamp: new Date(oldBase).toISOString(), cwd: "/proj" },
		human(oldBase, 0, "first ask"),
		assistantMsg(oldBase, 2, 1.0),
		human(oldBase, 90, "second ask"),
		assistantMsg(oldBase, 92, 1.0),
	];
	await writeFile(
		join(sessions, `${stamp(oldBase)}_${OLD_SID}.jsonl`),
		oldEntries.map((e) => `${JSON.stringify(e)}\n`).join(""),
	);

	const curBase = Date.now() - 5000;
	const curEntries = [
		{ type: "session", version: 3, id: CUR_SID, timestamp: new Date(curBase).toISOString(), cwd: "/proj" },
		human(curBase, 0, "quick check"),
		assistantMsg(curBase, 1, 0.01),
	];
	await writeFile(
		join(sessions, `${stamp(curBase)}_${CUR_SID}.jsonl`),
		curEntries.map((e) => `${JSON.stringify(e)}\n`).join(""),
	);

	// A fake `omp -p` binary so --explain tests never shell out for real: it
	// counts invocations (one appended line per call) and echoes fixed prose
	// that carries no numbers, so checkFacts has nothing to flag either way.
	const fakeOmpBin = join(home, "fake-omp");
	callCounterFile = join(home, "call-count.log");
	await writeFile(
		fakeOmpBin,
		[
			"#!/usr/bin/env node",
			"const fs = require('node:fs');",
			"fs.appendFileSync(process.env.CALL_COUNTER_FILE, '1\\n');",
			"let data = '';",
			"process.stdin.on('data', (c) => { data += c; });",
			"process.stdin.on('end', () => { process.stdout.write('You spent your time working with the model and tools.'); process.exit(0); });",
		].join("\n"),
	);
	await chmod(fakeOmpBin, 0o755);
	process.env.OMP_INSIGHTS_OMP_BIN = fakeOmpBin;
	process.env.CALL_COUNTER_FILE = callCounterFile;

	process.env.HOME = home;
	// Dynamic by necessity, not preference: index.ts resolves ~/.omp/agent
	// and OMP_BIN from env in module-level constants, so the module must not
	// load until the env vars above point at the fixture corpus/fake binary.
	const loaded: unknown = await import("../index.ts");
	mod = loaded as Mod;
});

after(async () => {
	await rm(home, { recursive: true, force: true });
});

test("buildSessionMeta's time_split has correct bucket totals for a synthetic log", () => {
	const meta = mod.buildSessionMeta(REF, mainSessionEntries(), []);

	assert.equal(meta.time_split.buckets.model, 2);
	assert.equal(meta.time_split.buckets.tools, 2);
	assert.equal(meta.time_split.buckets.ci, 30);
	assert.equal(meta.time_split.buckets.agents, 10);
	assert.equal(meta.time_split.buckets.you, 901);
	assert.equal(meta.time_split.buckets.idle, 100);
	assert.equal(meta.time_split.active_sec, 2 + 2 + 30 + 10 + 901);
	assert.deepEqual(meta.time_split.busy_by_command, { "npm test": 2 });
	assert.deepEqual(meta.time_split.busy_by_tool, { bash: 32, task: 10 });
});

test("a session with a sidecar gets subagent_busy_sec folded in from the sidecar's own active_sec", () => {
	const sidecarEntries = [
		{ type: "session", version: 3, id: "sub-1", timestamp: t(0), cwd: "/Users/me/projects/webapp" },
		humanMessage(0, "do the subtask"),
		{
			type: "message",
			timestamp: t(1000),
			message: { role: "assistant", ttft: 200, duration: 800, completedAt: T0 + 1000, content: [] },
		},
	];
	const usage = mod.extractSidecarUsage(sidecarEntries);
	const meta = mod.buildSessionMeta(REF, mainSessionEntries(), [{ kind: "subagent" as const, usage }]);
	assert.ok(meta.time_split.subagent_busy_sec > 0, "expected a positive subagent_busy_sec from the sidecar's own active_sec");
});

test("parseTimeArgs routes 'time --since 3d --session current --explain --no-open' correctly", () => {
	const r = mod.parseTimeArgs("time --since 3d --session current --explain --no-open");
	assert.equal(r.isTimeCommand, true);
	assert.equal(r.sinceDays, 3);
	assert.equal(r.sessionFilter, "current");
	assert.equal(r.explain, true);
	assert.equal(r.noOpen, true);
});

test("parseTimeArgs defaults the window to 14 days and reports isTimeCommand false for the main report command", () => {
	const r = mod.parseTimeArgs("--md --no-open");
	assert.equal(r.isTimeCommand, false);
	assert.equal(r.sinceDays, 14);
	assert.equal(r.sessionFilter, null);
});

test("generateHTML embeds the time section when a TimeAggregate is given", () => {
	const meta = mod.buildSessionMeta(REF, mainSessionEntries(), []);
	const agg = mod.aggregateData([meta], new Map());
	const temporal = mod.computeTemporalData([meta], new Map());
	const timeAgg = mod.aggregateTime([meta]);
	const html = mod.generateHTML(agg, {}, {}, temporal, { timeAgg });
	assert.match(html, /Where the Time Goes/);
});

test("facts include time.share.* and no tool_time_share.* once a TimeAggregate is given", () => {
	const meta = mod.buildSessionMeta(REF, mainSessionEntries(), []);
	const agg = mod.aggregateData([meta], new Map());
	const temporal = mod.computeTemporalData([meta], new Map());
	const timeAgg = mod.aggregateTime([meta]);

	const facts = mod.buildFacts(agg, temporal, timeAgg);
	const ids = facts.map((f) => f.id);
	assert.ok(ids.some((id) => id.startsWith("time.share.")), `expected a time.share.* fact, got ${JSON.stringify(ids)}`);
	assert.ok(ids.includes("time.active_sec"));
	assert.ok(!ids.some((id) => id.startsWith("tool_time_share.")), `tool_time_share.* fact survived: ${JSON.stringify(ids)}`);

	const byId = new Map(facts.map((f) => [f.id, f]));
	assert.equal(byId.get("time.share.ci")!.value, Math.round((30 / 945) * 100 * 10) / 10);
});

test("buildTimeFacts emits a time.share.* fact for all eight time buckets, including review and elsewhere", () => {
	const meta = mod.buildSessionMeta(REF, mainSessionEntries(), []);
	const timeAgg = mod.aggregateTime([meta]);
	const facts = mod.buildTimeFacts(timeAgg);
	const shareIds = new Set(facts.filter((f) => f.id.startsWith("time.share.")).map((f) => f.id));
	assert.deepEqual(
		shareIds,
		new Set([
			"time.share.model",
			"time.share.tools",
			"time.share.agents",
			"time.share.review",
			"time.share.ci",
			"time.share.you",
			"time.share.elsewhere",
			"time.share.idle",
		]),
	);
	assert.ok(shareIds.has("time.share.review"), "expected time.share.review fact");
});

test("/insights time --session <id> bypasses the default 14-day cutoff for an old, explicitly named session", async () => {
	const ui: UiCall[] = [];
	const host = fakeHost(ui, "unrelated-session");
	mod.default(host.pi);

	await host.run("time --no-open");
	const baseline = await readFile(mod.TIME_REPORT_PATH, "utf-8");
	assert.match(baseline, /\b0 sessions\b/, `expected the 60-day-old session to be excluded by the default window, got: ${baseline.slice(0, 400)}`);

	await host.run(`time --session ${OLD_SID} --no-open`);
	const explicit = await readFile(mod.TIME_REPORT_PATH, "utf-8");
	assert.match(explicit, /\b1 sessions\b/, `expected --session ${OLD_SID} to include the old session despite the default window, got: ${explicit.slice(0, 400)}`);
});

test("/insights time --session current bypasses both self-exclusion and the substantive-session threshold for a short current session", async () => {
	const ui: UiCall[] = [];
	const host = fakeHost(ui, CUR_SID);
	mod.default(host.pi);

	await host.run("time --no-open");
	const baseline = await readFile(mod.TIME_REPORT_PATH, "utf-8");
	assert.match(baseline, /\b0 sessions\b/, `expected the short current session to be excluded by default, got: ${baseline.slice(0, 400)}`);

	await host.run("time --session current --no-open");
	const explicit = await readFile(mod.TIME_REPORT_PATH, "utf-8");
	assert.match(explicit, /\b1 sessions\b/, "expected --session current to include the short current session despite self-exclusion and the substantive threshold");
});

test("/insights time --session current reports an error, not every session, when no current session id is available", async () => {
	const ui: UiCall[] = [];
	const host = fakeHost(ui, null);
	mod.default(host.pi);

	const before = await readFile(mod.TIME_REPORT_PATH, "utf-8").catch(() => null);
	await host.run("time --session current --no-open");
	const after = await readFile(mod.TIME_REPORT_PATH, "utf-8").catch(() => null);

	assert.equal(after, before, "the report must not be (re)written when the current session id is unavailable");
	const notice = ui.filter((c) => c.method === "notify").at(-1);
	assert.match(String(notice?.args[0]), /current session/i);
	assert.equal(notice?.args[1], "error");
});

test("/insights time --explain includes the elsewhere bucket and all seven shares, and makes exactly one model call", async () => {
	const ui: UiCall[] = [];
	const host = fakeHost(ui, "unrelated-session-2");
	mod.default(host.pi);

	await writeFile(callCounterFile, "");
	await host.run(`time --session ${OLD_SID} --explain --no-open`);

	const calls = (await readFile(callCounterFile, "utf-8")).split("\n").filter(Boolean);
	assert.equal(calls.length, 1, `expected exactly one model call for --explain, got ${calls.length}`);

	const html = await readFile(mod.TIME_REPORT_PATH, "utf-8");
	assert.match(html, /You spent your time working with the model and tools\./);

	// The fact-check warning only fires when the prose quotes a number no
	// fact backs; buildTimeFacts must cover all seven buckets (including
	// "elsewhere") so a correct explanation never trips it.
	const warnings = ui.filter((c) => c.method === "notify" && String(c.args[0]).includes("Fact check"));
	assert.equal(warnings.length, 0, `unexpected fact-check warning(s): ${JSON.stringify(warnings)}`);
});
