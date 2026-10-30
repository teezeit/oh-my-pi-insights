// SPDX-FileCopyrightText: 2026 Tobias Hoelzer (omp port)
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { test } from "node:test";
import { aggregateTime, buildTimeLevers, type SessionMeta } from "../index.ts";
import { meta } from "./helpers.ts";

type TimeSplit = SessionMeta["time_split"];

function zeroSplit(overrides: Partial<TimeSplit> = {}): TimeSplit {
	return {
		buckets: { model: 0, tools: 0, agents: 0, ci: 0, you: 0, elsewhere: 0, idle: 0 },
		active_sec: 0,
		busy_by_tool: {},
		busy_by_command: {},
		subagent_busy_sec: 0,
		slowest_requests: [],
		you_gaps: [],
		...overrides,
	};
}

test("two sessions sum correctly; non-idle shares sum to 1; idle share formula", () => {
	const a = meta({
		session_id: "a",
		start_time: "2026-09-01T09:00:00.000Z",
		time_split: zeroSplit({
			buckets: { model: 100, tools: 200, agents: 50, ci: 0, you: 50, elsewhere: 0, idle: 100 },
			active_sec: 400,
		}),
	});
	const b = meta({
		session_id: "b",
		start_time: "2026-09-02T09:00:00.000Z",
		time_split: zeroSplit({
			buckets: { model: 50, tools: 100, agents: 0, ci: 0, you: 50, elsewhere: 0, idle: 0 },
			active_sec: 200,
		}),
	});

	const agg = aggregateTime([a, b]);

	assert.equal(agg.sessions, 2);
	assert.deepEqual(agg.buckets, { model: 150, tools: 300, agents: 50, ci: 0, you: 100, elsewhere: 0, idle: 100 });
	assert.equal(agg.active_sec, 600);

	const nonIdleSum =
		agg.shares.model + agg.shares.tools + agg.shares.agents + agg.shares.ci + agg.shares.you + agg.shares.elsewhere;
	assert.ok(Math.abs(nonIdleSum - 1) < 1e-9, `non-idle shares should sum to 1, got ${nonIdleSum}`);
	assert.ok(Math.abs(agg.shares.idle - 100 / 700) < 1e-9);
});

test("npm test at 40% of tools time triggers command_family lever naming it", () => {
	const m = meta({
		session_id: "cmd",
		time_split: zeroSplit({
			buckets: { model: 0, tools: 1000, agents: 0, ci: 0, you: 0, elsewhere: 0, idle: 0 },
			active_sec: 1000,
			busy_by_command: { "npm test": 400, "git push": 100 },
		}),
	});

	const agg = aggregateTime([m]);
	const lever = agg.levers.find((l) => l.id === "command_family");
	assert.ok(lever, "expected command_family lever");
	assert.match(lever!.title + lever!.detail, /npm test/);
	assert.deepEqual(lever!.evidence_sessions, ["cmd"]);
});

test("non-actionable eval family is skipped in favor of the next actionable family above threshold", () => {
	const m = meta({
		session_id: "actionable",
		time_split: zeroSplit({
			buckets: { model: 0, tools: 1000, agents: 0, ci: 0, you: 0, elsewhere: 0, idle: 0 },
			active_sec: 1000,
			busy_by_command: { eval: 600, "pnpm test": 300 },
		}),
	});

	const agg = aggregateTime([m]);
	const lever = agg.levers.find((l) => l.id === "command_family");
	assert.ok(lever, "expected command_family lever");
	assert.match(lever!.title + lever!.detail, /pnpm test/);
	assert.doesNotMatch(lever!.title, /`eval`/);
});

test("no actionable family above threshold yields no command_family lever", () => {
	const m = meta({
		session_id: "non-actionable",
		time_split: zeroSplit({
			buckets: { model: 0, tools: 1000, agents: 0, ci: 0, you: 0, elsewhere: 0, idle: 0 },
			active_sec: 1000,
			busy_by_command: { eval: 900, "pnpm test": 50 },
		}),
	});

	const agg = aggregateTime([m]);
	assert.ok(!agg.levers.some((l) => l.id === "command_family"), "command_family must not fire");
});

test("you-share above 30% triggers waiting_on_you; at 25% it does not", () => {
	const high = meta({
		session_id: "high",
		time_split: zeroSplit({
			buckets: { model: 65, tools: 0, agents: 0, ci: 0, you: 35, elsewhere: 0, idle: 0 },
			active_sec: 100,
		}),
	});
	const low = meta({
		session_id: "low",
		time_split: zeroSplit({
			buckets: { model: 75, tools: 0, agents: 0, ci: 0, you: 25, elsewhere: 0, idle: 0 },
			active_sec: 100,
		}),
	});

	assert.ok(aggregateTime([high]).levers.some((l) => l.id === "waiting_on_you"));
	assert.ok(!aggregateTime([low]).levers.some((l) => l.id === "waiting_on_you"));
});

test("slow_model fires for opus as the dominant largest-bucket model, not for haiku", () => {
	const opus = meta({
		session_id: "opus-sess",
		time_split: zeroSplit({
			buckets: { model: 80, tools: 10, agents: 0, ci: 0, you: 10, elsewhere: 0, idle: 0 },
			active_sec: 100,
		}),
		model_usage: {
			"claude-opus-5": { input_tokens: 1000, output_tokens: 1000, cost: 10, message_count: 5 },
			"claude-haiku-4-5": { input_tokens: 100, output_tokens: 100, cost: 0.1, message_count: 5 },
		},
	});
	const haiku = meta({
		session_id: "haiku-sess",
		time_split: zeroSplit({
			buckets: { model: 80, tools: 10, agents: 0, ci: 0, you: 10, elsewhere: 0, idle: 0 },
			active_sec: 100,
		}),
		model_usage: {
			"claude-haiku-4-5": { input_tokens: 1000, output_tokens: 1000, cost: 10, message_count: 5 },
		},
	});

	const opusAgg = aggregateTime([opus]);
	const opusLever = opusAgg.levers.find((l) => l.id === "slow_model");
	assert.ok(opusLever, "expected slow_model lever for opus");
	assert.match(opusLever!.title, /claude-opus-5/);

	assert.ok(!aggregateTime([haiku]).levers.some((l) => l.id === "slow_model"));
});

test("serial_agent_waits fires when subagents were not busy in parallel, not when they were", () => {
	const serial = meta({
		session_id: "serial",
		time_split: zeroSplit({
			buckets: { model: 50, tools: 0, agents: 30, ci: 0, you: 20, elsewhere: 0, idle: 0 },
			active_sec: 100,
			subagent_busy_sec: 10,
		}),
	});
	const parallel = meta({
		session_id: "parallel",
		time_split: zeroSplit({
			buckets: { model: 50, tools: 0, agents: 30, ci: 0, you: 20, elsewhere: 0, idle: 0 },
			active_sec: 100,
			subagent_busy_sec: 50,
		}),
	});

	assert.ok(aggregateTime([serial]).levers.some((l) => l.id === "serial_agent_waits"));
	assert.ok(!aggregateTime([parallel]).levers.some((l) => l.id === "serial_agent_waits"));
});

test("levers are ranked by share descending, with slowest_requests always last", () => {
	const m = meta({
		session_id: "multi",
		time_split: zeroSplit({
			buckets: { model: 400, tools: 40, agents: 210, ci: 0, you: 350, elsewhere: 0, idle: 0 },
			active_sec: 1000,
			busy_by_command: { "npm test": 36, other: 4 },
			subagent_busy_sec: 100,
			slowest_requests: [
				{
					session_id: "multi",
					project: "webapp",
					prompt: "fix the bug",
					wall_sec: 500,
					active_sec: 480,
					dominant_bucket: "model",
				},
			],
		}),
		model_usage: {
			"claude-opus-5": { input_tokens: 1000, output_tokens: 1000, cost: 10, message_count: 5 },
		},
	});

	const agg = aggregateTime([m]);
	const ids = agg.levers.map((l) => l.id);

	assert.deepEqual(ids, ["slow_model", "waiting_on_you", "serial_agent_waits", "command_family", "slowest_requests"]);

	const shares = agg.levers.slice(0, -1).map((l) => l.share ?? 0);
	for (let i = 1; i < shares.length; i++) assert.ok(shares[i - 1]! >= shares[i]!, "levers must be sorted by share desc");
	assert.equal(ids[ids.length - 1], "slowest_requests");
});

test("command_family lever never fires for a stray wait/ask/task key, and share is capped at 100% in text", () => {
	const strayWait = meta({
		session_id: "stray-wait",
		time_split: zeroSplit({
			buckets: { model: 0, tools: 100, agents: 0, ci: 0, you: 0, elsewhere: 0, idle: 0 },
			active_sec: 100,
			busy_by_command: { wait: 540000, ask: 180000 },
		}),
	});
	const strayAgg = aggregateTime([strayWait]);
	assert.ok(
		!strayAgg.levers.some((l) => l.id === "command_family"),
		"command_family must never fire for wait/ask/task keys",
	);

	const overshoot = meta({
		session_id: "overshoot",
		time_split: zeroSplit({
			buckets: { model: 0, tools: 100, agents: 0, ci: 0, you: 0, elsewhere: 0, idle: 0 },
			active_sec: 100,
			// Overlapping tool calls can make a family's busy time exceed the tools bucket;
			// the displayed share must still be capped at 100%.
			busy_by_command: { "npm test": 276 },
		}),
	});
	const overshootAgg = aggregateTime([overshoot]);
	const overshootLever = overshootAgg.levers.find((l) => l.id === "command_family");
	assert.ok(overshootLever, "expected command_family lever");
	assert.doesNotMatch(overshootLever!.title + overshootLever!.detail, /[2-9]\d\d%|1\d\d\d%/);
	assert.match(overshootLever!.title, /Speed up `npm test`/);
});

test("slowest_requests is ranked by active_sec across the corpus, and its detail reports active time", () => {
	const idleHeavy = meta({
		session_id: "idle-heavy",
		time_split: zeroSplit({
			buckets: { model: 10, tools: 0, agents: 0, ci: 0, you: 0, elsewhere: 0, idle: 0 },
			active_sec: 10,
			slowest_requests: [
				{
					session_id: "idle-heavy",
					project: "webapp",
					prompt: "long idle gap",
					wall_sec: 925200, // 257h, mostly idle
					active_sec: 600, // 10m actually active
					dominant_bucket: "idle",
				},
			],
		}),
	});
	const activeHeavy = meta({
		session_id: "active-heavy",
		time_split: zeroSplit({
			buckets: { model: 4200, tools: 0, agents: 0, ci: 0, you: 0, elsewhere: 0, idle: 0 },
			active_sec: 4200,
			slowest_requests: [
				{
					session_id: "active-heavy",
					project: "webapp",
					prompt: "long active request",
					wall_sec: 4200,
					active_sec: 4200, // 1h 10m active
					dominant_bucket: "model",
				},
			],
		}),
	});

	const agg = aggregateTime([idleHeavy, activeHeavy]);
	assert.equal(agg.slowest_requests[0]!.session_id, "active-heavy", "must rank by active_sec, not wall_sec");

	const lever = agg.levers.find((l) => l.id === "slowest_requests");
	assert.ok(lever, "expected slowest_requests lever");
	assert.match(lever!.detail, /active time/);
	assert.match(lever!.detail, /1h 10m/);
	assert.doesNotMatch(lever!.detail, /257h/);
});

test("waiting_on_you lever uses neutral, actionable wording", () => {
	const high = meta({
		session_id: "high",
		time_split: zeroSplit({
			buckets: { model: 65, tools: 0, agents: 0, ci: 0, you: 35, elsewhere: 0, idle: 0 },
			active_sec: 100,
		}),
	});
	const lever = aggregateTime([high]).levers.find((l) => l.id === "waiting_on_you");
	assert.ok(lever, "expected waiting_on_you lever");
	assert.doesNotMatch(lever!.title, /Reply faster/);
	assert.match(lever!.detail, /waited on your replies/);
});

test("empty metas produce zeros, no levers, and no NaN", () => {
	const agg = aggregateTime([]);

	assert.equal(agg.sessions, 0);
	assert.deepEqual(agg.date_range, { start: "", end: "" });
	assert.deepEqual(agg.buckets, { model: 0, tools: 0, agents: 0, ci: 0, you: 0, elsewhere: 0, idle: 0 });
	assert.equal(agg.active_sec, 0);
	assert.deepEqual(agg.slowest_requests, []);
	assert.deepEqual(agg.levers, []);

	for (const v of Object.values(agg.shares)) {
		assert.ok(!Number.isNaN(v), "share must not be NaN");
		assert.equal(v, 0);
	}
});

// Direct coverage of buildTimeLevers as its own export, not just through aggregateTime.
test("buildTimeLevers is callable directly against a precomputed aggregate", () => {
	const m = meta({
		session_id: "direct",
		time_split: zeroSplit({
			buckets: { model: 0, tools: 100, agents: 0, ci: 0, you: 0, elsewhere: 0, idle: 0 },
			active_sec: 100,
			busy_by_command: { "glab ci": 50 },
		}),
	});
	const agg = aggregateTime([m]);
	const { levers: _levers, ...withoutLevers } = agg;
	const levers = buildTimeLevers(withoutLevers, [m]);
	assert.ok(levers.some((l) => l.id === "command_family"));
});

test("cross-session elsewhere: a you_gap overlapping another session's human message moves to elsewhere", () => {
	const t = Date.parse("2026-09-01T09:00:00.000Z");
	const gapEnd = t + 10 * 60 * 1000;
	const a = meta({
		session_id: "A",
		time_split: zeroSplit({
			buckets: { model: 0, tools: 0, agents: 0, ci: 0, you: 600, elsewhere: 0, idle: 0 },
			active_sec: 600,
			you_gaps: [[t, gapEnd]],
		}),
	});
	const b = meta({
		session_id: "B",
		user_message_timestamps: [new Date(t + 5 * 60 * 1000).toISOString()],
	});

	const agg = aggregateTime([a, b]);
	assert.equal(agg.buckets.you, 0);
	assert.equal(agg.buckets.elsewhere, 600);
});

test("cross-session elsewhere: a human message outside the gap leaves it in you", () => {
	const t = Date.parse("2026-09-01T09:00:00.000Z");
	const gapEnd = t + 10 * 60 * 1000;
	const a = meta({
		session_id: "A",
		time_split: zeroSplit({
			buckets: { model: 0, tools: 0, agents: 0, ci: 0, you: 600, elsewhere: 0, idle: 0 },
			active_sec: 600,
			you_gaps: [[t, gapEnd]],
		}),
	});
	const b = meta({
		session_id: "B",
		user_message_timestamps: [new Date(t + 20 * 60 * 1000).toISOString()],
	});

	const agg = aggregateTime([a, b]);
	assert.equal(agg.buckets.you, 600);
	assert.equal(agg.buckets.elsewhere, 0);
});

test("cross-session elsewhere: a session's own messages never count", () => {
	const t = Date.parse("2026-09-01T09:00:00.000Z");
	const gapEnd = t + 10 * 60 * 1000;
	const a = meta({
		session_id: "A",
		time_split: zeroSplit({
			buckets: { model: 0, tools: 0, agents: 0, ci: 0, you: 600, elsewhere: 0, idle: 0 },
			active_sec: 600,
			you_gaps: [[t, gapEnd]],
		}),
		user_message_timestamps: [new Date(t + 5 * 60 * 1000).toISOString()],
	});

	const agg = aggregateTime([a]);
	assert.equal(agg.buckets.you, 600);
	assert.equal(agg.buckets.elsewhere, 0);
});

test("waiting_on_you lever disappears when most you-time becomes elsewhere", () => {
	const t = Date.parse("2026-09-01T09:00:00.000Z");
	const gapEnd = t + 40 * 1000;
	const a = meta({
		session_id: "A",
		time_split: zeroSplit({
			buckets: { model: 60, tools: 0, agents: 0, ci: 0, you: 40, elsewhere: 0, idle: 0 },
			active_sec: 100,
			you_gaps: [[t, gapEnd]],
		}),
	});
	assert.ok(aggregateTime([a]).levers.some((l) => l.id === "waiting_on_you"));

	const b = meta({
		session_id: "B",
		user_message_timestamps: [new Date(t + 20 * 1000).toISOString()],
	});
	assert.ok(!aggregateTime([a, b]).levers.some((l) => l.id === "waiting_on_you"));
});
