// SPDX-FileCopyrightText: 2026 Hari Srinivasan <harisrini21@gmail.com>
// SPDX-FileCopyrightText: 2026 Tobias Hoelzer (omp port)
// SPDX-License-Identifier: AGPL-3.0-only


// #18 "Where did the time go": deterministic per-session extraction of the
// six wall-clock buckets (model/tools/agents/ci/you/idle). Overlapping work
// (a subagent running while its parent is still generating, two parallel
// bash calls) is resolved to a strict partition of the session's elapsed
// time by priority (ci > agents > tools > model > you), so the buckets sum
// to exactly the session's active window; src/time-aggregate.ts rolls this
// up across the corpus.

import { BROWSER_IN_CODE_RE, extractTextFromContent, isHumanMessage } from "./stats.ts";
import type { AnyEntry, AnyMessage, ContentBlock, SessionTimeSplit, SlowRequest, TimeBucket, WaitKind } from "./types.ts";

// Why 900: a session left mid-turn for hours should not read as 23h of
// "waiting on you"; 15 minutes covers a slow reply without bridging idle
// hours (mirrors ACTIVE_GAP_MINUTES in stats.ts, which exists for the same
// reason on the activity-interval side).
export const IDLE_CAP_SEC = 900;

// Why no bare "pipeline": that word alone matches too much ordinary prose or
// code (a local variable named `pipeline`, "running pipeline" in a log
// message) to mean CI; every term here is an actual CI command or polling
// check target.
const CI_TERMS_RE =
	/\bglab\s+ci\b|\bgh\s+pr\s+checks\b|\bgh\s+run\s+(?:watch|view)\b|\bdeploy\s+status\b|\bvercel\s+inspect\b/i;
const AGENT_TERM_RE = /\b(orca|worker|dispatch|agent|bg_\w+)\b/i;
const SLEEP_CALL_RE = /\btime\.sleep\s*\(|\bsleep\s+\d/i;
const LOOP_KEYWORD_RE = /\b(while|until|for)\b/i;

/**
 * What a bash/eval call (or the wait/task/`*_wait` tools, e.g. `vibe_wait`)
 * is waiting on. `wait`, `task`, and any tool whose name ends in `_wait`
 * are always "agents" regardless of their input; bash/eval text is
 * read for CI-watcher commands and polling loops (python `time.sleep`
 * loops, bash `while|until ... sleep`), which are then classified by their
 * target: CI terms win over everything else, then agent-ish targets, else
 * generic polling. A plain command (no CI terms, no poll loop) is real tool
 * work, not a wait.
 */
export function classifyWait(toolName: string, text: string): WaitKind {
	if (toolName === "wait" || toolName === "task" || toolName.endsWith("_wait")) return "agents";
	if (toolName !== "bash" && toolName !== "eval") return null;
	if (CI_TERMS_RE.test(text)) return "ci";
	const isPollingLoop = SLEEP_CALL_RE.test(text) && LOOP_KEYWORD_RE.test(text);
	if (isPollingLoop) return AGENT_TERM_RE.test(text) ? "agents" : "polling";
	return null;
}

function pollingTarget(text: string): string {
	if (CI_TERMS_RE.test(text)) return "ci";
	const m = AGENT_TERM_RE.exec(text);
	if (m) return m[1]!.toLowerCase();
	return "generic";
}

// Extracts the loop body of a `for ...; do X; done` / `while ...; do X;
// done` / `until ...; do X; done` construct (the command actually doing
// work, not the loop scaffolding around it). Returns the text up to the
// first `;`/`&&` inside the body, or null if the text isn't a do/done loop.
const LOOP_BODY_RE = /\b(?:for|while|until)\b[\s\S]*?\bdo\b([\s\S]*?)\bdone\b/i;
function loopBody(text: string): string | null {
	const m = LOOP_BODY_RE.exec(text);
	if (!m) return null;
	const body = m[1]!.trim();
	if (!body) return null;
	const firstStmt = body.split(/;|&&/)[0]!.trim();
	return firstStmt || body;
}

// Strips a bash command down to its "verb": a leading `cd ... &&`, env
// assignments, and `npx`/`pnpm exec`/`uv run` wrappers are noise around the
// command that actually ran. Two tokens when the second isn't a flag or a
// shell variable (so generic CLIs like `npm`/`git`/`glab` keep their
// subcommand, but a loop variable like `$f` isn't mistaken for one). A
// `for`/`while`/`until ... do X; done` loop (with no CI/agent/poll target,
// handled upstream by commandFamily) reduces to the body command X's family.
function bashFamily(text: string): string {
	let cmd = text.trim();
	if (!cmd) return "bash";
	const body = loopBody(cmd);
	if (body) return bashFamily(body);
	let prevLen: number;
	do {
		prevLen = cmd.length;
		cmd = cmd.replace(/^cd\s+\S+\s*&&\s*/, "");
		// `set -euo pipefail; <cmd>` (also `&&`/newline-separated): a
		// shell-options setup prefix in front of the real command, not the
		// command itself.
		cmd = cmd.replace(/^set\s+[^;&\n]*(?:;|&&|\n)\s*/, "");
	} while (cmd.length !== prevLen);
	cmd = cmd.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, "");
	let tokens = cmd.split(/\s+/).filter(Boolean);
	if (tokens[0] === "npx") tokens = tokens.slice(1);
	else if (tokens[0] === "pnpm" && tokens[1] === "exec") tokens = tokens.slice(2);
	else if (tokens[0] === "uv" && tokens[1] === "run") tokens = tokens.slice(2);
	if (tokens.length === 0) return "bash";
	if (tokens.length >= 2 && !tokens[1]!.startsWith("-") && !tokens[1]!.startsWith("$")) return `${tokens[0]} ${tokens[1]}`;
	return tokens[0]!;
}

// Extracts the single shell command a `sh('...')`/`subprocess.run(...)`/
// `Bun.$\`...\`` call in eval code actually runs, so that call groups with
// its underlying command family instead of a generic "eval" bucket.
const SUBPROCESS_CMD_RE =
	/\b(?:sh|subprocess\.(?:run|call|check_output|check_call|Popen))\s*\(\s*['"`]([^'"`]+)['"`]|\bBun\.\$\s*(?:\(\s*['"`]([^'"`]+)['"`]|`([^`]*)`)/;

// Why a syntax heuristic: the eval tool's `language` arg ("py"/"js") is
// authoritative when present; a log missing it (or carrying something else)
// still gets a language-specific family instead of falling back to a bare,
// uninformative "eval".
const PY_SYNTAX_RE = /^\s*(?:def\s+\w+\s*\(|import\s+\w|from\s+\w+\s+import\b|print\s*\()/m;
function evalLanguageFamily(language: string | undefined, text: string): string {
	if (language === "py") return "eval: python";
	if (language === "js") return "eval: js";
	return PY_SYNTAX_RE.test(text) ? "eval: python" : "eval: js";
}

// Marks a toolResult as a provisional "moved to background" delivery, not
// the call's real outcome: omp backgrounds a still-running bash/eval call
// and injects this notice immediately, then delivers the actual result as a
// later toolResult for the same toolCallId once the job finishes.
const BACKGROUND_PROVISIONAL_RE = /\bBackgrounded as job bg_\d+/i;

/**
 * The command family a tool call belongs to, for `busy_by_command`: bash
 * and eval calls classified as a wait (CI watcher, polling loop) reduce to
 * `polling: <target>` (the CI/agent target it is polling for, or "generic"
 * otherwise); a bash loop that isn't a wait reduces to its body command's
 * family (`npm test`, `git push`). eval code that drives the `browser`
 * global groups as `eval: browser`; eval code that shells out via
 * `sh(...)`/`subprocess.*(...)`/`` Bun.$`...` `` groups by that underlying
 * command's own family (so it lands with its bash counterpart, not a
 * generic eval bucket); any other eval code groups by `language`
 * (`eval: python` / `eval: js`). Every other tool is its own family.
 */
export function commandFamily(toolName: string, text: string, language?: string): string {
	if (toolName === "bash") {
		const wk = classifyWait("bash", text);
		if (wk) return `polling: ${pollingTarget(text)}`;
		return bashFamily(text);
	}
	if (toolName === "eval") {
		const wk = classifyWait("eval", text);
		if (wk) return `polling: ${pollingTarget(text)}`;
		if (BROWSER_IN_CODE_RE.test(text)) return "eval: browser";
		const subprocessMatch = SUBPROCESS_CMD_RE.exec(text);
		const subprocessCmd = (subprocessMatch?.[1] ?? subprocessMatch?.[2] ?? subprocessMatch?.[3] ?? "").trim();
		if (subprocessCmd) return bashFamily(subprocessCmd);
		return evalLanguageFamily(language, text);
	}
	return toolName || "unknown";
}

export type TaggedInterval = { start: number; end: number; bucket: TimeBucket };

// Why: "elsewhere" is never produced per session (aggregateTime decides it cross-session), so its priority is irrelevant here.
const BUCKET_PRIORITY: Record<TimeBucket, number> = { ci: 4, agents: 3, tools: 2, model: 1, you: 0, elsewhere: 0, idle: -1 };

/**
 * Resolves overlapping intervals to a partition of [rangeStart, rangeEnd):
 * every covered instant is attributed to its highest-priority interval; any
 * instant no interval covers is returned as a (merged, contiguous) gap for
 * the caller to attribute (the you/idle split).
 */
function mergeAdjacent(segments: Array<[number, number]>): Array<[number, number]> {
	const sorted = [...segments].sort((a, b) => a[0] - b[0]);
	const merged: Array<[number, number]> = [];
	for (const [s, e] of sorted) {
		const last = merged[merged.length - 1];
		if (last && s <= last[1]) last[1] = Math.max(last[1], e);
		else merged.push([s, e]);
	}
	return merged;
}

function mergeCoverage(
	intervals: TaggedInterval[],
	rangeStart: number,
	rangeEnd: number,
): { covered: Partial<Record<TimeBucket, number>>; gaps: Array<[number, number]>; youCovered: Array<[number, number]> } {
	const covered: Partial<Record<TimeBucket, number>> = {};
	if (rangeEnd <= rangeStart) return { covered, gaps: [], youCovered: [] };
	const clipped = intervals
		.map((iv) => ({ start: Math.max(iv.start, rangeStart), end: Math.min(iv.end, rangeEnd), bucket: iv.bucket }))
		.filter((iv) => iv.end > iv.start);

	const points = new Set<number>([rangeStart, rangeEnd]);
	for (const iv of clipped) {
		points.add(iv.start);
		points.add(iv.end);
	}
	const sorted = [...points].sort((a, b) => a - b);

	const rawGaps: Array<[number, number]> = [];
	const rawYouSegs: Array<[number, number]> = [];
	for (let i = 0; i < sorted.length - 1; i++) {
		const segStart = sorted[i]!;
		const segEnd = sorted[i + 1]!;
		if (segEnd <= segStart) continue;
		let bestBucket: TimeBucket | null = null;
		let bestPriority = -Infinity;
		for (const iv of clipped) {
			if (iv.start <= segStart && iv.end >= segEnd && BUCKET_PRIORITY[iv.bucket] > bestPriority) {
				bestPriority = BUCKET_PRIORITY[iv.bucket];
				bestBucket = iv.bucket;
			}
		}
		const len = segEnd - segStart;
		if (bestBucket) {
			covered[bestBucket] = (covered[bestBucket] ?? 0) + len;
			if (bestBucket === "you") rawYouSegs.push([segStart, segEnd]);
		} else rawGaps.push([segStart, segEnd]);
	}

	const gaps: Array<[number, number]> = [];
	for (const [s, e] of rawGaps) {
		const last = gaps[gaps.length - 1];
		if (last && last[1] === s) last[1] = e;
		else gaps.push([s, e]);
	}
	return { covered, gaps, youCovered: mergeAdjacent(rawYouSegs) };
}


/**
 * Generic interval-priority partition shared by every time-split extractor
 * (omp's extractTimeSplit and the Claude Code adapter): resolves overlapping
 * [start, end) intervals to a strict partition of [rangeStart, rangeEnd) by
 * bucket priority (BUCKET_PRIORITY), then caps each contiguous uncovered gap
 * at idleCapSec seconds of "you" with any overflow landing in "idle".
 */
export function partitionIntervals(
	intervals: TaggedInterval[],
	rangeStart: number,
	rangeEnd: number,
	idleCapSec: number,
): { buckets: Record<TimeBucket, number>; activeSec: number; youGaps: Array<[number, number]> } {
	const { covered, gaps, youCovered } = mergeCoverage(intervals, rangeStart, rangeEnd);
	const buckets: Record<TimeBucket, number> = {
		model: (covered.model ?? 0) / 1000,
		tools: (covered.tools ?? 0) / 1000,
		agents: (covered.agents ?? 0) / 1000,
		ci: (covered.ci ?? 0) / 1000,
		you: (covered.you ?? 0) / 1000,
		elsewhere: 0,
		idle: 0,
	};
	const capMs = idleCapSec * 1000;
	const youGapSegments: Array<[number, number]> = [...youCovered];
	for (const [gapStart, gapEnd] of gaps) {
		const span = gapEnd - gapStart;
		const cappedSpan = Math.min(span, capMs);
		buckets.you += cappedSpan / 1000;
		buckets.idle += Math.max(0, span - capMs) / 1000;
		if (cappedSpan > 0) youGapSegments.push([gapStart, gapStart + cappedSpan]);
	}
	for (const k of Object.keys(buckets) as TimeBucket[]) buckets[k] = round(buckets[k]);
	const activeSec = round(buckets.model + buckets.tools + buckets.agents + buckets.ci + buckets.you + buckets.elsewhere);
	return { buckets, activeSec, youGaps: mergeAdjacent(youGapSegments) };
}


function round(n: number): number {
	return Math.round(n * 1000) / 1000;
}

function dominantBucket(totals: Partial<Record<TimeBucket, number>>): TimeBucket {
	let best: TimeBucket = "you";
	let bestValue = -1;
	for (const bucket of Object.keys(totals) as TimeBucket[]) {
		const v = totals[bucket] ?? 0;
		if (v > bestValue) {
			bestValue = v;
			best = bucket;
		}
	}
	return best;
}

function buildSlowestRequests(
	humanMessages: Array<{ ts: number; text: string }>,
	intervals: TaggedInterval[],
	rangeEnd: number,
	idleCapSec: number,
	sessionId: string,
	project: string,
): SlowRequest[] {
	if (!humanMessages.length) return [];
	const capMs = idleCapSec * 1000;
	const requests: SlowRequest[] = [];
	for (let i = 0; i < humanMessages.length; i++) {
		const start = humanMessages[i]!.ts;
		const end = i + 1 < humanMessages.length ? humanMessages[i + 1]!.ts : rangeEnd;
		if (end <= start) continue;
		const { covered, gaps } = mergeCoverage(intervals, start, end);
		const totals: Partial<Record<TimeBucket, number>> = { ...covered };
		for (const [gapStart, gapEnd] of gaps) {
			const span = gapEnd - gapStart;
			totals.you = (totals.you ?? 0) + Math.min(span, capMs);
			totals.idle = (totals.idle ?? 0) + Math.max(0, span - capMs);
		}
		const idleMs = totals.idle ?? 0;
		const wallSec = round((end - start) / 1000);
		const { idle: _idle, ...nonIdleTotals } = totals;
		requests.push({
			session_id: sessionId,
			project,
			prompt: humanMessages[i]!.text.slice(0, 120),
			wall_sec: wallSec,
			active_sec: round(wallSec - idleMs / 1000),
			dominant_bucket: dominantBucket(nonIdleTotals),
		});
	}
	return requests.sort((a, b) => b.active_sec - a.active_sec).slice(0, 5);
}

/**
 * Per-session time split on the parent session's wall clock. One pass over
 * the raw log: assistant `ttft+duration` builds model intervals, matched
 * `tool_execution_start`/`toolResult` pairs build tool intervals (the
 * command/code text for bash/eval comes from the triggering assistant
 * message's `toolCall` block), classified into tools/agents/ci/you by tool
 * name and `classifyWait`. A toolResult carrying a "Backgrounded as job
 * bg_N" provisional notice does not close out its call: the next toolResult
 * for the same id (the real follow-up) replaces its interval/duration, so a
 * backgrounded call's full start-to-finish span is counted exactly once,
 * under the original command's classification. Any instant in [first human
 * message, last entry] not covered by one of those intervals is, by
 * elimination, time spent waiting on the user: capped per (contiguous) gap
 * at `idleCapSec`, with the overflow landing in `idle`.
 */
export function extractTimeSplit(
	entries: AnyEntry[],
	sessionId: string,
	project: string,
	idleCapSec = IDLE_CAP_SEC,
): SessionTimeSplit {
	const toolCallMeta = new Map<string, { toolName: string; text: string; language?: string }>();
	const toolCallStarts = new Map<string, { toolName: string; startedAtMs: number }>();
	// Tracks what's already been counted for a toolCallId so a background
	// job's later follow-up result replaces (not adds to) its provisional
	// delivery's interval/busy-time contribution.
	const toolCallDelivered = new Map<string, { intervalIndex: number; commandKey: string | null; durationSec: number }>();
	const intervals: TaggedInterval[] = [];
	const busyByTool: Record<string, number> = {};
	const busyByCommand: Record<string, number> = {};
	const humanMessages: Array<{ ts: number; text: string }> = [];
	let lastEntryMs = 0;
	// Why: a session with no human message of its own (an assistant-only
	// subagent/advisor sidecar) has no humanMessages[0] to anchor rangeStart;
	// falling back to epoch 0 would count the gap back to 1970 as idle and
	// drown its real model busy time, so the earliest real timestamp wins.
	let firstEntryMs: number | null = null;

	function classifyToolBucket(toolName: string, text: string): TimeBucket {
		if (toolName === "ask") return "you";
		if (toolName === "wait" || toolName === "task") return "agents";
		const wk = classifyWait(toolName, text);
		if (wk === "ci") return "ci";
		if (wk === "agents") return "agents";
		return "tools";
	}

	for (const entry of entries) {
		const entryTs = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
		if (!Number.isNaN(entryTs) && entryTs > lastEntryMs) lastEntryMs = entryTs;
		if (!Number.isNaN(entryTs) && (firstEntryMs === null || entryTs < firstEntryMs)) firstEntryMs = entryTs;

		if (entry.type === "custom" && entry.customType === "tool_execution_start") {
			const data = entry.data as Record<string, unknown> | undefined;
			const toolCallId = typeof data?.toolCallId === "string" ? data.toolCallId : "";
			const toolName = typeof data?.toolName === "string" ? data.toolName : "";
			const startedAtRaw = data?.startedAt;
			const startedAtMs =
				typeof startedAtRaw === "number"
					? startedAtRaw
					: typeof startedAtRaw === "string"
						? Date.parse(startedAtRaw)
						: Number.NaN;
			if (toolCallId && toolName && !Number.isNaN(startedAtMs)) {
				toolCallStarts.set(toolCallId, { toolName, startedAtMs });
				if (startedAtMs > lastEntryMs) lastEntryMs = startedAtMs;
			}
			continue;
		}
		if (entry.type !== "message") continue;
		const msg = entry.message as AnyMessage | undefined;
		if (!msg) continue;
		const msgTs = typeof msg.timestamp === "number" ? msg.timestamp : Number.isNaN(entryTs) ? null : entryTs;
		if (msgTs !== null && msgTs > lastEntryMs) lastEntryMs = msgTs;
		if (msgTs !== null && (firstEntryMs === null || msgTs < firstEntryMs)) firstEntryMs = msgTs;

		if (msg.role === "assistant") {
			const ttft = typeof msg.ttft === "number" ? msg.ttft : 0;
			const duration = typeof msg.duration === "number" ? msg.duration : 0;
			const totalMs = ttft + duration;
			const endMs = typeof msg.completedAt === "number" ? msg.completedAt : msgTs;
			if (totalMs > 0 && endMs !== null) {
				const modelStart = endMs - totalMs;
				intervals.push({ start: modelStart, end: endMs, bucket: "model" });
				if (endMs > lastEntryMs) lastEntryMs = endMs;
				if (firstEntryMs === null || modelStart < firstEntryMs) firstEntryMs = modelStart;
			}

			const content = msg.content;
			if (Array.isArray(content)) {
				for (const block of content as ContentBlock[]) {
					if (block.type !== "toolCall") continue;
					const toolName = (block.name as string) ?? "";
					const toolId = (block.id as string) ?? "";
					if (!toolId) continue;
					const args = (block.arguments as Record<string, unknown>) ?? {};
					const text =
						toolName === "bash"
							? typeof args.command === "string"
								? args.command
								: ""
							: toolName === "eval"
								? typeof args.code === "string"
									? args.code
									: ""
								: "";
					const language = toolName === "eval" && typeof args.language === "string" ? args.language : undefined;
					toolCallMeta.set(toolId, { toolName, text, language });
				}
			}
			continue;
		}

		if (msg.role === "user" && isHumanMessage(msg) && msgTs !== null) {
			humanMessages.push({ ts: msgTs, text: extractTextFromContent(msg.content).trim() });
			continue;
		}

		if (msg.role === "toolResult") {
			const toolCallId = typeof msg.toolCallId === "string" ? msg.toolCallId : "";
			const resultToolName = typeof msg.toolName === "string" ? msg.toolName : "";
			const start = toolCallId ? toolCallStarts.get(toolCallId) : undefined;
			if (start && msgTs !== null) {
				const toolName = start.toolName || resultToolName;
				const meta = toolCallId ? toolCallMeta.get(toolCallId) : undefined;
				const text = meta?.text ?? "";
				const durationSec = Math.max(0, (msgTs - start.startedAtMs) / 1000);
				const bucket = classifyToolBucket(toolName, text);
				// Why gate on "tools": busy_by_command tracks real tool work;
				// ask/wait/task and ci/agents-classified calls already have
				// their own buckets and would otherwise show up twice, as
				// misleading "top commands" like `wait` or `ask`.
				const commandKey = bucket === "tools" ? commandFamily(toolName, text, meta?.language) : null;

				// A toolCallId may get more than one toolResult: a call moved
				// to a background job delivers a provisional "Backgrounded as
				// job bg_N" result first and the real outcome later as a
				// follow-up (same id). The original start is reused for every
				// delivery, and a prior delivery's interval/sums are replaced
				// (not added to), so the final delivery's full start-to-finish
				// span is counted exactly once.
				const prior = toolCallDelivered.get(toolCallId);
				if (prior) {
					const deltaSec = durationSec - prior.durationSec;
					intervals[prior.intervalIndex] = { start: start.startedAtMs, end: msgTs, bucket };
					busyByTool[toolName] = (busyByTool[toolName] ?? 0) + deltaSec;
					if (commandKey) busyByCommand[commandKey] = (busyByCommand[commandKey] ?? 0) + deltaSec;
					toolCallDelivered.set(toolCallId, { intervalIndex: prior.intervalIndex, commandKey, durationSec });
				} else {
					intervals.push({ start: start.startedAtMs, end: msgTs, bucket });
					busyByTool[toolName] = (busyByTool[toolName] ?? 0) + durationSec;
					if (commandKey) busyByCommand[commandKey] = (busyByCommand[commandKey] ?? 0) + durationSec;
					toolCallDelivered.set(toolCallId, { intervalIndex: intervals.length - 1, commandKey, durationSec });
				}

				const resultText = extractTextFromContent(msg.content).trim();
				if (BACKGROUND_PROVISIONAL_RE.test(resultText)) {
					// Still running in the background: keep the start so the
					// eventual follow-up (same toolCallId) can extend this
					// call's interval to its real finish time instead of
					// being lost when the provisional result is processed.
				} else {
					toolCallStarts.delete(toolCallId);
					toolCallDelivered.delete(toolCallId);
				}
			}
			continue;
		}
	}

	humanMessages.sort((a, b) => a.ts - b.ts);
	// Why firstEntryMs: see the "no human message" note on firstEntryMs above.
	const rangeStart = humanMessages.length ? humanMessages[0]!.ts : (firstEntryMs ?? 0);
	const rangeEnd = Math.max(lastEntryMs, rangeStart);

	const { buckets, activeSec, youGaps } = partitionIntervals(intervals, rangeStart, rangeEnd, idleCapSec);

	return {
		buckets,
		active_sec: activeSec,
		busy_by_tool: busyByTool,
		busy_by_command: busyByCommand,
		// Why 0: subagent/advisor sidecars aren't visible from one session's
		// own entries; the stats integration fills this in from sidecar logs.
		subagent_busy_sec: 0,
		slowest_requests: buildSlowestRequests(humanMessages, intervals, rangeEnd, idleCapSec, sessionId, project),
		you_gaps: youGaps,
	};
}
