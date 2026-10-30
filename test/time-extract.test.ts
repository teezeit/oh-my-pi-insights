// SPDX-FileCopyrightText: 2026 Hari Srinivasan <harisrini21@gmail.com>
// SPDX-FileCopyrightText: 2026 Tobias Hoelzer (omp port)
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { test } from "node:test";
import { IDLE_CAP_SEC, classifyWait, commandFamily, extractTimeSplit, textNamesReview } from "../src/time.ts";
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

test("classifyWait: a poll helper labeled with 'preview' deploy wording is a CI wait, not review (substring 'review' in 'preview' doesn't count)", () => {
	assert.equal(classifyWait("eval", 'poll3(action="Waiting for preview deploy")'), "ci");
});

// ── classifyWait: built-in CI/CD recognition (zero configuration) ──────────

test("classifyWait: jenkins-cli build with a wait flag is a CI wait", () => {
	assert.equal(classifyWait("bash", "jenkins-cli -s http://jenkins:8080 build my-job -w"), "ci");
});

test("classifyWait: java -jar jenkins-cli.jar build is a CI wait", () => {
	assert.equal(classifyWait("bash", "java -jar jenkins-cli.jar -s http://jenkins:8080/ build my-job"), "ci");
});

test("classifyWait: curl polling a Jenkins job's lastBuild api/json is a CI wait", () => {
	assert.equal(classifyWait("bash", "curl -s http://jenkins/job/my-job/lastBuild/api/json"), "ci");
});

test("classifyWait: circleci CLI workflow command is a CI wait", () => {
	assert.equal(classifyWait("bash", "circleci workflow show --pipeline-id abc123"), "ci");
});

test("classifyWait: curl to circleci.com/api/v2/pipeline is a CI wait", () => {
	assert.equal(classifyWait("bash", "curl https://circleci.com/api/v2/pipeline/abc123"), "ci");
});

test("classifyWait: bk build watch is a CI wait", () => {
	assert.equal(classifyWait("bash", "bk build watch 123"), "ci");
});

test("classifyWait: curl to api.buildkite.com builds endpoint is a CI wait", () => {
	assert.equal(classifyWait("bash", "curl https://api.buildkite.com/v2/orgs/x/pipelines/y/builds/123"), "ci");
});

test("classifyWait: az pipelines run is a CI wait", () => {
	assert.equal(classifyWait("bash", "az pipelines run --name my-pipeline"), "ci");
});

test("classifyWait: az build show is a CI wait", () => {
	assert.equal(classifyWait("bash", "az build show --id 42"), "ci");
});

test("classifyWait: gh workflow run followed by gh run watch is a CI wait", () => {
	assert.equal(classifyWait("bash", "gh workflow run deploy.yml && gh run watch"), "ci");
});

test("classifyWait: kubectl rollout status is a CI wait", () => {
	assert.equal(classifyWait("bash", "kubectl rollout status deployment/web"), "ci");
});

test("classifyWait: argocd app wait is a CI wait", () => {
	assert.equal(classifyWait("bash", "argocd app wait my-app"), "ci");
});

test("classifyWait: argocd app sync --wait is a CI wait", () => {
	assert.equal(classifyWait("bash", "argocd app sync my-app --wait"), "ci");
});

test("classifyWait: helm upgrade --wait is a CI wait", () => {
	assert.equal(classifyWait("bash", "helm upgrade my-app ./chart --wait"), "ci");
});

test("classifyWait: netlify watch is a CI wait", () => {
	assert.equal(classifyWait("bash", "netlify watch"), "ci");
});

test("classifyWait: fly status --watch is a CI wait", () => {
	assert.equal(classifyWait("bash", "fly status --watch"), "ci");
});

test("classifyWait: flyctl status --watch is a CI wait", () => {
	assert.equal(classifyWait("bash", "flyctl status --watch"), "ci");
});

test("classifyWait: gcloud builds submit (synchronous) is a CI wait", () => {
	assert.equal(classifyWait("bash", "gcloud builds submit --tag gcr.io/proj/img ."), "ci");
});

test("classifyWait: gcloud builds log --stream is a CI wait", () => {
	assert.equal(classifyWait("bash", "gcloud builds log abc123 --stream"), "ci");
});

test("classifyWait: aws codebuild batch-get-builds is a CI wait", () => {
	assert.equal(classifyWait("bash", "aws codebuild batch-get-builds --ids abc123"), "ci");
});

test("classifyWait: aws codepipeline get-pipeline-state is a CI wait", () => {
	assert.equal(classifyWait("bash", "aws codepipeline get-pipeline-state --name my-pipeline"), "ci");
});

test("classifyWait: a CI/CD wait command inside a bash polling loop is still a CI wait, and commandFamily labels it 'polling: ci'", () => {
	const text = 'for i in $(seq 1 30); do kubectl rollout status deployment/web; sleep 20; done';
	assert.equal(classifyWait("bash", text), "ci");
	assert.equal(commandFamily("bash", text), "polling: ci");
});

test("classifyWait: built-in CI/CD commands are NOT CI waits without the waiting flag/shape", () => {
	assert.equal(classifyWait("bash", "fly deploy"), null);
	assert.equal(classifyWait("bash", "kubectl apply -f x.yaml"), null);
	assert.equal(classifyWait("bash", "helm upgrade my-app ./chart"), null);
	assert.equal(classifyWait("bash", "gcloud builds submit --async --tag gcr.io/proj/img ."), null);
	assert.equal(classifyWait("bash", "echo pipeline"), null);
	assert.equal(classifyWait("eval", "const pipeline = [];"), null);
});

// ── textNamesReview: whole-token matching, not substring ───────────────────

test("textNamesReview: matches whole-word and camelCase/digit-boundary review tokens", () => {
	assert.equal(textNamesReview("ReviewMR188"), true);
	assert.equal(textNamesReview("Review498AccessModule"), true);
	assert.equal(textNamesReview("MiaFullReview"), true);
	assert.equal(textNamesReview("jar-review-brief.md"), true);
	assert.equal(textNamesReview("reviewer verdict"), true);
	assert.equal(textNamesReview("security-reviewer"), true);
});

test("textNamesReview: does not match 'preview'/'ModelPreview' (substring, not a whole token)", () => {
	assert.equal(textNamesReview("ModelPreview"), false);
	assert.equal(textNamesReview("preview-bot"), false);
	assert.equal(textNamesReview("Waiting for preview deploy"), false);
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

// ── extractTimeSplit: background jobs (async-result) ───────────────────────

function asyncResult(at: number, jobs: Array<{ jobId: string; type: "task" | "bash"; label: string; durationMs: number }>) {
	return {
		type: "custom_message",
		customType: "async-result",
		id: `async-${at}`,
		timestamp: new Date(at).toISOString(),
		attribution: "agent",
		content: "<system-notice>Background job has completed</system-notice>",
		details: { jobs: jobs.map((j) => ({ jobId: j.jobId, type: j.type, status: "completed", agentId: j.jobId, label: j.label, durationMs: j.durationMs })) },
	};
}

function bgSession(id: string) {
	return { type: "session", version: 3, id, timestamp: new Date(0).toISOString(), cwd: "/Users/me/projects/webapp" };
}
const bgHuman = (text: string, at: number) => ({
	type: "message",
	timestamp: new Date(at).toISOString(),
	message: { role: "user", attribution: "user", content: [{ type: "text", text }], timestamp: at },
});
const bgAssistant = (ttft: number, duration: number, completedAt: number, blocks: unknown[]) => ({
	type: "message",
	timestamp: new Date(completedAt).toISOString(),
	message: { role: "assistant", model: "claude-opus-5", ttft, duration, completedAt, content: blocks, timestamp: completedAt - ttft - duration },
});
const bgToolCall = (id: string, name: string, args: Record<string, unknown> = {}) => ({ type: "toolCall", id, name, arguments: args });
const bgToolStart = (toolCallId: string, toolName: string, startedAt: number) => ({
	type: "custom",
	customType: "tool_execution_start",
	timestamp: new Date(startedAt).toISOString(),
	data: { toolCallId, toolName, startedAt },
});
const bgToolResult = (toolCallId: string, toolName: string, at: number, text: string) => ({
	type: "message",
	timestamp: new Date(at).toISOString(),
	message: { role: "toolResult", toolName, toolCallId, isError: false, content: [{ type: "text", text }], timestamp: at },
});

test("extractTimeSplit: a background task job (agent=reviewer) fills the review bucket, not you/idle", () => {
	// task spawned at t=0, parent turn ends at t=12s (model covers [0, 12000]);
	// async-result at t=40min, durationMs=40min -> span [0, 2_400_000], fully
	// swallowing the model interval. Next human message at t=41min.
	const entries: AnyEntry[] = [
		bgSession("00000000-0000-7000-8000-000000000007"),
		bgHuman("review this", 0),
		bgAssistant(2_000, 10_000, 12_000, [bgToolCall("task-1", "task", { tasks: [{ name: "ReviewMR9", agent: "reviewer" }] })]),
		asyncResult(2_400_000, [{ jobId: "ReviewMR9", type: "task", label: "ReviewMR9", durationMs: 2_400_000 }]),
		bgHuman("thanks", 2_460_000),
	];
	const split = extractTimeSplit(entries, "sess-bg1", "/Users/me/projects/webapp");
	assert.equal(split.buckets.model, 12);
	assert.equal(split.buckets.review, 2388);
	assert.equal(split.buckets.you, 60);
	assert.equal(split.buckets.idle, 0);
});

test("extractTimeSplit: a background task job with a non-review agent fills the agents bucket", () => {
	const entries: AnyEntry[] = [
		bgSession("00000000-0000-7000-8000-000000000008"),
		bgHuman("look into this", 0),
		bgAssistant(2_000, 10_000, 12_000, [bgToolCall("task-1", "task", { tasks: [{ name: "LaneC1", agent: "scout" }] })]),
		asyncResult(2_400_000, [{ jobId: "LaneC1", type: "task", label: "LaneC1", durationMs: 2_400_000 }]),
		bgHuman("thanks", 2_460_000),
	];
	const split = extractTimeSplit(entries, "sess-bg2", "/Users/me/projects/webapp");
	assert.equal(split.buckets.agents, 2388);
	assert.equal(split.buckets.review, 0);
	assert.equal(split.buckets.you, 60);
});

test("extractTimeSplit: a background span overlapping real model/tools work never overrides it", () => {
	const entries: AnyEntry[] = [
		bgSession("00000000-0000-7000-8000-000000000009"),
		bgHuman("start", 0),
		bgAssistant(0, 5_000, 5_000, [bgToolCall("bash-1", "bash", { command: "npm test" }), bgToolCall("task-1", "task", { tasks: [{ name: "ReviewMR1", agent: "reviewer" }] })]),
		bgToolStart("bash-1", "bash", 5_000),
		bgToolResult("bash-1", "bash", 15_000, "ok"),
		asyncResult(20_000, [{ jobId: "ReviewMR1", type: "task", label: "ReviewMR1", durationMs: 20_000 }]),
		bgHuman("thanks", 25_000),
	];
	const split = extractTimeSplit(entries, "sess-bg3", "/Users/me/projects/webapp");
	assert.equal(split.buckets.model, 5);
	assert.equal(split.buckets.tools, 10);
	assert.equal(split.buckets.review, 5);
	assert.equal(split.buckets.you, 5);
	assert.equal(split.buckets.idle, 0);
});

test("extractTimeSplit: a backgrounded bash job (CI loop) replaces the provisional slice once, in both buckets.ci and busy_by_tool.bash", () => {
	const command = 'for i in $(seq 1 40); do glab api "projects/x/pipelines?ref=main"; sleep 30; done';
	const entries: AnyEntry[] = [
		bgSession("00000000-0000-7000-8000-000000000010"),
		bgHuman("watch ci", 0),
		bgAssistant(0, 0, 0, [bgToolCall("bash-1", "bash", { command })]),
		bgToolStart("bash-1", "bash", 0),
		bgToolResult("bash-1", "bash", 5_000, "Backgrounded as job bg_1 (killed once it has run 600s in total); its output is injected later. Do NOT poll for it."),
		asyncResult(1_205_000, [{ jobId: "bg_1", type: "bash", label: command.slice(0, 40), durationMs: 1_200_000 }]),
		bgHuman("thanks", 1_210_000),
	];
	const split = extractTimeSplit(entries, "sess-bg4", "/Users/me/projects/webapp");
	assert.equal(split.buckets.ci, 1200);
	assert.equal(split.buckets.tools, 0);
	assert.equal(split.busy_by_tool.bash, 1200);
	assert.deepEqual(split.busy_by_command, {});
	assert.equal(split.buckets.you, 10);
	assert.equal(split.buckets.idle, 0);
});

test("extractTimeSplit: an async-result task job whose spawn call is missing falls back to job id/label matching (review)", () => {
	const entries: AnyEntry[] = [
		bgSession("00000000-0000-7000-8000-000000000011"),
		bgHuman("do it", 0),
		bgAssistant(0, 1_000, 1_000, []),
		asyncResult(61_000, [{ jobId: "ReviewMR7", type: "task", label: "ReviewMR7", durationMs: 60_000 }]),
		bgHuman("thanks", 65_000),
	];
	const split = extractTimeSplit(entries, "sess-bg5", "/Users/me/projects/webapp");
	assert.equal(split.buckets.review, 60);
	assert.equal(split.buckets.agents, 0);
});

test("extractTimeSplit: an async-result task job whose spawn call is missing falls back to job id/label matching (agents)", () => {
	const entries: AnyEntry[] = [
		bgSession("00000000-0000-7000-8000-000000000012"),
		bgHuman("do it", 0),
		bgAssistant(0, 1_000, 1_000, []),
		asyncResult(61_000, [{ jobId: "LaneC1", type: "task", label: "LaneC1", durationMs: 60_000 }]),
		bgHuman("thanks", 65_000),
	];
	const split = extractTimeSplit(entries, "sess-bg6", "/Users/me/projects/webapp");
	assert.equal(split.buckets.agents, 60);
	assert.equal(split.buckets.review, 0);
});

test("extractTimeSplit: an async-result task job with agent type 'ModelPreview' is agents, not review (substring 'review' in 'Preview' doesn't count)", () => {
	const entries: AnyEntry[] = [
		bgSession("00000000-0000-7000-8000-000000000013"),
		bgHuman("try the new model", 0),
		bgAssistant(0, 1_000, 1_000, [bgToolCall("task-1", "task", { tasks: [{ name: "Preview1", agent: "ModelPreview" }] })]),
		asyncResult(61_000, [{ jobId: "Preview1", type: "task", label: "Preview1", durationMs: 60_000 }]),
		bgHuman("thanks", 65_000),
	];
	const split = extractTimeSplit(entries, "sess-bg13", "/Users/me/projects/webapp");
	assert.equal(split.buckets.agents, 60);
	assert.equal(split.buckets.review, 0);
});

// ── extractTimeSplit: review decided by agent type first (not job id) ──────

test("extractTimeSplit: a <task-result agent=\"task\"> whose id merely contains 'review' is NOT review (agent type decides, not the name)", () => {
	const resultText = '<task-result id="ReviewExtract" agent="task" status="completed">done</task-result>';
	const split = extractTimeSplit(buildWaitFixture("wait", {}, resultText), "sess-bg7", "/Users/me/projects/webapp");
	assert.equal(split.buckets.agents, 60);
	assert.equal(split.buckets.review, 0);
});

test("extractTimeSplit: a <task-result agent=\"reviewer\"> is review regardless of its id", () => {
	const resultText = '<task-result id="X" agent="reviewer" status="completed">LGTM</task-result>';
	const split = extractTimeSplit(buildWaitFixture("wait", {}, resultText), "sess-bg8", "/Users/me/projects/webapp");
	assert.equal(split.buckets.review, 60);
	assert.equal(split.buckets.agents, 0);
});

test("extractTimeSplit: a bash bg job's 'label: ...' line mentioning review (no task-result tag, no agent attribute) still falls back to review", () => {
	const resultText = "job bg_1 finished\nlabel: review gate check\n";
	const split = extractTimeSplit(buildWaitFixture("wait", {}, resultText), "sess-bg9", "/Users/me/projects/webapp");
	assert.equal(split.buckets.review, 60);
	assert.equal(split.buckets.agents, 0);
});
