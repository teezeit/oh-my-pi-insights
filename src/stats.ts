// SPDX-FileCopyrightText: 2026 Hari Srinivasan <harisrini21@gmail.com>
// SPDX-FileCopyrightText: 2026 Tobias Hoelzer (omp port)
// SPDX-License-Identifier: AGPL-3.0-only


// Deterministic per-session extraction: cost/token totals, tool call and
// error denominators, friction signals (aborts, provider errors, invented
// tool names, ttsr/reset events), the per-turn pass and per-tool wall clock.

import { extname } from "node:path";
import { median, percentile } from "./aggregate.ts";
import type {
	AbortEvent,
	AnyEntry,
	AnyMessage,
	ContentBlock,
	ModelUsageMap,
	SessionMeta,
	SessionRef,
	SidecarKind,
	SidecarUsage,
	TurnPercentiles,
	TurnStats,
	UsageRecord,
} from "./types.ts";

export const EXTENSION_TO_LANGUAGE: Record<string, string> = {
	".ts": "TypeScript",
	".tsx": "TypeScript",
	".js": "JavaScript",
	".jsx": "JavaScript",
	".py": "Python",
	".rb": "Ruby",
	".go": "Go",
	".rs": "Rust",
	".java": "Java",
	".md": "Markdown",
	".json": "JSON",
	".yaml": "YAML",
	".yml": "YAML",
	".sh": "Shell",
	".css": "CSS",
	".html": "HTML",
	".c": "C",
	".cpp": "C++",
	".cs": "C#",
	".kt": "Kotlin",
	".swift": "Swift",
};

export const LABEL_MAP: Record<string, string> = {
	debug_investigate: "Debug / Investigate",
	implement_feature: "Implement Feature",
	fix_bug: "Fix Bug",
	write_script_tool: "Write Script / Tool",
	refactor_code: "Refactor Code",
	configure_system: "Configure System",
	create_pr_commit: "Create PR / Commit",
	analyze_data: "Analyze Data",
	understand_codebase: "Understand Codebase",
	write_tests: "Write Tests",
	write_docs: "Write Docs",
	deploy_infra: "Deploy / Infra",
	warmup_minimal: "Cache Warmup",
	fast_accurate_search: "Fast / Accurate Search",
	correct_code_edits: "Correct Code Edits",
	good_explanations: "Good Explanations",
	proactive_help: "Proactive Help",
	multi_file_changes: "Multi-file Changes",
	handled_complexity: "Multi-file Changes",
	good_debugging: "Good Debugging",
	misunderstood_request: "Misunderstood Request",
	wrong_approach: "Wrong Approach",
	buggy_code: "Buggy Code",
	user_rejected_action: "User Rejected Action",
	assistant_got_blocked: "Assistant Got Blocked",
	user_stopped_early: "User Stopped Early",
	wrong_file_or_location: "Wrong File / Location",
	excessive_changes: "Excessive Changes",
	slow_or_verbose: "Slow / Verbose",
	tool_failed: "Tool Failed",
	user_unclear: "User Unclear",
	external_issue: "External Issue",
	frustrated: "Frustrated",
	dissatisfied: "Dissatisfied",
	likely_satisfied: "Likely Satisfied",
	satisfied: "Satisfied",
	happy: "Happy",
	unsure: "Unsure",
	neutral: "Neutral",
	delighted: "Delighted",
	single_task: "Single Task",
	multi_task: "Multi Task",
	iterative_refinement: "Iterative Refinement",
	exploration: "Exploration",
	quick_question: "Quick Question",
	fully_achieved: "Fully Achieved",
	mostly_achieved: "Mostly Achieved",
	partially_achieved: "Partially Achieved",
	not_achieved: "Not Achieved",
	unclear_from_transcript: "Unclear",
	unhelpful: "Unhelpful",
	slightly_helpful: "Slightly Helpful",
	moderately_helpful: "Moderately Helpful",
	very_helpful: "Very Helpful",
	essential: "Essential",
};

export function displayLabel(key: string): string {
	return (
		LABEL_MAP[key] ??
		key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
	);
}


export function getLanguageFromPath(filePath: string): string | null {
	return EXTENSION_TO_LANGUAGE[extname(filePath).toLowerCase()] ?? null;
}

export function extractTextFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return (content as ContentBlock[])
		.filter((b) => b.type === "text" && typeof b.text === "string")
		.map((b) => b.text as string)
		.join(" ");
}

export function isHumanMessage(msg: AnyMessage): boolean {
	// omp attributes every user-role message; anything not attributed to the
	// human (tool follow-ups, injected notices) is not human activity.
	if (typeof msg.attribution === "string" && msg.attribution !== "user")
		return false;
	const content = msg.content;
	if (typeof content === "string" && (content as string).trim()) return true;
	if (Array.isArray(content)) {
		return (content as ContentBlock[]).some(
			(b) =>
				b.type === "text" &&
				typeof b.text === "string" &&
				(b.text as string).trim().length > 0,
		);
	}
	return false;
}

export function countNewlines(s: string): number {
	return (s.match(/\n/g) ?? []).length;
}

/** Detect sessions that were spawned by the insights pipeline itself */
export function isMetaSession(entries: AnyEntry[]): boolean {
	let userMsgCount = 0;
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const msg = entry.message as AnyMessage | undefined;
		if (!msg) continue;
		if (msg.role === "user" && isHumanMessage(msg)) {
			const text = extractTextFromContent(msg.content);
			if (
				text.includes("RESPOND WITH ONLY A VALID JSON OBJECT") ||
				text.includes("record_facets") ||
				text.includes("extract structured facets") ||
				text.includes("At a Glance")
			)
				return true;
			userMsgCount++;
			if (userMsgCount >= 3) break;
		}
	}
	return false;
}

/**
 * omp prices every model call itself: assistant messages carry
 * `message.usage`, and out-of-band calls (titles, auto-thinking, advisor
 * prompts) are `model_usage` records. Both hold `usage.cost.total` in USD, so
 * this port reads the recorded cost instead of re-deriving it from token
 * counts and a price table the way upstream had to.
 */
export function readUsage(usage: unknown): UsageRecord {
	const u = (usage ?? {}) as Record<string, unknown>;
	const cost = (u.cost ?? {}) as Record<string, unknown>;
	return {
		input: typeof u.input === "number" ? u.input : 0,
		output: typeof u.output === "number" ? u.output : 0,
		cacheRead: typeof u.cacheRead === "number" ? u.cacheRead : 0,
		cacheWrite: typeof u.cacheWrite === "number" ? u.cacheWrite : 0,
		cost: typeof cost.total === "number" ? cost.total : 0,
		costInput: typeof cost.input === "number" ? cost.input : 0,
		costOutput: typeof cost.output === "number" ? cost.output : 0,
	};
}

export function addUsage(target: UsageRecord, add: UsageRecord): void {
	target.input += add.input;
	target.output += add.output;
	target.cacheRead += add.cacheRead;
	target.cacheWrite += add.cacheWrite;
	target.cost += add.cost;
	target.costInput += add.costInput;
	target.costOutput += add.costOutput;
}

export function accumulateModel(
	map: ModelUsageMap,
	model: string,
	usage: UsageRecord,
): void {
	const slot = (map[model] ??= {
		input_tokens: 0,
		output_tokens: 0,
		cost: 0,
		message_count: 0,
		cost_input: 0,
		cost_output: 0,
	});
	slot.input_tokens += usage.input;
	slot.output_tokens += usage.output;
	slot.cost += usage.cost;
	slot.message_count++;
	slot.cost_input = (slot.cost_input ?? 0) + usage.costInput;
	slot.cost_output = (slot.cost_output ?? 0) + usage.costOutput;
}

export const TOOL_ERROR_FAMILY: Record<string, string> = {
	bash: "Shell Failed",
	read: "Read Failed",
	write: "Write Failed",
	edit: "Edit Failed",
	glob: "Glob Failed",
	grep: "Grep Failed",
	task: "Subagent Failed",
	eval: "Eval Failed",
	hub: "Hub Failed",
	todo: "Todo Failed",
	ask: "Ask Failed",
	learn: "Learn Failed",
	web_search: "Web Search Failed",
	manage_skill: "Skill Write Failed",
};

/**
 * omp sets `toolResult.isError`, so the error count is exact and upstream's
 * regex bucketing over tool output is deleted rather than ported. The category
 * stays coarse and is derived from the tool that failed.
 */
export function toolErrorCategory(toolName: string): string {
	if (!toolName) return "Unknown Tool";
	if (toolName.startsWith("mcp__"))
		return `MCP: ${toolName.slice(5).split("_")[0]}`;
	return TOOL_ERROR_FAMILY[toolName] ?? `${displayLabel(toolName)} Failed`;
}

/**
 * The model sometimes invents a tool name instead of using a real one
 * ("xd_retain" instead of `write` to `xd://retain`); the harness's reply is
 * always this fixed shape. These are a distinct failure mode (wrong name,
 * not a broken tool) and are kept out of every real tool's error rate.
 */
export const TOOL_NOT_FOUND_RE = /^Tool (\S+) not found/;

// Gap 3 (per-turn): fixed classification lists, checked by membership only.
export const EXPLORATION_TOOLS: readonly string[] = ["read", "grep", "glob", "find", "task", "hub", "ls"];
export const MUTATION_TOOLS: readonly string[] = ["edit", "write", "ast_edit", "notebook_edit"];

/** Classifies a stopReason:"error" assistant turn from the provider's own message. */
export function classifyErrorMessage(text: string): string {
	if (/429|rate_limit/i.test(text)) return "rate_limit";
	if (/quota/i.test(text)) return "quota";
	if (/401|api key|invalidated|unauthori[sz]ed/i.test(text)) return "auth";
	return "other";
}

// Why: browser automation mostly runs through `eval` (the `browser` global),
// so counting errors by tool name blamed the browser's failures on eval and
// produced "stop scripting in eval" advice. Attribution is by the call's
// input (its code), never by matching the error text.
const BROWSER_IN_CODE_RE = /\bbrowser\s*\./;

// Why: a session left open for days spans its whole wall-clock life, so
// [start, end] read as ~23h/day. Activity is the run of message records
// (user, assistant, toolResult); a gap longer than this ends the run. 15 min
// covers a long tool call or a slow model turn without bridging idle hours.
export const ACTIVE_GAP_MINUTES = 15;

/** Merges activity timestamps into [startISO, endISO] runs; no padding, so a lone record adds 0. */
export function activityIntervals(timestamps: number[]): Array<[string, string]> {
	const sorted = [...timestamps].sort((a, b) => a - b);
	const runs: Array<[string, string]> = [];
	let start = sorted[0];
	let end = start;
	for (const ts of sorted.slice(1)) {
		if (ts - end! > ACTIVE_GAP_MINUTES * 60_000) {
			runs.push([new Date(start!).toISOString(), new Date(end!).toISOString()]);
			start = ts;
		}
		end = ts;
	}
	if (start !== undefined) runs.push([new Date(start).toISOString(), new Date(end!).toISOString()]);
	return runs;
}

/** Lowercase word-token Jaccard overlap, used to tell a rephrase from a new ask. */
export function jaccardOverlap(a: string, b: string): number {
	const ta = new Set(a.toLowerCase().match(/\w+/g) ?? []);
	const tb = new Set(b.toLowerCase().match(/\w+/g) ?? []);
	if (!ta.size && !tb.size) return 0;
	let inter = 0;
	for (const t of ta) if (tb.has(t)) inter++;
	const union = new Set([...ta, ...tb]).size;
	return union > 0 ? inter / union : 0;
}

export const ABORT_COURSE_CORRECTION_RE = /^(no|nope|wait|stop|not that|instead|actually|hold on)\b/i;

/**
 * Aborts cannot be labelled with certainty from structure alone; this is a
 * first-pass guess that the facet LLM pass can later override per event.
 */
export function computeAbortHeuristicLabel(
	prevHumanText: string,
	nextUserText: string | null,
	toolCallsBeforeAbort: number,
	gapSec: number | null,
): AbortEvent["heuristic_label"] {
	if (nextUserText && ABORT_COURSE_CORRECTION_RE.test(nextUserText.trim()))
		return "course_correction";
	if (
		toolCallsBeforeAbort === 0 &&
		gapSec !== null &&
		gapSec < 60 &&
		nextUserText &&
		jaccardOverlap(prevHumanText, nextUserText) >= 0.5
	)
		return "user_rephrased";
	if (gapSec === null || gapSec > 300) return "abandoned";
	return "unknown";
}

/**
 * Sidecar logs (advisor, subagents) are separate sessions with their own
 * spend. Only that spend and their tool volume are folded into the parent:
 * their "user" messages are prompts omp wrote, so counting them as human
 * activity would corrupt message counts, response times and hour-of-day.
 */
export function extractSidecarUsage(entries: AnyEntry[]): SidecarUsage {
	const totals: UsageRecord = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, costInput: 0, costOutput: 0 };
	const modelUsage: ModelUsageMap = {};
	let utilityCost = 0;
	let toolCalls = 0;
	let toolErrors = 0;

	for (const entry of entries) {
		if (entry.type === "model_usage") {
			const usage = readUsage(entry.usage);
			addUsage(totals, usage);
			utilityCost += usage.cost;
			accumulateModel(modelUsage, typeof entry.model === "string" ? entry.model : "unknown", usage);
			continue;
		}
		if (entry.type !== "message") continue;
		const msg = entry.message as AnyMessage | undefined;
		if (!msg) continue;

		if (msg.role === "assistant") {
			const usage = readUsage(msg.usage);
			addUsage(totals, usage);
			accumulateModel(modelUsage, typeof msg.model === "string" ? msg.model : "unknown", usage);
			if (Array.isArray(msg.content)) {
				for (const block of msg.content as ContentBlock[]) {
					if (block.type === "toolCall") toolCalls++;
				}
			}
		} else if (msg.role === "toolResult" && msg.isError === true) {
			toolErrors++;
		}
	}

	return { totals, utility_cost: utilityCost, model_usage: modelUsage, tool_calls: toolCalls, tool_errors: toolErrors };
}

export function extractSessionStats(entries: AnyEntry[]) {
	const toolCounts: Record<string, number> = {};
	const languages: Record<string, number> = {};
	const toolErrorCategories: Record<string, number> = {};
	const filesModified = new Set<string>();
	const userResponseTimes: number[] = [];
	const messageHours: number[] = [];
	const userMessageTimestamps: string[] = [];
	const ttfts: number[] = [];
	const responseDurations: number[] = [];
	const totals: UsageRecord = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, costInput: 0, costOutput: 0 };
	const modelUsage: ModelUsageMap = {};
	const toolCallsByTool: Record<string, number> = {};
	const toolErrorsByTool: Record<string, number> = {};
	const toolNotFoundByTool: Record<string, number> = {};
	// toolCallIds of eval calls whose code drives the `browser` global.
	const browserEvalCalls = new Set<string>();
	const activityTs: number[] = [];
	// Pre-seeded so every class reads as 0 rather than undefined when absent.
	const errorClasses: Record<string, number> = { rate_limit: 0, quota: 0, auth: 0, other: 0 };
	const ttsrRules: Record<string, number> = {};
	const abortEvents: AbortEvent[] = [];
	const pendingAborts: Array<{ event: AbortEvent; prevHumanText: string }> = [];
	const turns: TurnStats[] = [];
	let turnStartTs: number | null = null;
	let turnPrompt = "";
	let turnRoundTrips = 0;
	let turnToolResultCount = 0;
	let turnExplorationBeforeMutation = 0;
	let turnMutated = false;
	let turnCost = 0;
	let turnLastAssistantCompletedAt: number | null = null;
	let turnLastAssistantEntryTs: number | null = null;
	let turnLastAssistantAborted = false;
	let turnLastToolResultTs: number | null = null;
	const editsByFile: Record<string, number> = {};
	// toolCallId -> startedAt(ms); paired against the matching toolResult to
	// get per-tool wall-clock. `intent` is only present when intent tracing is
	// turned on, so its presence is counted (never assumed from a fixed date)
	// and the prose only mentions it when the corpus actually carries it.
	const toolCallStarts = new Map<string, { toolName: string; startedAtMs: number }>();
	let toolCallsWithIntent = 0;
	const toolDurationSamples: Record<string, number[]> = {};

	/**
	 * Ends the in-progress turn (if any) and records it. Preference order for
	 * the turn's end time: the last assistant message's `completedAt`, then
	 * that same message's envelope timestamp (completedAt is absent on
	 * roughly a fifth of assistant rows), then the last toolResult's
	 * timestamp if the turn had no assistant message at all.
	 */
	function finalizeCurrentTurn(): void {
		if (turnStartTs === null) return;
		let endTs: number | null = null;
		if (turnLastAssistantEntryTs !== null) {
			endTs = turnLastAssistantCompletedAt !== null ? turnLastAssistantCompletedAt : turnLastAssistantEntryTs;
		} else if (turnLastToolResultTs !== null) {
			endTs = turnLastToolResultTs;
		}
		const wallSec = endTs !== null ? Math.max(0, (endTs - turnStartTs) / 1000) : 0;
		turns.push({
			start_ts: new Date(turnStartTs).toISOString(),
			prompt: turnPrompt,
			llm_round_trips: turnRoundTrips,
			tool_calls: turnToolResultCount,
			exploration_before_first_mutation: turnExplorationBeforeMutation,
			mutated: turnMutated,
			wall_sec: wallSec,
			cost: turnCost,
			aborted: turnLastAssistantAborted,
		});
	}

	let sessionId = "";
	let sessionStart = "";
	let projectPath = "";
	let lastEntryTs = 0;
	let utilityCost = 0;
	let gitCommits = 0;
	let gitPushes = 0;
	let steeringMessages = 0;
	let toolErrors = 0;
	let usesSubagent = false;
	let usesMcp = false;
	let linesAdded = 0;
	let linesRemoved = 0;
	let userMessageCount = 0;
	let assistantMessageCount = 0;
	let thinkingEscalations = 0;
	let modelSwitches = 0;
	let compactions = 0;
	let firstPrompt = "";
	let lastAssistantTs: number | null = null;
	let errorGenerations = 0;
	let abortedGenerations = 0;
	let ttsrInjections = 0;
	let resetBoundaries = 0;
	let turnToolCalls = 0;
	let lastHumanText = "";
	let lastHumanTs: number | null = null;
	let lastMessageIsAbortedAssistant = false;

	// Deduplicate tool call IDs to avoid double-counting branched entries
	const seenToolCallIds = new Set<string>();

	for (const entry of entries) {
		const entryTs =
			typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
		if (!Number.isNaN(entryTs) && entryTs > lastEntryTs) lastEntryTs = entryTs;

		if (entry.type === "session") {
			// The session record is authoritative for id, start time and project.
			if (typeof entry.id === "string") sessionId = entry.id;
			if (typeof entry.timestamp === "string") sessionStart = entry.timestamp;
			if (typeof entry.cwd === "string") projectPath = entry.cwd;
			continue;
		}
		// Mid-session escalation: a behavioural signal Pi had no equivalent for.
		if (entry.type === "thinking_level_change") {
			thinkingEscalations++;
			continue;
		}
		if (entry.type === "model_change") {
			modelSwitches++;
			continue;
		}
		if (entry.type === "compaction") {
			compactions++;
			continue;
		}
		if (entry.type === "ttsr_injection") {
			ttsrInjections++;
			const rules = Array.isArray(entry.injectedRules) ? (entry.injectedRules as unknown[]) : [];
			for (const r of rules) if (typeof r === "string" && r) ttsrRules[r] = (ttsrRules[r] ?? 0) + 1;
			continue;
		}
		if (entry.type === "reset_boundary") {
			resetBoundaries++;
			continue;
		}
		if (entry.type === "custom" && entry.customType === "tool_execution_start") {
			const data = entry.data as Record<string, unknown> | undefined;
			const toolCallId = typeof data?.toolCallId === "string" ? data.toolCallId : "";
			const toolNameStart = typeof data?.toolName === "string" ? data.toolName : "";
			const startedAtRaw = data?.startedAt;
			const startedAtMs =
				typeof startedAtRaw === "number"
					? startedAtRaw
					: typeof startedAtRaw === "string"
						? Date.parse(startedAtRaw)
						: Number.NaN;
			if (toolCallId && toolNameStart && !Number.isNaN(startedAtMs)) {
				toolCallStarts.set(toolCallId, { toolName: toolNameStart, startedAtMs });
			}
			if (typeof data?.intent === "string" && data.intent) toolCallsWithIntent++;
			continue;
		}
		if (entry.type === "model_usage") {
			const usage = readUsage(entry.usage);
			addUsage(totals, usage);
			utilityCost += usage.cost;
			accumulateModel(modelUsage, typeof entry.model === "string" ? entry.model : "unknown", usage);
			continue;
		}
		if (entry.type !== "message") continue;
		if (!Number.isNaN(entryTs)) activityTs.push(entryTs);

		const msg = entry.message as AnyMessage | undefined;
		if (!msg) continue;

		// Assistant/user messages carry epoch-ms timestamps; fall back to the
		// envelope's ISO timestamp for records that do not.
		const msgTs =
			typeof msg.timestamp === "number"
				? msg.timestamp
				: Number.isNaN(entryTs)
					? null
					: entryTs;
		let thisEntryAborted = false;

		// ── assistant message ──
		if (msg.role === "assistant") {
			assistantMessageCount++;
			if (msgTs) lastAssistantTs = msgTs;
			// omp records the provider stop reason on every assistant turn: an
			// "aborted" generation is the strongest correction signal in the
			// corpus (user killed it mid-flight); "error" is a provider failure.
			const stopReason = typeof msg.stopReason === "string" ? msg.stopReason : "";
			if (stopReason === "aborted") {
				abortedGenerations++;
				thisEntryAborted = true;
				const abortTs = msgTs ?? (Number.isNaN(entryTs) ? null : entryTs);
				const event: AbortEvent = {
					ts: abortTs !== null ? new Date(abortTs).toISOString() : "",
					tool_calls_before_abort: turnToolCalls,
					elapsed_sec:
						abortTs !== null && lastHumanTs !== null ? (abortTs - lastHumanTs) / 1000 : 0,
					partial_text: extractTextFromContent(msg.content).trim().slice(0, 200),
					next_user_text: null,
					gap_sec: null,
					heuristic_label: "unknown",
				};
				if (abortEvents.length < 10) {
					abortEvents.push(event);
					pendingAborts.push({ event, prevHumanText: lastHumanText });
				}
			} else if (stopReason === "error") {
				errorGenerations++;
				const errText =
					typeof msg.errorMessage === "string" && msg.errorMessage
						? msg.errorMessage
						: extractTextFromContent(msg.content);
				const cls = classifyErrorMessage(errText);
				errorClasses[cls] = (errorClasses[cls] ?? 0) + 1;
			}

			const usage = readUsage(msg.usage);
			addUsage(totals, usage);
			accumulateModel(modelUsage, typeof msg.model === "string" ? msg.model : "unknown", usage);
			if (turnStartTs !== null) {
				turnRoundTrips++;
				turnCost += usage.cost;
				turnLastAssistantAborted = stopReason === "aborted";
				turnLastAssistantCompletedAt = typeof msg.completedAt === "number" ? msg.completedAt : null;
				turnLastAssistantEntryTs = !Number.isNaN(entryTs) ? entryTs : (msgTs ?? turnLastAssistantEntryTs);
			}

			if (typeof msg.ttft === "number" && msg.ttft > 0) ttfts.push(msg.ttft);
			if (typeof msg.duration === "number" && msg.duration > 0)
				responseDurations.push(msg.duration);

			// Tool calls inside content
			const content = msg.content;
			if (Array.isArray(content)) {
				for (const block of content as ContentBlock[]) {
					if (block.type !== "toolCall") continue;
					const toolName = (block.name as string) ?? "";
					const toolId = (block.id as string) ?? Math.random().toString(36);

					if (seenToolCallIds.has(toolId)) continue;
					seenToolCallIds.add(toolId);
					turnToolCalls++;

					const args = (block.arguments as Record<string, unknown>) ?? {};
					if (toolName === "eval" && typeof args.code === "string" && BROWSER_IN_CODE_RE.test(args.code))
						browserEvalCalls.add(toolId);
					const filePath = typeof args.path === "string" ? args.path : "";

					// omp routes MCP servers and tool devices through a write to
					// `xd://<device>`. Counting those as file writes would both
					// inflate write volume and hide MCP/device usage entirely.
					const device = filePath.startsWith("xd://")
						? filePath.slice(5).split(/[/?:]/)[0]!
						: "";
					if (toolName === "write" && device) {
						toolCounts[`xd://${device}`] = (toolCounts[`xd://${device}`] ?? 0) + 1;
						if (device.startsWith("mcp__")) usesMcp = true;
						continue;
					}

					toolCounts[toolName] = (toolCounts[toolName] ?? 0) + 1;
					if (toolName === "task") usesSubagent = true;
					if (toolName.startsWith("mcp__")) usesMcp = true;

					if (toolName === "read" || toolName === "write") {
						// Strip any read selector (`file.ts:10-20`) before the extension lookup.
						const clean = filePath.replace(/:[^/\\]*$/, "");
						const lang = getLanguageFromPath(clean);
						if (lang) languages[lang] = (languages[lang] ?? 0) + 1;
					}

					if (toolName === "write" && filePath) {
						filesModified.add(filePath);
						editsByFile[filePath] = (editsByFile[filePath] ?? 0) + 1;
						linesAdded += countNewlines((args.content as string) ?? "") + 1;
					}

					if (toolName === "edit") {
						// omp's edit tool takes one hashline patch in `input`: sections
						// are `[path#TAG]`, `+` rows are the new content, and
						// `PUT a.=b` / `CUT a.=b` name the original lines replaced.
						const patch = (args.input as string) ?? "";
						for (const line of patch.split("\n")) {
							const section = line.match(/^\[([^\]]+)#[0-9A-Fa-f]{4}\]$/);
							if (section) {
								const path = section[1]!;
								filesModified.add(path);
								editsByFile[path] = (editsByFile[path] ?? 0) + 1;
								const lang = getLanguageFromPath(path);
								if (lang) languages[lang] = (languages[lang] ?? 0) + 1;
								continue;
							}
							const range = line.match(/^(?:PUT|CUT)\s+(\d+)\.=(\d+)/);
							if (range) {
								linesRemoved += Number(range[2]) - Number(range[1]) + 1;
								continue;
							}
							if (line.startsWith("+")) linesAdded++;
							else if (line.startsWith("-") && !line.startsWith("---")) linesRemoved++;
						}
					}

					if (toolName === "bash") {
						const cmd = (args.command as string) ?? "";
						if (cmd.includes("git commit")) gitCommits++;
						if (cmd.includes("git push")) gitPushes++;
					}
				}
			}
		}

		// ── user message (human) ──
		if (msg.role === "user" && isHumanMessage(msg)) {
			userMessageCount++;
			const text = extractTextFromContent(msg.content);

			if (!firstPrompt && text.trim()) firstPrompt = text.trim().slice(0, 300);

			// omp flags interruptions structurally: `steering` is set when the
			// user typed while the agent was still working.
			if (msg.steering) steeringMessages++;
			// Resolve any abort(s) still waiting on "what did the user say next".
			if (pendingAborts.length) {
				const nextText = text.trim().slice(0, 200);
				for (const pending of pendingAborts) {
					pending.event.next_user_text = nextText;
					const abortTsMs = Date.parse(pending.event.ts);
					const gapSec =
						msgTs !== null && !Number.isNaN(abortTsMs) ? (msgTs - abortTsMs) / 1000 : null;
					pending.event.gap_sec = gapSec;
					pending.event.heuristic_label = computeAbortHeuristicLabel(
						pending.prevHumanText,
						nextText,
						pending.event.tool_calls_before_abort,
						gapSec,
					);
				}
				pendingAborts.length = 0;
			}
			turnToolCalls = 0;
			lastHumanText = text;
			lastHumanTs = msgTs;
			// Gap 3: a turn runs from one human message up to (not including) the next.
			if (msgTs) {
				finalizeCurrentTurn();
				turnStartTs = msgTs;
				turnPrompt = text.trim().slice(0, 120);
				turnRoundTrips = 0;
				turnToolResultCount = 0;
				turnExplorationBeforeMutation = 0;
				turnMutated = false;
				turnCost = 0;
				turnLastAssistantCompletedAt = null;
				turnLastAssistantEntryTs = null;
				turnLastAssistantAborted = false;
				turnLastToolResultTs = null;
			}

			if (msgTs) {
				const d = new Date(msgTs);
				messageHours.push(d.getHours());
				userMessageTimestamps.push(d.toISOString());

				if (lastAssistantTs !== null) {
					const gapSec = (msgTs - lastAssistantTs) / 1000;
					if (gapSec > 2 && gapSec < 3600) userResponseTimes.push(gapSec);
				}
			}
		}

		// ── tool result ──
		// Denominator and error counts both come from toolResult messages, not
		// the assistant's toolCall blocks (which `toolCounts` uses and which
		// rewrites xd:// writes to a device key); the two must not be mixed.
		if (msg.role === "toolResult") {
			const toolNameRaw = typeof msg.toolName === "string" ? msg.toolName : "";
			const toolKey = toolNameRaw.trim() || "unknown";
			const toolCallId = typeof msg.toolCallId === "string" ? msg.toolCallId : "";
			if (toolCallId) {
				const start = toolCallStarts.get(toolCallId);
				if (start) {
					const resultTsForDuration = msgTs ?? (Number.isNaN(entryTs) ? null : entryTs);
					if (resultTsForDuration !== null) {
						const durationSec = Math.max(0, (resultTsForDuration - start.startedAtMs) / 1000);
						const durationKey = start.toolName || toolKey;
						(toolDurationSamples[durationKey] ??= []).push(durationSec);
					}
					toolCallStarts.delete(toolCallId);
				}
			}
			if (turnStartTs !== null) {
				turnToolResultCount++;
				const resultTs = msgTs ?? (Number.isNaN(entryTs) ? null : entryTs);
				if (resultTs !== null) turnLastToolResultTs = resultTs;
				if (!turnMutated) {
					const toolNameLower = toolNameRaw.trim().toLowerCase();
					if (MUTATION_TOOLS.includes(toolNameLower)) turnMutated = true;
					else if (EXPLORATION_TOOLS.includes(toolNameLower)) turnExplorationBeforeMutation++;
				}
			}
			const resultText = msg.isError === true ? extractTextFromContent(msg.content).trim() : "";
			// Rates are keyed by what the call was for, not which tool ran it.
			const rateKey =
				toolKey === "eval" && browserEvalCalls.has(toolCallId)
					? "browser"
					: toolKey;
			if (msg.isError === true) {
				const notFoundMatch = resultText.match(TOOL_NOT_FOUND_RE);
				if (notFoundMatch) {
					// The model invented a tool name; the harness's reply names it in
					// the text, which is authoritative over `toolName` (some replies
					// carry a different/placeholder toolName for an unknown call).
					const invented = notFoundMatch[1]!;
					toolNotFoundByTool[invented] = (toolNotFoundByTool[invented] ?? 0) + 1;
				} else {
					toolCallsByTool[rateKey] = (toolCallsByTool[rateKey] ?? 0) + 1;
					toolErrorsByTool[rateKey] = (toolErrorsByTool[rateKey] ?? 0) + 1;
					toolErrors++;
					const cat = toolErrorCategory(rateKey === "browser" ? "browser" : toolNameRaw);
					toolErrorCategories[cat] = (toolErrorCategories[cat] ?? 0) + 1;
				}
			} else {
				toolCallsByTool[rateKey] = (toolCallsByTool[rateKey] ?? 0) + 1;
			}
		}
		lastMessageIsAbortedAssistant = thisEntryAborted;
	}
	finalizeCurrentTurn();

	// Any abort never followed by another human message has no "next ask" to
	// judge against; that absence of a gap is itself the "abandoned" signal.
	for (const pending of pendingAborts) {
		pending.event.heuristic_label = computeAbortHeuristicLabel(
			pending.prevHumanText,
			null,
			pending.event.tool_calls_before_abort,
			null,
		);
	}

	return {
		sessionId,
		sessionStart,
		projectPath,
		lastEntryTs,
		toolCounts,
		languages,
		toolErrorCategories,
		filesModified: filesModified.size,
		userResponseTimes,
		messageHours,
		userMessageTimestamps,
		activeIntervals: activityIntervals(activityTs),
		ttfts,
		responseDurations,
		gitCommits,
		gitPushes,
		totals,
		utilityCost,
		steeringMessages,
		toolErrors,
		usesSubagent,
		usesMcp,
		linesAdded,
		linesRemoved,
		userMessageCount,
		assistantMessageCount,
		thinkingEscalations,
		modelSwitches,
		compactions,
		firstPrompt,
		modelUsage,
		tool_calls_by_tool: toolCallsByTool,
		tool_errors_by_tool: toolErrorsByTool,
		tool_not_found: toolNotFoundByTool,
		error_classes: errorClasses,
		error_generations: errorGenerations,
		aborted_generations: abortedGenerations,
		aborted_at_session_end: lastMessageIsAbortedAssistant ? 1 : 0,
		ttsr_injections: ttsrInjections,
		ttsr_rules: ttsrRules,
		reset_boundaries: resetBoundaries,
		abort_events: abortEvents,
		turns,
		edits_by_file: editsByFile,
		tool_duration_samples: toolDurationSamples,
		tool_calls_with_intent: toolCallsWithIntent,
	};
}

/**
 * Fold a session and its sidecars into one SessionMeta. Cost is attributed to
 * the parent and broken out per class, so a run's total can be reconciled
 * against the logs while still showing where the money went.
 */
export function buildSessionMeta(
	ref: SessionRef,
	entries: AnyEntry[],
	sidecars: Array<{ kind: SidecarKind; usage: SidecarUsage }>,
): SessionMeta {
	const stats = extractSessionStats(entries);

	const startTime = stats.sessionStart || ref.created.toISOString();
	const endMs = stats.lastEntryTs || ref.modified.getTime();
	const totals: UsageRecord = { ...stats.totals };
	const modelUsage: ModelUsageMap = stats.modelUsage;

	let costAdvisor = 0;
	let costSubagent = 0;
	let utilityCost = stats.utilityCost;
	let sidecarToolCalls = 0;
	let sidecarToolErrors = 0;
	const sidecarCounts = { advisor: 0, subagent: 0 };

	for (const sidecar of sidecars) {
		sidecarCounts[sidecar.kind]++;
		addUsage(totals, sidecar.usage.totals);
		utilityCost += sidecar.usage.utility_cost;
		sidecarToolCalls += sidecar.usage.tool_calls;
		sidecarToolErrors += sidecar.usage.tool_errors;
		if (sidecar.kind === "advisor") costAdvisor += sidecar.usage.totals.cost;
		else costSubagent += sidecar.usage.totals.cost;
		for (const [model, usage] of Object.entries(sidecar.usage.model_usage)) {
			accumulateModel(modelUsage, model, {
				input: usage.input_tokens,
				output: usage.output_tokens,
				cacheRead: 0,
				cacheWrite: 0,
				cost: usage.cost,
				costInput: usage.cost_input ?? 0,
				costOutput: usage.cost_output ?? 0,
			});
			// accumulateModel counts one message; restore the real count.
			modelUsage[model]!.message_count += usage.message_count - 1;
		}
	}
	// Percentiles and the worst 5 are persisted; the full per-turn list is not
	// (mirrors how ttfts/responseDurations are reduced to medians below).
	const turnRoundTrips = stats.turns.map((t) => t.llm_round_trips);
	const turnToolCallCounts = stats.turns.map((t) => t.tool_calls);
	const turnExploration = stats.turns.map((t) => t.exploration_before_first_mutation);
	const turnWallSec = stats.turns.map((t) => t.wall_sec);
	const turnP50: TurnPercentiles = {
		round_trips: percentile(turnRoundTrips, 50),
		tool_calls: percentile(turnToolCallCounts, 50),
		exploration: percentile(turnExploration, 50),
		wall_sec: percentile(turnWallSec, 50),
	};
	const turnP90: TurnPercentiles = {
		round_trips: percentile(turnRoundTrips, 90),
		tool_calls: percentile(turnToolCallCounts, 90),
		exploration: percentile(turnExploration, 90),
		wall_sec: percentile(turnWallSec, 90),
	};
	const worstTurns = [...stats.turns].sort((a, b) => b.tool_calls - a.tool_calls).slice(0, 5);

	const toolDurationByTool: Record<string, { calls: number; total_sec: number; p50_sec: number; p90_sec: number }> = {};
	for (const [tool, samples] of Object.entries(stats.tool_duration_samples)) {
		toolDurationByTool[tool] = {
			calls: samples.length,
			total_sec: samples.reduce((a, b) => a + b, 0),
			p50_sec: percentile(samples, 50),
			p90_sec: percentile(samples, 90),
		};
	}
	const toolDurationTotalSec = Object.values(toolDurationByTool).reduce((a, d) => a + d.total_sec, 0);
	const toolTimeShare = Object.entries(toolDurationByTool)
		.map(([tool, d]) => ({
			tool,
			total_sec: d.total_sec,
			share: toolDurationTotalSec > 0 ? d.total_sec / toolDurationTotalSec : 0,
		}))
		.sort((a, b) => b.share - a.share);

	const editsByFileCapped = Object.fromEntries(
		Object.entries(stats.edits_by_file)
			.sort((a, b) => b[1] - a[1])
			.slice(0, 20),
	);

	// Primary-session-only (not sidecar-folded): this is about the resumed-
	// stale-session tax on the main conversation, not advisor/subagent spend.
	const cacheHitRatio =
		stats.totals.input + stats.totals.cacheRead > 0
			? stats.totals.cacheRead / (stats.totals.input + stats.totals.cacheRead)
			: 0;

	return {
		session_id: stats.sessionId || ref.id,
		session_path: ref.path,
		project_path: stats.projectPath || ref.project_path,
		start_time: startTime,
		duration_minutes: Math.max(
			0,
			Math.round((endMs - new Date(startTime).getTime()) / 1000 / 60),
		),
		user_message_count: stats.userMessageCount,
		assistant_message_count: stats.assistantMessageCount,
		tool_counts: stats.toolCounts,
		languages: stats.languages,
		git_commits: stats.gitCommits,
		git_pushes: stats.gitPushes,
		input_tokens: totals.input,
		output_tokens: totals.output,
		total_cost: totals.cost,
		first_prompt: stats.firstPrompt,
		user_interruptions: stats.steeringMessages,
		user_response_times: stats.userResponseTimes,
		tool_errors: stats.toolErrors,
		tool_error_categories: stats.toolErrorCategories,
		uses_subagent: stats.usesSubagent || sidecarCounts.subagent > 0,
		uses_mcp: stats.usesMcp,
		lines_added: stats.linesAdded,
		lines_removed: stats.linesRemoved,
		files_modified: stats.filesModified,
		message_hours: stats.messageHours,
		user_message_timestamps: stats.userMessageTimestamps,
		active_intervals: stats.activeIntervals,
		cost_primary: stats.totals.cost,
		cost_advisor: costAdvisor,
		cost_subagent: costSubagent,
		cache_read_tokens: totals.cacheRead,
		cache_write_tokens: totals.cacheWrite,
		utility_cost: utilityCost,
		sidecar_counts: sidecarCounts,
		sidecar_tool_calls: sidecarToolCalls,
		sidecar_tool_errors: sidecarToolErrors,
		thinking_escalations: stats.thinkingEscalations,
		model_switches: stats.modelSwitches,
		compactions: stats.compactions,
		steering_messages: stats.steeringMessages,
		log_signature: ref.signature,
		cost_recorded: true,
		median_ttft_ms: median(stats.ttfts),
		median_response_ms: median(stats.responseDurations),
		model_usage: modelUsage,
		tool_calls_by_tool: stats.tool_calls_by_tool,
		tool_errors_by_tool: stats.tool_errors_by_tool,
		tool_not_found: stats.tool_not_found,
		error_classes: stats.error_classes,
		error_generations: stats.error_generations,
		aborted_generations: stats.aborted_generations,
		aborted_at_session_end: stats.aborted_at_session_end,
		ttsr_injections: stats.ttsr_injections,
		ttsr_rules: stats.ttsr_rules,
		reset_boundaries: stats.reset_boundaries,
		abort_events: stats.abort_events,
		turn_count: stats.turns.length,
		turn_p50: turnP50,
		turn_p90: turnP90,
		worst_turns: worstTurns,
		tool_duration_by_tool: toolDurationByTool,
		tool_time_share: toolTimeShare,
		tool_calls_with_intent: stats.tool_calls_with_intent,
		cache_hit_ratio: cacheHitRatio,
		edits_by_file: editsByFileCapped,
	};
}
