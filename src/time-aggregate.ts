// SPDX-FileCopyrightText: 2026 Tobias Hoelzer (omp port)
// SPDX-License-Identifier: AGPL-3.0-only


// Corpus-level time rollup (#18): sums per-session SessionTimeSplit values
// into one TimeAggregate, then derives up to 5 "levers" (command_family,
// waiting_on_you, slow_model, serial_agent_waits, slowest_requests) per the
// "Where did the time go" lever rules. Pure function over SessionMeta[],
// same style as aggregate.ts.

import type { SessionMeta, SlowRequest, TimeAggregate, TimeBucket, TimeLever } from "./types.ts";

const BUCKETS: TimeBucket[] = ["model", "tools", "agents", "ci", "you", "elsewhere", "idle"];
const ACTIVE_BUCKETS: TimeBucket[] = ["model", "tools", "agents", "ci", "you", "elsewhere"];

function zeroBuckets(): Record<TimeBucket, number> {
	return { model: 0, tools: 0, agents: 0, ci: 0, you: 0, elsewhere: 0, idle: 0 };
}

/**
 * True when some OTHER session has a human message strictly inside
 * [start, end): the user was active elsewhere during this session's gap, so
 * the gap counts as "elsewhere" rather than "you". `timestamps` must be
 * sorted ascending by `ts`; binary search finds the first candidate.
 */
function hasForeignMessageInGap(
	timestamps: Array<{ ts: number; sid: string }>,
	sessionId: string,
	start: number,
	end: number,
): boolean {
	let lo = 0;
	let hi = timestamps.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (timestamps[mid]!.ts < start) lo = mid + 1;
		else hi = mid;
	}
	for (let i = lo; i < timestamps.length; i++) {
		const t = timestamps[i]!;
		if (t.ts >= end) break;
		if (t.sid !== sessionId) return true;
	}
	return false;
}

/** Seconds -> "1h 23m". */
function formatHM(sec: number): string {
	const total = Math.max(0, Math.round(sec));
	const h = Math.floor(total / 3600);
	const m = Math.round((total % 3600) / 60);
	return `${h}h ${m}m`;
}

function pct(share: number): string {
	return `${Math.round(share * 100)}%`;
}

/** Up to n session ids ranked by a per-session contribution, highest first. */
function topSessions(contributions: Array<{ session_id: string; value: number }>, n = 3): string[] {
	return contributions
		.filter((c) => c.value > 0)
		.sort((a, b) => b.value - a.value)
		.slice(0, n)
		.map((c) => c.session_id);
}

export function aggregateTime(metas: SessionMeta[]): TimeAggregate {
	const buckets = zeroBuckets();
	const busy_by_tool: Record<string, number> = {};
	const busy_by_command: Record<string, number> = {};
	let subagent_busy_sec = 0;
	const slowest_requests: SlowRequest[] = [];
	let start = "";
	let end = "";

	// Cross-session "elsewhere" rule: a sorted index of every human message
	// timestamp, tagged by owning session, built once so each session's
	// you_gaps can be checked against it with a binary search rather than an
	// O(sessions) scan per gap.
	const allTimestamps: Array<{ ts: number; sid: string }> = [];
	for (const m of metas) {
		for (const iso of m.user_message_timestamps ?? []) {
			const ts = new Date(iso).getTime();
			if (!Number.isNaN(ts)) allTimestamps.push({ ts, sid: m.session_id });
		}
	}
	allTimestamps.sort((a, b) => a.ts - b.ts);

	for (const m of metas) {
		const split = m.time_split;
		for (const b of BUCKETS) buckets[b] += split?.buckets?.[b] ?? 0;
		for (const [tool, sec] of Object.entries(split?.busy_by_tool ?? {})) {
			busy_by_tool[tool] = (busy_by_tool[tool] ?? 0) + sec;
		}
		for (const [cmd, sec] of Object.entries(split?.busy_by_command ?? {})) {
			busy_by_command[cmd] = (busy_by_command[cmd] ?? 0) + sec;
		}
		subagent_busy_sec += split?.subagent_busy_sec ?? 0;
		for (const r of split?.slowest_requests ?? []) slowest_requests.push(r);
		if (m.start_time && (!start || m.start_time < start)) start = m.start_time;
		if (m.start_time && (!end || m.start_time > end)) end = m.start_time;

		// A you_gap moves from "you" to "elsewhere" when another session had
		// a human message inside it: the user was active, just not here.
		let elsewhereSec = 0;
		for (const [gapStart, gapEnd] of split?.you_gaps ?? []) {
			if (hasForeignMessageInGap(allTimestamps, m.session_id, gapStart, gapEnd)) {
				elsewhereSec += (gapEnd - gapStart) / 1000;
			}
		}
		elsewhereSec = Math.min(elsewhereSec, split?.buckets?.you ?? 0);
		buckets.you -= elsewhereSec;
		buckets.elsewhere += elsewhereSec;
	}

	const active_sec = ACTIVE_BUCKETS.reduce((sum, b) => sum + buckets[b], 0);
	const shares = zeroBuckets();
	for (const b of ACTIVE_BUCKETS) shares[b] = active_sec > 0 ? buckets[b] / active_sec : 0;
	const idleDenom = active_sec + buckets.idle;
	shares.idle = idleDenom > 0 ? buckets.idle / idleDenom : 0;

	slowest_requests.sort((a, b) => b.active_sec - a.active_sec);

	const partial: Omit<TimeAggregate, "levers"> = {
		sessions: metas.length,
		date_range: { start, end },
		buckets,
		active_sec,
		shares,
		busy_by_tool,
		busy_by_command,
		subagent_busy_sec,
		slowest_requests: slowest_requests.slice(0, 5),
	};

	return { ...partial, levers: buildTimeLevers(partial, metas) };
}

export function buildTimeLevers(agg: Omit<TimeAggregate, "levers">, metas: SessionMeta[]): TimeLever[] {
	const levers: TimeLever[] = [];

	// command_family: one bash/eval command family eating more than 20% of
	// the tools bucket (not active time: a tiny tools bucket dominated by one
	// command is still worth naming). busy_by_command must only hold real
	// commands; defensively drop wait/ask/task-style bucket names in case
	// upstream extraction ever leaks one in. Generic/non-actionable buckets
	// (bare "eval", "eval: python"/"eval: js", polling buckets, and bare
	// read-only tool names) are skipped in favor of the next actionable
	// family above the threshold; if none qualifies, no lever fires.
	const NON_COMMAND_KEYS: Record<string, true> = { wait: true, ask: true, task: true };
	const NON_ACTIONABLE_KEYS: Record<string, true> = {
		eval: true,
		"polling: generic": true,
		"polling: polling": true,
		read: true,
		grep: true,
		edit: true,
		write: true,
		glob: true,
		search: true,
		find: true,
		lsp: true,
	};
	const isActionableFamily = (family: string): boolean => {
		if (NON_COMMAND_KEYS[family]) return false;
		if (NON_ACTIONABLE_KEYS[family]) return false;
		if (family.startsWith("eval: python") || family.startsWith("eval: js")) return false;
		return true;
	};
	if (agg.buckets.tools > 0) {
		let topFamily = "";
		let topSec = 0;
		for (const [family, sec] of Object.entries(agg.busy_by_command)) {
			if (!isActionableFamily(family)) continue;
			if (sec > topSec) {
				topFamily = family;
				topSec = sec;
			}
		}
		if (topFamily && topSec / agg.buckets.tools > 0.2) {
			const toolShare = Math.min(1, topSec / agg.buckets.tools);
			const evidence_sessions = topSessions(
				metas.map((m) => ({ session_id: m.session_id, value: m.time_split?.busy_by_command?.[topFamily] ?? 0 })),
			);
			levers.push({
				id: "command_family",
				title: `Speed up \`${topFamily}\``,
				detail: `\`${topFamily}\` took ${formatHM(topSec)} (${pct(toolShare)} of tool time).`,
				share: agg.active_sec > 0 ? topSec / agg.active_sec : 0,
				evidence_sessions,
			});
		}
	}

	// waiting_on_you: more than 30% of active time is spent waiting on replies.
	if (agg.shares.you > 0.3) {
		const evidence_sessions = topSessions(metas.map((m) => ({ session_id: m.session_id, value: m.time_split?.buckets?.you ?? 0 })));
		levers.push({
			id: "waiting_on_you",
			title: "Batch decisions so agents wait less",
			detail: `Agents waited on your replies for ${formatHM(agg.buckets.you)} (${pct(agg.shares.you)} of active time).`,
			share: agg.shares.you,
			evidence_sessions,
		});
	}

	// slow_model: model is the largest active bucket and the dominant model
	// by cost is an opus/large-tier model.
	const largestBucket = ACTIVE_BUCKETS.reduce((best, b) => (agg.buckets[b] > agg.buckets[best] ? b : best), "model" as TimeBucket);
	if (largestBucket === "model" && agg.buckets.model > 0) {
		const costByModel = new Map<string, number>();
		for (const m of metas) {
			for (const [name, usage] of Object.entries(m.model_usage ?? {})) {
				costByModel.set(name, (costByModel.get(name) ?? 0) + usage.cost);
			}
		}
		let dominant = "";
		let dominantCost = -1;
		for (const [name, cost] of costByModel) {
			if (cost > dominantCost) {
				dominant = name;
				dominantCost = cost;
			}
		}
		if (dominant && /opus|large/i.test(dominant)) {
			const evidence_sessions = topSessions(metas.map((m) => ({ session_id: m.session_id, value: m.time_split?.buckets?.model ?? 0 })));
			levers.push({
				id: "slow_model",
				title: `Move work off ${dominant}`,
				detail: `${dominant} drove the largest time bucket (${formatHM(agg.buckets.model)}, ${pct(agg.shares.model)} of active time); try a smaller role for this work.`,
				share: agg.shares.model,
				evidence_sessions,
			});
		}
	}

	// serial_agent_waits: agent waits exceed 20% of active time but subagents
	// were not meaningfully busy in parallel, so the waits were serial.
	if (agg.shares.agents > 0.2 && agg.subagent_busy_sec < agg.buckets.agents * 1.2) {
		const evidence_sessions = topSessions(metas.map((m) => ({ session_id: m.session_id, value: m.time_split?.buckets?.agents ?? 0 })));
		levers.push({
			id: "serial_agent_waits",
			title: "Run subagents in parallel",
			detail: `Agent waits took ${formatHM(agg.buckets.agents)} (${pct(agg.shares.agents)} of active time) while subagents were only busy ${formatHM(agg.subagent_busy_sec)}, suggesting serial waits.`,
			share: agg.shares.agents,
			evidence_sessions,
		});
	}

	levers.sort((a, b) => (b.share ?? 0) - (a.share ?? 0));

	// slowest_requests: always last when there is at least one request to show.
	if (agg.slowest_requests.length > 0) {
		const top = agg.slowest_requests[0]!;
		const evidence_sessions = Array.from(new Set(agg.slowest_requests.slice(0, 3).map((r) => r.session_id)));
		levers.push({
			id: "slowest_requests",
			title: "Investigate your slowest requests",
			detail: `The slowest request took ${formatHM(top.active_sec)} of active time in session ${top.session_id}, dominated by ${top.dominant_bucket}.`,
			evidence_sessions,
		});
	}

	return levers;
}
