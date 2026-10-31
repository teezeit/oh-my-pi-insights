// SPDX-FileCopyrightText: 2026 Tobias Hoelzer (omp port)
// SPDX-License-Identifier: AGPL-3.0-only


// Issue #21 "retro": an optional (default-off) extension that hooks
// session_stop. After a big request it hands the agent a deterministic data
// block plus a "write one retro file, propose only" instruction via
// additionalContext, so the agent reflects on its own time usage without any
// code/config/skill edits being in scope for that continuation.

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DATA_DIR, migrateLegacyDataDir } from "./cache.ts";
import { readJsonl } from "./sources/omp.ts";
import { extractTextFromContent, isHumanMessage } from "./stats.ts";
import { extractTimeSplit } from "./time.ts";
import type { AnyEntry, AnyMessage, ContentBlock, SessionTimeSplit, TimeBucket } from "./types.ts";

// ─── Host API (structural) ────────────────────────────────────────────────────

// Why: same rationale as index.ts's ExtensionAPI note - typed structurally
// against what omp's session_stop hook actually passes, not a package import.

export type SessionStopEvent = {
	messages?: unknown;
	turn_id?: string;
	last_assistant_message?: { stopReason?: string } | null;
	session_id?: string;
	session_file?: string;
	stop_hook_active?: boolean;
	signal?: { aborted?: boolean };
};

export type SessionStopContext = {
	hasUI: boolean;
};

export type SessionStopResult = { continue: true; additionalContext: string };

export type RetroExtensionAPI = {
	on(
		event: "session_stop",
		handler: (
			event: SessionStopEvent,
			ctx: SessionStopContext,
		) => Promise<SessionStopResult | undefined> | SessionStopResult | undefined,
	): void;
};

export type RetroOptions = {
	dataDir?: string;
	now?: () => number;
	env?: Record<string, string | undefined>;
};

const DEFAULT_MIN_MINUTES = 30;
const DEFAULT_MIN_TOOL_CALLS = 100;

/** `--retro-...` has no flag form (this hook has no command line); env only, positive numbers, else the defaults. */
export function resolveRetroThresholds(
	env: Record<string, string | undefined>,
): { minMinutes: number; minToolCalls: number } {
	const minutes = Number(env.OMP_INSIGHTS_RETRO_MIN_MINUTES);
	const toolCalls = Number(env.OMP_INSIGHTS_RETRO_MIN_TOOL_CALLS);
	return {
		minMinutes: Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_MIN_MINUTES,
		minToolCalls: Number.isFinite(toolCalls) && toolCalls > 0 ? toolCalls : DEFAULT_MIN_TOOL_CALLS,
	};
}

/**
 * The last human (user-attributed) message record in a session log: its
 * index (so the caller can slice everything after it as "this request") and
 * its epoch-ms timestamp. null when the log has no human message at all.
 */
export function findLastHumanMessage(entries: AnyEntry[]): { index: number; ts: number } | null {
	let found: { index: number; ts: number } | null = null;
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		if (entry.type !== "message") continue;
		const msg = entry.message as AnyMessage | undefined;
		if (!msg || msg.role !== "user" || !isHumanMessage(msg)) continue;
		const ts =
			typeof msg.timestamp === "number"
				? msg.timestamp
				: typeof entry.timestamp === "string"
					? Date.parse(entry.timestamp)
					: Number.NaN;
		if (Number.isNaN(ts)) continue;
		found = { index: i, ts };
	}
	return found;
}

/** Assistant `toolCall` content blocks across the given entries (the current request's span). */
export function countToolCalls(entries: AnyEntry[]): number {
	let count = 0;
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const msg = entry.message as AnyMessage | undefined;
		if (!msg || msg.role !== "assistant") continue;
		const content = msg.content;
		if (!Array.isArray(content)) continue;
		for (const block of content as ContentBlock[]) {
			if (block.type === "toolCall") count++;
		}
	}
	return count;
}

/** `toolResult` entries with `isError === true` across the given entries. */
export function countToolErrors(entries: AnyEntry[]): number {
	let count = 0;
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const msg = entry.message as AnyMessage | undefined;
		if (!msg || msg.role !== "toolResult") continue;
		if (msg.isError === true) count++;
	}
	return count;
}

// ─── Corrections ────────────────────────────────────────────────────────────

// Why English+German: Tobias writes to the agent in both. Patterns are
// intentionally loose (a correction is a short, blunt exchange); the false
// positive list below exists because the same words show up in routine
// praise, quoted preferences text, or this very file's own instructions.
const CORRECTION_PATTERNS: RegExp[] = [
	/^no\b/i,
	/not that/i,
	/i said/i,
	/\bagain\b/i,
	/\bstop\b/i,
	/don't/i,
	/\bwrong\b/i,
	// German
	/\bnein\b/i,
	/\bfalsch\b/i,
	/\bnochmal\b/i,
	/hab doch gesagt/i,
];

const CORRECTION_FALSE_POSITIVES: RegExp[] = [/don't worry/i, /no problem/i, /stop on green/i];

/** A human message that reads as a correction: one of the EN/DE phrases above, unless it's a known false positive. */
export function isCorrectionMessage(text: string): boolean {
	const trimmed = text.trim();
	if (!trimmed) return false;
	if (CORRECTION_FALSE_POSITIVES.some((re) => re.test(trimmed))) return false;
	return CORRECTION_PATTERNS.some((re) => re.test(trimmed));
}

/** True when the nearest preceding message entry is an assistant turn the provider reports as stopReason "aborted". */
export function followsAbortedTurn(entries: AnyEntry[], humanIndex: number): boolean {
	for (let i = humanIndex - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "message") continue;
		const msg = entry.message as AnyMessage | undefined;
		if (!msg) continue;
		return msg.role === "assistant" && typeof msg.stopReason === "string" && msg.stopReason === "aborted";
	}
	return false;
}

export type CorrectionHit = { text: string; reason: "phrase" | "abort-follow" };

/**
 * Human messages from `fromIndex` onward that read as a correction: a
 * phrase match, or a message that directly follows an aborted assistant
 * turn (the user interrupted and immediately said something else).
 * `fromIndex` is the request's start (today: the last human message, same
 * span the thresholds below already use - see the "request" note on
 * `buildRetroResult`).
 */
export function detectCorrections(entries: AnyEntry[], fromIndex: number): CorrectionHit[] {
	const hits: CorrectionHit[] = [];
	for (let i = fromIndex; i < entries.length; i++) {
		const entry = entries[i];
		if (entry.type !== "message") continue;
		const msg = entry.message as AnyMessage | undefined;
		if (!msg || msg.role !== "user" || !isHumanMessage(msg)) continue;
		const text = extractTextFromContent(msg.content).trim();
		if (!text) continue;
		if (isCorrectionMessage(text)) hits.push({ text, reason: "phrase" });
		else if (followsAbortedTurn(entries, i)) hits.push({ text, reason: "abort-follow" });
	}
	return hits;
}

/** Up to `limit` correction quotes, each capped at `maxChars`, for the deterministic data block. */
export function quoteCorrections(hits: CorrectionHit[], limit = 5, maxChars = 200): string[] {
	return hits.slice(0, limit).map((h) => (h.text.length > maxChars ? h.text.slice(0, maxChars) : h.text));
}

/** Up to `limit` failed-tool-result lines ("tool: first output line") from `fromIndex` onward, each capped at `maxChars`. */
export function collectFailedToolLines(entries: AnyEntry[], fromIndex: number, limit = 5, maxChars = 200): string[] {
	const lines: string[] = [];
	for (let i = fromIndex; i < entries.length && lines.length < limit; i++) {
		const entry = entries[i];
		if (entry.type !== "message") continue;
		const msg = entry.message as AnyMessage | undefined;
		if (!msg || msg.role !== "toolResult" || msg.isError !== true) continue;
		const toolName = typeof msg.toolName === "string" && msg.toolName ? msg.toolName : "tool";
		const firstLine = extractTextFromContent(msg.content).trim().split("\n")[0]?.trim() ?? "";
		const line = firstLine ? `${toolName}: ${firstLine}` : `${toolName}: (no output)`;
		lines.push(line.length > maxChars ? line.slice(0, maxChars) : line);
	}
	return lines;
}

function pad2(n: number): string {
	return n < 10 ? `0${n}` : `${n}`;
}

function formatHeaderDate(now: Date): string {
	const date = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
	const time = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
	return `${date} ${time}`;
}

function formatDuration(seconds: number): string {
	const total = Math.max(0, Math.round(seconds));
	const h = Math.floor(total / 3600);
	const m = Math.round((total % 3600) / 60);
	return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/**
 * Project slug for the retro filename and header: derived from the session
 * header record's `cwd`. A worktree path (`.worktrees/<name>` or
 * `.orca/worktrees/<name>`) collapses to `<repo>-<worktree name>`; any other
 * path uses its last segment. Lowercased, non [a-z0-9] runs become `-`,
 * trimmed and capped at 40 chars; empty/missing input is "unknown".
 */
export function slugifyProject(cwd: string | undefined): string {
	if (!cwd) return "unknown";
	const segments = cwd.split("/").filter((s) => s.length > 0);
	let raw: string | undefined;
	for (let i = 0; i < segments.length; i++) {
		if (segments[i] === ".worktrees" && i > 0 && i + 1 < segments.length) {
			raw = `${segments[i - 1]}-${segments[i + 1]}`;
			break;
		}
		if (segments[i] === ".orca" && segments[i + 1] === "worktrees" && i > 0 && i + 2 < segments.length) {
			raw = `${segments[i - 1]}-${segments[i + 2]}`;
			break;
		}
	}
	if (raw === undefined) raw = segments.length > 0 ? segments[segments.length - 1] : "";
	const slug = raw
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
	return slug.length > 0 ? slug : "unknown";
}

/** `<dataDir>/retros/<YYYY-MM-DD>T<HH-MM>_<project>_<last 8 chars of session id>.md`, local time. */
export function buildRetroPath(dataDir: string, now: Date, sessionId: string, project: string): string {
	const date = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
	const time = `${pad2(now.getHours())}-${pad2(now.getMinutes())}`;
	const id = sessionId || "unknown";
	const shortId = id === "unknown" ? "unknown" : id.slice(-8);
	return join(dataDir, "retros", `${date}T${time}_${project}_${shortId}.md`);
}

const BUCKET_ORDER: TimeBucket[] = ["model", "tools", "agents", "review", "ci", "you", "elsewhere", "idle"];

function formatTimeSplit(split: SessionTimeSplit): string {
	const lines: string[] = [];
	for (const bucket of BUCKET_ORDER) {
		const sec = split.buckets[bucket] ?? 0;
		if (sec <= 0) continue;
		const share =
			bucket !== "idle" && split.active_sec > 0 ? ` (${Math.round((sec / split.active_sec) * 100)}% of active time)` : "";
		lines.push(`- ${bucket}: ${formatDuration(sec)}${share}`);
	}
	return lines.length > 0 ? lines.join("\n") : "- no time-split data";
}

function topCommandFamilies(split: SessionTimeSplit, limit = 3): string {
	const entries = Object.entries(split.busy_by_command).sort((a, b) => b[1] - a[1]).slice(0, limit);
	if (entries.length === 0) return "- none";
	return entries.map(([name, sec]) => `- ${name}: ${formatDuration(sec)}`).join("\n");
}

export type RetroRequestData = {
	wallClockMinutes: number;
	toolCalls: number;
	toolErrors: number;
	split: SessionTimeSplit;
	now: Date;
	project: string;
	sessionId: string;
	cwd: string;
	/** Absolute path of the session's .jsonl log, so the retro links straight to it. */
	sessionFile: string;
	/** Up to 5 quoted correction lines from this request; see detectCorrections/quoteCorrections. */
	corrections: string[];
	/** Up to 5 failed-tool-result first lines from this request; see collectFailedToolLines. */
	failedTools: string[];
	/** True when neither size threshold was met and the retro fired only because the request contained a correction. */
	triggeredByCorrectionOnly: boolean;
};

/**
 * The hidden-message payload: this request's deterministic numbers plus the
 * "write one retro file, propose only" instruction (issue #21's decisions).
 */
export function buildRetroContext(data: RetroRequestData, retroPath: string): string {
	return [
		data.triggeredByCorrectionOnly
			? "This request contained a correction, so it gets a short retro."
			: "This request ran long enough to warrant a retro.",
		"",
		"## Request data",
		`- Wall clock: ${formatDuration(data.wallClockMinutes * 60)}`,
		`- Tool calls: ${data.toolCalls}`,
		`- Tool errors: ${data.toolErrors}`,
		"- Time split:",
		formatTimeSplit(data.split),
		"- Top command families by busy time:",
		topCommandFamilies(data.split),
		"- Corrections quoted from this request:",
		data.corrections.length > 0 ? data.corrections.map((c) => `- "${c}"`).join("\n") : "- none",
		"- Failed tool results from this request:",
		data.failedTools.length > 0 ? data.failedTools.map((t) => `- ${t}`).join("\n") : "- none",
		"",
		"## Instructions",
		`Write a short retro to ${retroPath} (the directory already exists). The retro file must start with these lines verbatim (values already filled in):`,
		`# Retro ${formatHeaderDate(data.now)} - ${data.project}`,
		"",
		`Session: ${data.sessionId}`,
		`Reopen: omp -r ${data.sessionId}`,
		`Log: ${data.sessionFile}`,
		`Project: ${data.cwd}`,
		"",
		'Then these sections, in this order (no "What went well" or "What went badly"):',
		"",
		"## Biggest time sink",
		"One line, quoting the numbers above.",
		"",
		"## Corrections and lessons",
		"Up to 5 lines: every correction Tobias gave and every fact you learned from tool output in this request. Each line:",
		'- [<target>] <what you learned or were corrected on, one line> | moment: "<quoted user or tool line, max 120 chars>"',
		'<target> is one of: check, reviewer-standard, skill, pointer, preferences, none (routing order: check/hook > reviewer standard > skill > pointer in AGENTS.md > preferences.md > memory). Drop any candidate you cannot trace to a quoted moment. Write "- none" if nothing qualifies.',
		"",
		"## Improvement proposals",
		"Up to 5 lines, ranked by impact, drawn from these categories: navigation, automated-check, coding-standard, global-AGENTS.md, tool-economy, no-ops, information-access, user-preference. Same line format as above:",
		'- [<target>] <proposed change, one line> | moment: "<quoted user or tool line, max 120 chars>"',
		'Drop any candidate you cannot quote. Write "- none" if nothing qualifies.',
		"",
		"This is a proposals-only pass: do not edit any rule, hook, skill, config or code, and do not start any new work. The only allowed action is writing that one retro file. Keep the whole file at or under about 40 lines.",
		"",
		"After writing the file, reply with exactly these three lines and nothing else:",
		"Time sink: <one line>",
		"Proposal: <one line>",
		`Retro: ${retroPath}`,
	].join("\n");
}

/**
 * Pure decision + payload builder for one session_stop event. Returns
 * undefined whenever the retro shouldn't fire: a re-entrant stop-hook
 * continuation, no UI, an aborted turn, an unreadable session file, no human
 * message in it, or the request stayed under both thresholds with no
 * correction in it.
 *
 * "This request": there is no cross-call state to find where "the previous
 * retro" left off, so this reuses the same span the time/tool-call
 * thresholds already use - entries from the last human message onward. A
 * correction is almost always that very message (the user's next reply
 * after a miss), so this still catches the common case without the added
 * complexity of a persisted marker.
 */
export async function buildRetroResult(
	event: SessionStopEvent,
	ctx: SessionStopContext,
	options: { dataDir: string; now: () => number; env: Record<string, string | undefined>; migrate?: boolean },
): Promise<SessionStopResult | undefined> {
	if (event.stop_hook_active) return undefined;
	if (ctx.hasUI === false) return undefined;
	if (event.last_assistant_message?.stopReason === "aborted") return undefined;
	if (!event.session_file) return undefined;

	let entries: AnyEntry[];
	try {
		entries = await readJsonl(event.session_file);
	} catch {
		return undefined;
	}

	const lastHuman = findLastHumanMessage(entries);
	if (!lastHuman) return undefined;

	// Why include the human message itself: extractTimeSplit starts its range at the first human message.
	const requestEntries = entries.slice(lastHuman.index);
	const nowMs = options.now();
	const wallClockMinutes = (nowMs - lastHuman.ts) / 60000;
	const toolCalls = countToolCalls(requestEntries);
	const toolErrors = countToolErrors(requestEntries);

	const corrections = detectCorrections(entries, lastHuman.index);
	const { minMinutes, minToolCalls } = resolveRetroThresholds(options.env);
	const overThreshold = wallClockMinutes >= minMinutes || toolCalls >= minToolCalls;
	if (!overThreshold && corrections.length === 0) return undefined;

	const sessionId = typeof event.session_id === "string" && event.session_id ? event.session_id : "unknown";
	const split = extractTimeSplit(requestEntries, sessionId, "");
	const header = entries.find((e) => e.type === "session") as { cwd?: unknown } | undefined;
	const cwd = typeof header?.cwd === "string" ? header.cwd : "";
	const project = slugifyProject(cwd || undefined);
	const now = new Date(nowMs);
	const retroPath = buildRetroPath(options.dataDir, now, sessionId, project);

	if (options.migrate) await migrateLegacyDataDir();
	await mkdir(join(options.dataDir, "retros"), { recursive: true });

	const additionalContext = buildRetroContext(
		{
			wallClockMinutes,
			toolCalls,
			toolErrors,
			split,
			now,
			project,
			sessionId,
			cwd,
			sessionFile: event.session_file,
			corrections: quoteCorrections(corrections),
			failedTools: collectFailedToolLines(entries, lastHuman.index),
			triggeredByCorrectionOnly: !overThreshold,
		},
		retroPath,
	);
	return { continue: true, additionalContext };
}

// ─── Extension Entry ──────────────────────────────────────────────────────────

export default function (pi: RetroExtensionAPI, options: RetroOptions = {}): void {
	const dataDir = options.dataDir ?? DATA_DIR;
	const now = options.now ?? Date.now;
	const env = options.env ?? process.env;
	const migrate = options.dataDir === undefined;
	pi.on("session_stop", async (event, ctx) => {
		try {
			return await buildRetroResult(event, ctx, { dataDir, now, env, migrate });
		} catch {
			return undefined;
		}
	});
}
