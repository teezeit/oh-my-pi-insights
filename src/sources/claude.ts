// SPDX-FileCopyrightText: 2026 Hari Srinivasan <harisrini21@gmail.com>
// SPDX-FileCopyrightText: 2026 Tobias Hoelzer (omp port)
// SPDX-License-Identifier: AGPL-3.0-only


// The Claude Code SessionSource (--source claude): reads
// ~/.claude/projects, a flat-log layout with no sidecar directories.
// Verified traps are documented inline: partial cost-state coverage,
// deduplicated requestIds, tool_result naming a tool_use_id not a tool.

import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { readJsonl } from "./omp.ts";
import type { DirEntry } from "./omp.ts";
import { activityIntervals, countNewlines, extractSidecarUsage, getLanguageFromPath, isMetaSession, toolErrorCategory } from "../stats.ts";
import type {
	AnyEntry,
	AnyMessage,
	ContentBlock,
	ModelUsageMap,
	SessionMeta,
	SessionRef,
	SessionScan,
	SessionSource,
	SidecarKind,
	UsageRecord,
} from "../types.ts";

// ~/.claude/projects/<slugified-cwd>/<session-uuid>.jsonl — one flat log per
// session, no sidecar directories: subagent turns are inline entries flagged
// `isSidechain`.
//
// Differences that matter, all verified against the real corpus:
// - Cost lives in periodic `cost-state` records (`totalCostUSD` plus per-model
//   `costUSD`), not on each message. The last one wins. Only some sessions
//   carry any, and a session without one has NO recorded cost — it is reported
//   as unavailable rather than silently counted as $0, and never estimated
//   from tokens, which is the workaround this port exists to avoid.
// - One API response can be logged as several assistant entries sharing a
//   `requestId`, so usage is deduplicated by it before summing.
// - Tool results are `tool_result` blocks on user messages with `is_error`.

export const CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");

export type ClaudeCostState = {
	totalCostUSD?: number;
	totalLinesAdded?: number;
	totalLinesRemoved?: number;
	modelUsage?: Record<
		string,
		{
			inputTokens?: number;
			outputTokens?: number;
			cacheReadInputTokens?: number;
			cacheCreationInputTokens?: number;
			costUSD?: number;
		}
	>;
};

export function claudeText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return (content as ContentBlock[])
		.filter((b) => b.type === "text" && typeof b.text === "string")
		.map((b) => b.text as string)
		.join(" ");
}

export function extractClaudeStats(entries: AnyEntry[]) {
	const toolCounts: Record<string, number> = {};
	const languages: Record<string, number> = {};
	const toolErrorCategories: Record<string, number> = {};
	const filesModified = new Set<string>();
	const userResponseTimes: number[] = [];
	const messageHours: number[] = [];
	const userMessageTimestamps: string[] = [];
	const modelUsage: ModelUsageMap = {};
	const seenRequestIds = new Set<string>();
	const seenToolUseIds = new Set<string>();
	// tool_result blocks name only the tool_use_id, so the tool itself has to
	// be remembered from the assistant turn that called it.
	const toolNameById = new Map<string, string>();

	let sessionId = "";
	let projectPath = "";
	let firstTs = 0;
	let lastTs = 0;
	let costState: ClaudeCostState | null = null;
	let gitCommits = 0;
	let gitPushes = 0;
	let toolErrors = 0;
	let usesSubagent = false;
	let usesMcp = false;
	let linesAdded = 0;
	let linesRemoved = 0;
	let userMessageCount = 0;
	let assistantMessageCount = 0;
	let firstPrompt = "";
	let lastAssistantTs: number | null = null;
	const totals: UsageRecord = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, costInput: 0, costOutput: 0 };
	const activityTs: number[] = [];

	for (const entry of entries) {
		if (typeof entry.sessionId === "string" && !sessionId) sessionId = entry.sessionId;
		if (typeof entry.cwd === "string" && !projectPath) projectPath = entry.cwd;

		const ts = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
		if (!Number.isNaN(ts)) {
			if (!firstTs) firstTs = ts;
			if (ts > lastTs) lastTs = ts;
			// Tool results are "user" entries in Claude Code logs, so both roles cover all activity.
			if (entry.type === "user" || entry.type === "assistant") activityTs.push(ts);
		}

		if (entry.type === "cost-state") {
			costState = entry as ClaudeCostState;
			continue;
		}

		const msg = entry.message as AnyMessage | undefined;
		if (!msg) continue;

		if (entry.type === "assistant") {
			assistantMessageCount++;
			if (!Number.isNaN(ts)) lastAssistantTs = ts;

			// Retries and multi-part logging repeat a response; count each once.
			const requestId = typeof entry.requestId === "string" ? entry.requestId : "";
			const counted = requestId && seenRequestIds.has(requestId);
			if (requestId) seenRequestIds.add(requestId);

			const u = (msg.usage ?? {}) as Record<string, number>;
			if (!counted) {
				totals.input += u.input_tokens ?? 0;
				totals.output += u.output_tokens ?? 0;
				totals.cacheRead += u.cache_read_input_tokens ?? 0;
				totals.cacheWrite += u.cache_creation_input_tokens ?? 0;
			}

			for (const block of (Array.isArray(msg.content) ? msg.content : []) as ContentBlock[]) {
				if (block.type !== "tool_use") continue;
				const toolId = (block.id as string) ?? Math.random().toString(36);
				if (seenToolUseIds.has(toolId)) continue;
				seenToolUseIds.add(toolId);

				const toolName = (block.name as string) ?? "";
				toolCounts[toolName] = (toolCounts[toolName] ?? 0) + 1;
				toolNameById.set(toolId, toolName);
				if (toolName === "Task") usesSubagent = true;
				if (toolName.startsWith("mcp__")) usesMcp = true;

				const args = (block.input as Record<string, unknown>) ?? {};
				const filePath =
					(typeof args.file_path === "string" && args.file_path) ||
					(typeof args.path === "string" && args.path) ||
					"";
				if (filePath && /^(Read|Write|Edit|NotebookEdit)$/.test(toolName)) {
					const lang = getLanguageFromPath(filePath);
					if (lang) languages[lang] = (languages[lang] ?? 0) + 1;
				}
				if (filePath && /^(Write|Edit|NotebookEdit)$/.test(toolName)) filesModified.add(filePath);
				if (toolName === "Write") linesAdded += countNewlines((args.content as string) ?? "") + 1;
				if (toolName === "Edit") {
					linesAdded += countNewlines((args.new_string as string) ?? "") + 1;
					linesRemoved += countNewlines((args.old_string as string) ?? "") + 1;
				}
				if (toolName === "Bash") {
					const cmd = (args.command as string) ?? "";
					if (cmd.includes("git commit")) gitCommits++;
					if (cmd.includes("git push")) gitPushes++;
				}
			}
			continue;
		}

		if (entry.type !== "user") continue;

		const blocks = (Array.isArray(msg.content) ? msg.content : []) as ContentBlock[];
		const results = blocks.filter((b) => b.type === "tool_result");
		if (results.length) {
			for (const result of results) {
				if (result.is_error !== true) continue;
				toolErrors++;
				const cat = toolErrorCategory(
					toolNameById.get(result.tool_use_id as string) ?? "",
				);
				toolErrorCategories[cat] = (toolErrorCategories[cat] ?? 0) + 1;
			}
			continue;
		}

		// Sidechain turns are subagent prompts and meta entries are injected
		// notices; neither is the human typing.
		if (entry.isSidechain === true) {
			usesSubagent = true;
			continue;
		}
		if (entry.isMeta === true) continue;

		const text = claudeText(msg.content);
		if (!text.trim()) continue;
		userMessageCount++;
		if (!firstPrompt) firstPrompt = text.trim().slice(0, 300);
		if (!Number.isNaN(ts)) {
			messageHours.push(new Date(ts).getHours());
			userMessageTimestamps.push(new Date(ts).toISOString());
			if (lastAssistantTs !== null) {
				const gapSec = (ts - lastAssistantTs) / 1000;
				if (gapSec > 2 && gapSec < 3600) userResponseTimes.push(gapSec);
			}
		}
	}

	// Cost is only ever read, never derived. A session with no cost-state has
	// no recorded cost, and says so rather than reporting zero as fact.
	const costAvailable = typeof costState?.totalCostUSD === "number";
	if (costAvailable) totals.cost = costState?.totalCostUSD ?? 0;
	const perModel = Object.entries(costState?.modelUsage ?? {});
	if (perModel.length) {
		// cost-state is the harness's own accounting and already covers retries,
		// so it supersedes the per-message sum rather than being added to it.
		totals.input = 0;
		totals.output = 0;
		totals.cacheRead = 0;
		totals.cacheWrite = 0;
	}
	for (const [model, usage] of perModel) {
		modelUsage[model] = {
			input_tokens: usage.inputTokens ?? 0,
			output_tokens: usage.outputTokens ?? 0,
			cost: usage.costUSD ?? 0,
			message_count: 0,
		};
		totals.input += usage.inputTokens ?? 0;
		totals.output += usage.outputTokens ?? 0;
		totals.cacheRead += usage.cacheReadInputTokens ?? 0;
		totals.cacheWrite += usage.cacheCreationInputTokens ?? 0;
	}
	if (typeof costState?.totalLinesAdded === "number" && costState.totalLinesAdded > 0)
		linesAdded = costState.totalLinesAdded;
	if (typeof costState?.totalLinesRemoved === "number" && costState.totalLinesRemoved > 0)
		linesRemoved = costState.totalLinesRemoved;

	return {
		sessionId,
		projectPath,
		firstTs,
		lastTs,
		activeIntervals: activityIntervals(activityTs),
		costAvailable,
		totals,
		modelUsage,
		toolCounts,
		languages,
		toolErrorCategories,
		filesModified: filesModified.size,
		userResponseTimes,
		messageHours,
		userMessageTimestamps,
		gitCommits,
		gitPushes,
		toolErrors,
		usesSubagent,
		usesMcp,
		linesAdded,
		linesRemoved,
		userMessageCount,
		assistantMessageCount,
		firstPrompt,
	};
}

export function buildClaudeMeta(ref: SessionRef, entries: AnyEntry[]): SessionMeta {
	const stats = extractClaudeStats(entries);
	const startTime = new Date(stats.firstTs || ref.created.getTime()).toISOString();
	const endMs = stats.lastTs || ref.modified.getTime();

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
		input_tokens: stats.totals.input,
		output_tokens: stats.totals.output,
		total_cost: stats.totals.cost,
		first_prompt: stats.firstPrompt,
		user_interruptions: 0,
		user_response_times: stats.userResponseTimes,
		tool_errors: stats.toolErrors,
		tool_error_categories: stats.toolErrorCategories,
		uses_subagent: stats.usesSubagent,
		uses_mcp: stats.usesMcp,
		lines_added: stats.linesAdded,
		lines_removed: stats.linesRemoved,
		files_modified: stats.filesModified,
		message_hours: stats.messageHours,
		user_message_timestamps: stats.userMessageTimestamps,
		active_intervals: stats.activeIntervals,
		// Claude Code reports one aggregate cost per session, so subagent spend
		// cannot be split out of it without estimating. It stays in primary.
		cost_primary: stats.totals.cost,
		cost_advisor: 0,
		cost_subagent: 0,
		cache_read_tokens: stats.totals.cacheRead,
		cache_write_tokens: stats.totals.cacheWrite,
		utility_cost: 0,
		sidecar_counts: { advisor: 0, subagent: 0 },
		sidecar_tool_calls: 0,
		sidecar_tool_errors: 0,
		thinking_escalations: 0,
		model_switches: 0,
		compactions: 0,
		steering_messages: 0,
		log_signature: ref.signature,
		median_ttft_ms: 0,
		median_response_ms: 0,
		cost_recorded: stats.costAvailable,
		model_usage: stats.modelUsage,
		// Claude Code's transcripts have no stopReason/ttsr_injection/reset_boundary
		// concepts; these friction signals are omp-only and read as absent, not zero.
		tool_calls_by_tool: {},
		tool_errors_by_tool: {},
		tool_not_found: {},
		error_classes: {},
		error_generations: 0,
		aborted_generations: 0,
		aborted_at_session_end: 0,
		ttsr_injections: 0,
		ttsr_rules: {},
		reset_boundaries: 0,
		abort_events: [],
		turn_count: 0,
		turn_p50: { round_trips: 0, tool_calls: 0, exploration: 0, wall_sec: 0 },
		turn_p90: { round_trips: 0, tool_calls: 0, exploration: 0, wall_sec: 0 },
		worst_turns: [],
		tool_duration_by_tool: {},
		tool_time_share: [],
		cache_hit_ratio: 0,
		edits_by_file: {},
	};
}

export function createClaudeSessionSource(projectsDir: string = CLAUDE_PROJECTS_DIR): SessionSource {
	return {
		name: "claude-code",
		root: projectsDir,
		readEntries: readJsonl,
		isMetaSession,
		readSidecar: extractSidecarUsage,
		buildMeta: (ref, entries) => buildClaudeMeta(ref, entries),
		formatTranscript(entries, meta) {
			const lines: string[] = [
				`Session: ${meta.session_id.slice(0, 8)}`,
				`Date: ${meta.start_time}`,
				`Project: ${meta.project_path}`,
				`Duration: ${meta.duration_minutes} min`,
				"",
			];
			for (const entry of entries) {
				const msg = entry.message as AnyMessage | undefined;
				if (!msg) continue;
				if (entry.type === "user" && entry.isSidechain !== true && entry.isMeta !== true) {
					const text = claudeText(msg.content).slice(0, 500);
					if (text.trim()) lines.push(`[User]: ${text}`);
				} else if (entry.type === "assistant") {
					for (const block of (Array.isArray(msg.content) ? msg.content : []) as ContentBlock[]) {
						if (block.type === "text" && block.text)
							lines.push(`[Assistant]: ${(block.text as string).slice(0, 300)}`);
						else if (block.type === "tool_use" && block.name)
							lines.push(`[Tool: ${block.name as string}]`);
					}
				}
			}
			return lines.join("\n");
		},
		async listSessions(): Promise<SessionScan> {
			const sessions: SessionRef[] = [];
			let projects: DirEntry[] = [];
			try {
				projects = await readdir(projectsDir, { withFileTypes: true });
			} catch {
				return { sessions, duplicate_logs: 0 };
			}

			for (const project of projects) {
				if (!project.isDirectory()) continue;
				const projectDir = join(projectsDir, project.name);
				let entries: DirEntry[] = [];
				try {
					entries = await readdir(projectDir, { withFileTypes: true });
				} catch {
					continue;
				}
				for (const entry of entries) {
					if (entry.isDirectory() || !entry.name.endsWith(".jsonl")) continue;
					const path = join(projectDir, entry.name);
					const info = await stat(path).catch(() => null);
					if (!info) continue;
					sessions.push({
						id: entry.name.replace(/\.jsonl$/, ""),
						path,
						project_path: "",
						size: info.size,
						created: info.birthtime.getTime() ? info.birthtime : info.mtime,
						modified: info.mtime,
						sidecars: [],
						signature: `${info.size}:${info.mtimeMs}`,
					});
				}
			}

			const byId = new Map<string, SessionRef>();
			for (const ref of sessions) {
				const seen = byId.get(ref.id);
				if (!seen || ref.size > seen.size) byId.set(ref.id, ref);
			}
			return {
				sessions: [...byId.values()],
				duplicate_logs: sessions.length - byId.size,
			};
		},
	};
}
