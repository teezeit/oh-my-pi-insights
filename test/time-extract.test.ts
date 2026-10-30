// SPDX-FileCopyrightText: 2026 Hari Srinivasan <harisrini21@gmail.com>
// SPDX-FileCopyrightText: 2026 Tobias Hoelzer (omp port)
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { test } from "node:test";
import { IDLE_CAP_SEC, classifyWait, commandFamily, extractTimeSplit } from "../src/time.ts";
import type { AnyEntry } from "../src/types.ts";

// ── classifyWait ──────────────────────────────────────────────────────────

test("classifyWait: glab ci status --wait is a CI wait", () => {
	assert.equal(classifyWait("bash", "glab ci status --wait"), "ci");
});

test("classifyWait: python poll loop with gh pr checks is a CI wait", () => {
	const code = "while True:\n\tresult = sh('gh pr checks')\n\tif result.ok:\n\t\tbreak\n\ttime.sleep(30)";
	assert.equal(classifyWait("eval", code), "ci");
});

test("classifyWait: python sleep + for loop driving orca is an agent wait", () => {
	const code = "time.sleep(10)\nfor d in targets:\n\tsh('orca orchestration worker-read ' + d)";
	assert.equal(classifyWait("eval", code), "agents");
});

test("classifyWait: bash until/sleep loop with no CI or agent target is generic polling", () => {
	assert.equal(classifyWait("bash", "until curl -s localhost:3000; do sleep 1; done"), "polling");
});

test("classifyWait: plain command is not a wait", () => {
	assert.equal(classifyWait("bash", "npm test"), null);
});

test("classifyWait: wait tool is always an agent wait, regardless of text", () => {
	assert.equal(classifyWait("wait", ""), "agents");
});

test("classifyWait: vibe_wait and other *_wait tool names are agent waits regardless of text", () => {
	assert.equal(classifyWait("vibe_wait", ""), "agents");
	assert.equal(classifyWait("foo_wait", "anything"), "agents");
});

test("classifyWait: a lone 'pipeline' word in code is not a CI wait", () => {
	const code = "const pipeline = buildPipeline();\nconsole.log('running pipeline', pipeline.id);";
	assert.equal(classifyWait("eval", code), null);
	// Real CI commands (no bare "pipeline" needed) still detect.
	assert.equal(classifyWait("bash", "glab ci status --wait"), "ci");
});

test("classifyWait: a glab api pipelines call (CI API polling) is a CI wait", () => {
	assert.equal(
		classifyWait("bash", 'sleep 20; p=$(glab api "projects/x%2Fy/pipelines?sha=abc" | jq ...)'),
		"ci",
	);
});

test("classifyWait: a subprocess.run glab api pipelines call in a sleep loop is a CI wait", () => {
	const code = "while True:\n\tsubprocess.run(['glab', 'api', 'projects/x/pipelines'])\n\ttime.sleep(5)";
	assert.equal(classifyWait("eval", code), "ci");
});

test("classifyWait: a gh api actions/runs call is a CI wait", () => {
	assert.equal(classifyWait("bash", 'gh api "repos/x/y/actions/runs"'), "ci");
});

test("classifyWait: gh run list is a CI wait", () => {
	assert.equal(classifyWait("bash", "gh run list --limit 5"), "ci");
});

test("classifyWait: a poll helper labeled with reviewer/verdict text is a review wait", () => {
	assert.equal(
		classifyWait("eval", 'real,fin,st=poll3(action="Waiting for backend!395 reviewer verdict", max_s=1600)'),
		"review",
	);
});

test("classifyWait: a poll helper labeled with a worker/dispatch target is an agent wait", () => {
	assert.equal(classifyWait("eval", 'poll3(action="Waiting for DEV-1 MR1 worker_done")'), "agents");
});

test("classifyWait: a poll helper labeled with a pipeline target is a CI wait", () => {
	assert.equal(classifyWait("eval", 'poll3(action="Waiting for pipeline 74438")'), "ci");
});

test("classifyWait: orca orchestration check --wait is a blocking agent wait", () => {
	assert.equal(classifyWait("bash", "orca orchestration check job-1 --wait"), "agents");
});

test("classifyWait: orca orchestration check --wait with review wording is a review wait", () => {
	assert.equal(classifyWait("bash", "orca orchestration check review-188 --wait"), "review");
});

test("classifyWait: orca terminal wait is a blocking agent wait", () => {
	assert.equal(classifyWait("bash", "orca terminal wait --for term-1"), "agents");
});

test("classifyWait: orca orchestration ask blocks for a reply and is an agent wait", () => {
	assert.equal(classifyWait("bash", "orca orchestration ask coordinator-1 'any update?'"), "agents");
});

test("classifyWait: non-blocking orca calls (send, worker-read, worker-list, terminal send/read/list) are not waits", () => {
	assert.equal(classifyWait("bash", "orca orchestration send worker-1 'go'"), null);
	assert.equal(classifyWait("bash", "orca worker-read ctx_1"), null);
	assert.equal(classifyWait("bash", "orca worker-list"), null);
	assert.equal(classifyWait("bash", "orca terminal send term-1 'hi'"), null);
	assert.equal(classifyWait("bash", "orca terminal read term-1"), null);
	assert.equal(classifyWait("bash", "orca terminal list"), null);
});


// ── commandFamily ─────────────────────────────────────────────────────────

test("commandFamily: cd prefix and args are stripped down to the verb", () => {
	assert.equal(commandFamily("bash", "cd x && npm test -- --run"), "npm test");
});

test("commandFamily: env assignment prefix is stripped", () => {
	assert.equal(commandFamily("bash", "FOO=1 pnpm build"), "pnpm build");
});

test("commandFamily: uv run wrapper is stripped down to the real command", () => {
	assert.equal(commandFamily("bash", "uv run pytest -q"), "pytest");
});

test("commandFamily: bash for-loop with no polling uses the body's command family", () => {
	assert.equal(commandFamily("bash", "for f in *.ts; do npx tsc $f; done"), "tsc");
});

test("commandFamily: bash loop polling a CI target is classified as polling: ci", () => {
	assert.equal(
		commandFamily("bash", "for i in $(seq 1 60); do gh pr checks 1 && break; sleep 10; done"),
		"polling: ci",
	);
});

test("commandFamily: eval code with a reviewer-labeled poll helper is classified as polling: review", () => {
	assert.equal(
		commandFamily("eval", 'real,fin,st=poll3(action="Waiting for backend!395 reviewer verdict", max_s=1600)', "py"),
		"polling: review",
	);
});

test("commandFamily: a 'set -euo pipefail;' setup prefix is stripped down to the real command", () => {
	assert.equal(commandFamily("bash", "set -euo pipefail; pnpm test"), "pnpm test");
});

test("commandFamily: eval code driving the browser global is grouped as eval: browser", () => {
	const code = "await browser.open({ app: { relay: true } });\nawait browser.goto('https://example.com');";
	assert.equal(commandFamily("eval", code, "js"), "eval: browser");
});

test("commandFamily: eval code calling sh() groups by the underlying shell command", () => {
	assert.equal(commandFamily("eval", "sh('orca orchestration worker-read ' + d)", "py"), "orca orchestration");
});

test("commandFamily: eval code calling Bun.$ groups by the underlying shell command", () => {
	assert.equal(commandFamily("eval", "const out = await Bun.$`gh pr view 123`.text();", "js"), "gh pr");
});

test("commandFamily: generic eval code is tagged by language, not a bare 'eval'", () => {
	assert.equal(commandFamily("eval", "const sum = items.reduce((a, b) => a + b, 0);", "js"), "eval: js");
	assert.equal(commandFamily("eval", "import json\nprint(json.dumps({'a': 1}))", "py"), "eval: python");
});

// A `polling: <target>` family and classifyWait's bucket kind are derived
// from the same underlying classification, so they can never disagree: a
// "generic" target always pairs with the generic "polling" kind (bucket
// tools), and any other target always pairs with a real wait kind
// (ci/review/agents, excluded from busy_by_command). Regression for #19:
// a poll-helper call with an unrecognized label used to short-circuit
// classifyWait to "polling" while commandFamily separately re-scanned the
// full text for an agent term and reported "polling: worker" anyway.
test("classifyWait and commandFamily agree on every 'polling: <target>' family", () => {
	const samples: Array<{ toolName: "bash" | "eval"; text: string; language?: string }> = [
		{ toolName: "bash", text: "glab ci status --wait" },
		{ toolName: "bash", text: 'sleep 20; p=$(glab api "projects/x%2Fy/pipelines?sha=abc" | jq ...)' },
		{ toolName: "bash", text: 'gh api "repos/x/y/actions/runs"' },
		{
			toolName: "eval",
			text: 'real,fin,st=poll3(action="Waiting for backend!395 reviewer verdict", max_s=1600)',
			language: "py",
		},
		{ toolName: "eval", text: 'poll3(action="Waiting for DEV-1 MR1 worker_done")', language: "py" },
		{ toolName: "eval", text: 'poll3(action="Waiting for pipeline 74438")', language: "py" },
		{ toolName: "eval", text: 'poll3(action="Waiting for build artifact")', language: "py" },
		{
			toolName: "eval",
			text: "time.sleep(10)\nfor d in targets:\n\tsh('orca orchestration worker-read ' + d)",
			language: "py",
		},
		{ toolName: "bash", text: "until curl -s localhost:3000; do sleep 1; done" },
		{ toolName: "bash", text: "orca orchestration check job-1 --wait" },
		{ toolName: "bash", text: "orca orchestration check review-188 --wait" },
		{ toolName: "bash", text: "orca terminal wait --for term-1" },
		{ toolName: "bash", text: "orca orchestration ask coordinator-1 'any update?'" },
		{ toolName: "bash", text: "orca orchestration send worker-1 'go'" },
		{ toolName: "bash", text: "orca worker-read ctx_1" },
		{ toolName: "bash", text: "npm test" },
		{
			toolName: "eval",
			text: "const pipeline = buildPipeline();\nconsole.log('running pipeline', pipeline.id);",
			language: "js",
		},
	];

	for (const { toolName, text, language } of samples) {
		const kind = classifyWait(toolName, text);
		const family = commandFamily(toolName, text, language);
		if (family.startsWith("polling: ")) {
			const target = family.slice("polling: ".length);
			if (target === "generic") assert.equal(kind, "polling", `${family} should pair with kind "polling" (${text})`);
			else assert.ok(kind === "ci" || kind === "review" || kind === "agents", `${family} should pair with a real wait kind, got ${kind} (${text})`);
		} else {
			assert.ok(kind !== "ci" && kind !== "review" && kind !== "agents" && kind !== "polling", `non-"polling: " family ${family} should not be a wait, got kind ${kind} (${text})`);
		}
	}
});


// ── extractTimeSplit ──────────────────────────────────────────────────────

// Fixture layout (all timestamps ms, session starts at t=0):
//   t=0       human "do x"
//   t=0-10000 model generation (ttft 4000 + duration 6000), completedAt=10000
//   t=10000-40000 bash "echo hi" (30s)
//   t=20000-140000 task (120s), overlapping the bash call by 20s (20000-40000)
//   t=140000-200000 ask (60s)
//   t=1400000 human "ok thanks" (1,200,000ms = 20min gap since the ask ended)
//
// Expected buckets: model 10s, tools 10s (bash's 30s minus the 20s the task
// overlaps), agents 120s (task), you 960s (ask's 60s + the 20min gap capped
// at IDLE_CAP_SEC=900s), idle 300s (the gap's overflow past the cap).
function buildFixture(): AnyEntry[] {
	const session = {
		type: "session",
		version: 3,
		id: "00000000-0000-7000-8000-000000000001",
		timestamp: new Date(0).toISOString(),
		cwd: "/Users/me/projects/webapp",
	};
	const human = (text: string, at: number) => ({
		type: "message",
		timestamp: new Date(at).toISOString(),
		message: {
			role: "user",
			attribution: "user",
			content: [{ type: "text", text }],
			timestamp: at,
		},
	});
	const assistant = (ttft: number, duration: number, completedAt: number, blocks: unknown[]) => ({
		type: "message",
		timestamp: new Date(completedAt).toISOString(),
		message: {
			role: "assistant",
			model: "claude-opus-5",
			ttft,
			duration,
			completedAt,
			content: blocks,
			timestamp: completedAt - ttft - duration,
		},
	});
	const toolCall = (id: string, name: string, args: Record<string, unknown> = {}) => ({
		type: "toolCall",
		id,
		name,
		arguments: args,
	});
	const toolStart = (toolCallId: string, toolName: string, startedAt: number) => ({
		type: "custom",
		customType: "tool_execution_start",
		timestamp: new Date(startedAt).toISOString(),
		data: { toolCallId, toolName, startedAt },
	});
	const toolResult = (toolCallId: string, toolName: string, at: number) => ({
		type: "message",
		timestamp: new Date(at).toISOString(),
		message: {
			role: "toolResult",
			toolName,
			toolCallId,
			isError: false,
			content: [],
			timestamp: at,
		},
	});

	return [
		session,
		human("do x", 0),
		assistant(4000, 6000, 10_000, [
			toolCall("bash-1", "bash", { command: "echo hi" }),
			toolCall("task-1", "task"),
			toolCall("ask-1", "ask"),
		]),
		toolStart("bash-1", "bash", 10_000),
		toolStart("task-1", "task", 20_000),
		toolResult("bash-1", "bash", 40_000),
		toolResult("task-1", "task", 140_000),
		toolStart("ask-1", "ask", 140_000),
		toolResult("ask-1", "ask", 200_000),
		human("ok thanks", 1_400_000),
	];
}

test("extractTimeSplit: overlap priority (agents > tools) and gap capping (you/idle)", () => {
	const split = extractTimeSplit(buildFixture(), "sess-1", "/Users/me/projects/webapp");

	assert.equal(split.buckets.model, 10);
	assert.equal(split.buckets.tools, 10);
	assert.equal(split.buckets.agents, 120);
	assert.equal(split.buckets.ci, 0);
	assert.equal(split.buckets.you, 60 + 900);
	assert.equal(split.buckets.idle, 300);

	const sum = Object.values(split.buckets).reduce((a, b) => a + b, 0);
	assert.equal(sum, 1400); // partition sums to the elapsed range (t=0 to t=1,400,000)

	assert.equal(split.active_sec, sum - split.buckets.idle);
});

test("extractTimeSplit: busy_by_tool sums both overlapping calls in full, uncapped by priority", () => {
	const split = extractTimeSplit(buildFixture(), "sess-1", "/Users/me/projects/webapp");

	assert.equal(split.busy_by_tool.bash, 30);
	assert.equal(split.busy_by_tool.task, 120);
	assert.equal(split.busy_by_tool.ask, 60);
});

test("extractTimeSplit: busy_by_command excludes ask/wait/task and ci/agents waits (not real tool work)", () => {
	const split = extractTimeSplit(buildFixture(), "sess-1", "/Users/me/projects/webapp");

	assert.equal(split.busy_by_command.ask, undefined);
	assert.equal(split.busy_by_command.task, undefined);
	assert.equal(split.busy_by_command.wait, undefined);
	assert.equal(split.busy_by_command["echo hi"], 30);
});

test("extractTimeSplit: subagent_busy_sec defaults to 0 (filled in later by the stats integration)", () => {
	const split = extractTimeSplit(buildFixture(), "sess-1", "/Users/me/projects/webapp");
	assert.equal(split.subagent_busy_sec, 0);
});

test("extractTimeSplit: idleCapSec parameter overrides the default cap", () => {
	const split = extractTimeSplit(buildFixture(), "sess-1", "/Users/me/projects/webapp", 60);
	// Residual gap is still 1200s; capped at 60s this time.
	assert.equal(split.buckets.you, 60 + 60);
	assert.equal(split.buckets.idle, 1200 - 60);
});

test("extractTimeSplit: you_gaps sums to buckets.you and elsewhere is 0", () => {
	const split = extractTimeSplit(buildFixture(), "sess-1", "/Users/me/projects/webapp");
	assert.equal(split.buckets.elsewhere, 0);
	const total = split.you_gaps.reduce((acc, [s, e]) => acc + (e - s) / 1000, 0);
	assert.equal(total, split.buckets.you);
	assert.equal(split.buckets.you, 60 + 900);
	for (const [s, e] of split.you_gaps) {
		assert.ok(s >= 0 && e <= 1_400_000, `interval [${s}, ${e}] outside session range`);
	}
});

test("extractTimeSplit: slowest_requests has one entry spanning the whole session", () => {
	const split = extractTimeSplit(buildFixture(), "sess-1", "/Users/me/projects/webapp");
	assert.equal(split.slowest_requests.length, 1);
	const req = split.slowest_requests[0]!;
	assert.equal(req.session_id, "sess-1");
	assert.equal(req.project, "/Users/me/projects/webapp");
	assert.equal(req.prompt, "do x");
	assert.equal(req.wall_sec, 1400);
	assert.equal(req.active_sec, 1400 - 300);
	assert.equal(req.dominant_bucket, "you");
});

// Two requests: A has a short burst of tool work (5min) followed by a 2h
// gap before the next human message (mostly idle); B is a solid 30min of
// tool work with no trailing gap. A's wall_sec is far larger than B's, but
// B's active_sec (wall_sec minus idle) is larger, so B should rank first.
function buildActiveRankingFixture(): AnyEntry[] {
	const session = {
		type: "session",
		version: 3,
		id: "00000000-0000-7000-8000-000000000002",
		timestamp: new Date(0).toISOString(),
		cwd: "/Users/me/projects/webapp",
	};
	const human = (text: string, at: number) => ({
		type: "message",
		timestamp: new Date(at).toISOString(),
		message: { role: "user", attribution: "user", content: [{ type: "text", text }], timestamp: at },
	});
	const assistant = (completedAt: number, blocks: unknown[]) => ({
		type: "message",
		timestamp: new Date(completedAt).toISOString(),
		message: {
			role: "assistant",
			model: "claude-opus-5",
			ttft: 0,
			duration: 0,
			completedAt,
			content: blocks,
			timestamp: completedAt,
		},
	});
	const toolCall = (id: string, name: string, args: Record<string, unknown> = {}) => ({
		type: "toolCall",
		id,
		name,
		arguments: args,
	});
	const toolStart = (toolCallId: string, toolName: string, startedAt: number) => ({
		type: "custom",
		customType: "tool_execution_start",
		timestamp: new Date(startedAt).toISOString(),
		data: { toolCallId, toolName, startedAt },
	});
	const toolResult = (toolCallId: string, toolName: string, at: number) => ({
		type: "message",
		timestamp: new Date(at).toISOString(),
		message: { role: "toolResult", toolName, toolCallId, isError: false, content: [], timestamp: at },
	});

	return [
		session,
		human("req A", 0),
		assistant(0, [toolCall("bash-a", "bash", { command: "echo a" })]),
		toolStart("bash-a", "bash", 0),
		toolResult("bash-a", "bash", 300_000), // 5min tool work
		human("req B", 7_500_000), // 2h gap after req A's tool work ends
		assistant(7_500_000, [toolCall("bash-b", "bash", { command: "echo b" })]),
		toolStart("bash-b", "bash", 7_500_000),
		toolResult("bash-b", "bash", 9_300_000), // 30min tool work, no trailing gap
	];
}

test("extractTimeSplit: slowest_requests ranks by active_sec, not wall_sec", () => {
	const split = extractTimeSplit(buildActiveRankingFixture(), "sess-2", "/Users/me/projects/webapp");

	assert.equal(split.slowest_requests.length, 2);
	const [first, second] = split.slowest_requests;
	assert.equal(first!.prompt, "req B");
	assert.equal(first!.wall_sec, 1800);
	assert.equal(first!.active_sec, 1800);
	assert.equal(second!.prompt, "req A");
	assert.equal(second!.wall_sec, 7500);
	assert.equal(second!.active_sec, 1200);
	assert.ok(first!.active_sec > second!.active_sec);
	assert.ok(first!.wall_sec < second!.wall_sec);
});

// A toolResult carrying the real "moved to background" notice text omp
// injects for a backgrounded bash/eval call, keyed to the SAME toolCallId
// as the triggering call: the provisional delivery, followed later by the
// real outcome as a follow-up toolResult for that id.
function toolResultText(toolCallId: string, toolName: string, at: number, text: string, isError = false) {
	return {
		type: "message",
		timestamp: new Date(at).toISOString(),
		message: { role: "toolResult", toolName, toolCallId, isError, content: [{ type: "text", text }] },
	};
}

function backgroundJobFixture(command: string): AnyEntry[] {
	const session = { type: "session", version: 3, id: "00000000-0000-7000-8000-000000000003", timestamp: new Date(0).toISOString(), cwd: "/Users/me/projects/webapp" };
	const human = (text: string, at: number) => ({
		type: "message",
		timestamp: new Date(at).toISOString(),
		message: { role: "user", attribution: "user", content: [{ type: "text", text }], timestamp: at },
	});
	const assistant = (completedAt: number, blocks: unknown[]) => ({
		type: "message",
		timestamp: new Date(completedAt).toISOString(),
		message: { role: "assistant", model: "claude-opus-5", ttft: 0, duration: 0, completedAt, content: blocks, timestamp: completedAt },
	});
	const toolCall = (id: string, name: string, args: Record<string, unknown> = {}) => ({ type: "toolCall", id, name, arguments: args });
	const toolStart = (toolCallId: string, toolName: string, startedAt: number) => ({
		type: "custom",
		customType: "tool_execution_start",
		timestamp: new Date(startedAt).toISOString(),
		data: { toolCallId, toolName, startedAt },
	});

	return [
		session,
		human("run it", 0),
		assistant(0, [toolCall("bg-1", "bash", { command })]),
		toolStart("bg-1", "bash", 0),
		// Provisional: returns almost immediately, before the real work finishes.
		toolResultText(
			"bg-1",
			"bash",
			20_000,
			"Backgrounded as job bg_1 (killed once it has run 600s in total; `timeout: 0` disables the deadline); its output is injected into the conversation as a follow-up the moment it finishes. Do NOT poll for it.",
		),
		// Follow-up: the real outcome, delivered once the job actually finishes.
		toolResultText("bg-1", "bash", 600_000, "done"),
		human("ok thanks", 650_000),
	];
}

test("extractTimeSplit: a backgrounded call's full duration (start to the real follow-up) is counted once, not just the provisional slice", () => {
	const split = extractTimeSplit(backgroundJobFixture("node build.js"), "sess-3", "/Users/me/projects/webapp");

	// Not 20 (the provisional delivery's duration) and not 620 (20 + 600,
	// double-counted): the full 600s start-to-finish span, counted once.
	assert.equal(split.busy_by_tool.bash, 600);
	assert.equal(split.busy_by_command["node build.js"], 600);
	assert.equal(split.buckets.tools, 600);
});

test("extractTimeSplit: a CI-polling call that gets backgrounded stays classified as CI for its whole lifetime", () => {
	const split = extractTimeSplit(backgroundJobFixture("glab ci status --wait"), "sess-4", "/Users/me/projects/webapp");

	assert.equal(split.buckets.ci, 600);
	assert.equal(split.buckets.tools, 0);
	assert.equal(split.busy_by_tool.bash, 600);
	// CI waits are excluded from busy_by_command (see the "Why gate on tools" note).
	assert.deepEqual(split.busy_by_command, {});
});

test("extractTimeSplit: an assistant-only sidecar (no human message) picks rangeStart from the first real timestamp, not epoch 0", () => {
	const base = 1_700_000_000_000; // a real wall-clock instant, not near 0
	const session = { type: "session", version: 3, id: "00000000-0000-7000-8000-000000000004", timestamp: new Date(base).toISOString(), cwd: "/Users/me/projects/webapp" };
	const assistant = (ttft: number, duration: number, completedAt: number) => ({
		type: "message",
		timestamp: new Date(completedAt).toISOString(),
		message: { role: "assistant", model: "claude-opus-5", ttft, duration, completedAt, content: [], timestamp: completedAt - ttft - duration },
	});

	const split = extractTimeSplit(
		[session, assistant(2000, 3000, base + 5000), assistant(1000, 4000, base + 20_000)],
		"sidecar-1",
		"/Users/me/projects/webapp",
	);

	// rangeStart=base (not 0): the ~54-year gap from epoch to base never
	// enters the split, so the model busy time isn't drowned by a bogus idle.
	assert.equal(split.buckets.model, 10);
	assert.equal(split.buckets.idle, 0);
	assert.equal(split.active_sec, 20);
});

test("IDLE_CAP_SEC is 900 (15 minutes)", () => {
	assert.equal(IDLE_CAP_SEC, 900);
});

// ── extractTimeSplit: review bucket ────────────────────────────────────────

function buildWaitFixture(toolName: string, args: Record<string, unknown>, resultText: string): AnyEntry[] {
	const session = {
		type: "session",
		version: 3,
		id: "00000000-0000-7000-8000-000000000005",
		timestamp: new Date(0).toISOString(),
		cwd: "/Users/me/projects/webapp",
	};
	const human = (text: string, at: number) => ({
		type: "message",
		timestamp: new Date(at).toISOString(),
		message: { role: "user", attribution: "user", content: [{ type: "text", text }], timestamp: at },
	});
	const assistant = (completedAt: number, blocks: unknown[]) => ({
		type: "message",
		timestamp: new Date(completedAt).toISOString(),
		message: { role: "assistant", model: "claude-opus-5", ttft: 0, duration: 0, completedAt, content: blocks, timestamp: completedAt },
	});
	const toolCall = (id: string, name: string, a: Record<string, unknown> = {}) => ({ type: "toolCall", id, name, arguments: a });
	const toolStart = (toolCallId: string, toolName_: string, startedAt: number) => ({
		type: "custom",
		customType: "tool_execution_start",
		timestamp: new Date(startedAt).toISOString(),
		data: { toolCallId, toolName: toolName_, startedAt },
	});
	const toolResult = (toolCallId: string, toolName_: string, at: number, text: string) => ({
		type: "message",
		timestamp: new Date(at).toISOString(),
		message: { role: "toolResult", toolName: toolName_, toolCallId, isError: false, content: [{ type: "text", text }], timestamp: at },
	});

	return [
		session,
		human("check on it", 0),
		assistant(0, [toolCall("call-1", toolName, args)]),
		toolStart("call-1", toolName, 0),
		toolResult("call-1", toolName, 60_000, resultText),
	];
}

test("extractTimeSplit: a wait whose result names a reviewer task-result is the review bucket", () => {
	const resultText = '<task-result id="ReviewMR188" agent="reviewer" status="completed">LGTM</task-result>';
	const split = extractTimeSplit(buildWaitFixture("wait", {}, resultText), "sess-r1", "/Users/me/projects/webapp");
	assert.equal(split.buckets.review, 60);
	assert.equal(split.buckets.agents, 0);
});

test("extractTimeSplit: a wait returning a scout and a reviewer together is the review bucket", () => {
	const resultText =
		'<task-result id="Scout1" agent="scout" status="completed">ok</task-result>\n' +
		'<task-result id="ReviewMR188" agent="reviewer" status="completed">LGTM</task-result>';
	const split = extractTimeSplit(buildWaitFixture("wait", {}, resultText), "sess-r2", "/Users/me/projects/webapp");
	assert.equal(split.buckets.review, 60);
	assert.equal(split.buckets.agents, 0);
});

test("extractTimeSplit: a wait returning only a scout is the agents bucket", () => {
	const resultText = '<task-result id="Scout1" agent="scout" status="completed">ok</task-result>';
	const split = extractTimeSplit(buildWaitFixture("wait", {}, resultText), "sess-r3", "/Users/me/projects/webapp");
	assert.equal(split.buckets.agents, 60);
	assert.equal(split.buckets.review, 0);
});

test("extractTimeSplit: a task call with arguments.tasks[].agent = reviewer is the review bucket", () => {
	const args = { tasks: [{ agent: "scout" }, { agent: "reviewer" }] };
	const split = extractTimeSplit(buildWaitFixture("task", args, ""), "sess-r4", "/Users/me/projects/webapp");
	assert.equal(split.buckets.review, 60);
	assert.equal(split.buckets.agents, 0);
});

test("extractTimeSplit: a task call with arguments.agent = security-reviewer is the review bucket", () => {
	const args = { agent: "security-reviewer" };
	const split = extractTimeSplit(buildWaitFixture("task", args, ""), "sess-r5", "/Users/me/projects/webapp");
	assert.equal(split.buckets.review, 60);
	assert.equal(split.buckets.agents, 0);
});

test("extractTimeSplit: a task call with no reviewer agent is the agents bucket", () => {
	const args = { tasks: [{ agent: "scout" }] };
	const split = extractTimeSplit(buildWaitFixture("task", args, ""), "sess-r6", "/Users/me/projects/webapp");
	assert.equal(split.buckets.agents, 60);
	assert.equal(split.buckets.review, 0);
});

function buildOverlapFixture(firstCall: { toolName: string; args: Record<string, unknown>; startedAt: number; resultAt: number; resultText: string }, secondCall: { toolName: string; args: Record<string, unknown>; startedAt: number; resultAt: number; resultText: string }): AnyEntry[] {
	const session = {
		type: "session",
		version: 3,
		id: "00000000-0000-7000-8000-000000000006",
		timestamp: new Date(0).toISOString(),
		cwd: "/Users/me/projects/webapp",
	};
	const human = (text: string, at: number) => ({
		type: "message",
		timestamp: new Date(at).toISOString(),
		message: { role: "user", attribution: "user", content: [{ type: "text", text }], timestamp: at },
	});
	const assistant = (completedAt: number, blocks: unknown[]) => ({
		type: "message",
		timestamp: new Date(completedAt).toISOString(),
		message: { role: "assistant", model: "claude-opus-5", ttft: 0, duration: 0, completedAt, content: blocks, timestamp: completedAt },
	});
	const toolCall = (id: string, name: string, a: Record<string, unknown> = {}) => ({ type: "toolCall", id, name, arguments: a });
	const toolStart = (toolCallId: string, toolName_: string, startedAt: number) => ({
		type: "custom",
		customType: "tool_execution_start",
		timestamp: new Date(startedAt).toISOString(),
		data: { toolCallId, toolName: toolName_, startedAt },
	});
	const toolResult = (toolCallId: string, toolName_: string, at: number, text: string) => ({
		type: "message",
		timestamp: new Date(at).toISOString(),
		message: { role: "toolResult", toolName: toolName_, toolCallId, isError: false, content: [{ type: "text", text }], timestamp: at },
	});

	return [
		session,
		human("do it", 0),
		assistant(0, [toolCall("call-a", firstCall.toolName, firstCall.args), toolCall("call-b", secondCall.toolName, secondCall.args)]),
		toolStart("call-a", firstCall.toolName, firstCall.startedAt),
		toolStart("call-b", secondCall.toolName, secondCall.startedAt),
		toolResult("call-a", firstCall.toolName, firstCall.resultAt, firstCall.resultText),
		toolResult("call-b", secondCall.toolName, secondCall.resultAt, secondCall.resultText),
	];
}

test("extractTimeSplit: review overlapping an agents interval wins", () => {
	// agents [0, 40000], review [10000, 30000] (fully inside): the 20s
	// overlap counts as review, leaving 10s + 10s = 20s of agents.
	const entries = buildOverlapFixture(
		{ toolName: "task", args: { tasks: [{ agent: "scout" }] }, startedAt: 0, resultAt: 40_000, resultText: "" },
		{
			toolName: "wait",
			args: {},
			startedAt: 10_000,
			resultAt: 30_000,
			resultText: '<task-result id="ReviewMR188" agent="reviewer" status="completed">LGTM</task-result>',
		},
	);
	const split = extractTimeSplit(entries, "sess-r7", "/Users/me/projects/webapp");
	assert.equal(split.buckets.review, 20);
	assert.equal(split.buckets.agents, 20);
});

test("extractTimeSplit: ci overlapping review wins", () => {
	// review [0, 40000], ci [10000, 30000] (fully inside): the 20s overlap
	// counts as ci, leaving 10s + 10s = 20s of review.
	const entries = buildOverlapFixture(
		{
			toolName: "wait",
			args: {},
			startedAt: 0,
			resultAt: 40_000,
			resultText: '<task-result id="ReviewMR188" agent="reviewer" status="completed">LGTM</task-result>',
		},
		{ toolName: "bash", args: { command: "glab ci status --wait" }, startedAt: 10_000, resultAt: 30_000, resultText: "" },
	);
	const split = extractTimeSplit(entries, "sess-r8", "/Users/me/projects/webapp");
	assert.equal(split.buckets.ci, 20);
	assert.equal(split.buckets.review, 20);
});
