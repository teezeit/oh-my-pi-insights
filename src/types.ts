// SPDX-FileCopyrightText: 2026 Hari Srinivasan <harisrini21@gmail.com>
// SPDX-FileCopyrightText: 2026 Tobias Hoelzer (omp port)
// SPDX-License-Identifier: AGPL-3.0-only


// Shared domain types for the insights pipeline. Pure type declarations,
// no logic, so every other module can depend on this without a cycle.

/**
 * Aborts cannot be told apart structurally (user misphrased vs. agent went
 * wrong), so a cheap heuristic label is attached at extraction time and the
 * facet pass is given a chance to override it with an LLM judgment later.
 */
export type AbortEvent = {
	ts: string;
	tool_calls_before_abort: number;
	elapsed_sec: number;
	partial_text: string;
	next_user_text: string | null;
	gap_sec: number | null;
	heuristic_label: "user_rephrased" | "course_correction" | "abandoned" | "unknown";
};

/**
 * A "turn" is one human message through to just before the next one (or
 * session end). Session totals hide the pathology this exists to catch: one
 * request costing many LLM round trips and tool calls to change two lines.
 */
export type TurnStats = {
	start_ts: string;
	prompt: string;
	llm_round_trips: number;
	tool_calls: number;
	exploration_before_first_mutation: number;
	mutated: boolean;
	wall_sec: number;
	cost: number;
	aborted: boolean;
};

export type TurnPercentiles = {
	round_trips: number;
	tool_calls: number;
	exploration: number;
	wall_sec: number;
};

/** Top-5-across-the-corpus shape; cost is included because the --md table needs it. */
export type TurnCorpusEntry = {
	session_id: string;
	project: string;
	prompt: string;
	llm_round_trips: number;
	tool_calls: number;
	exploration_before_first_mutation: number;
	wall_sec: number;
	cost: number;
};

export type SessionMeta = {
	session_id: string;
	session_path: string;
	project_path: string;
	start_time: string;
	duration_minutes: number;
	user_message_count: number;
	assistant_message_count: number;
	tool_counts: Record<string, number>;
	languages: Record<string, number>;
	git_commits: number;
	git_pushes: number;
	input_tokens: number;
	output_tokens: number;
	total_cost: number;
	first_prompt: string;
	user_interruptions: number;
	user_response_times: number[];
	tool_errors: number;
	tool_error_categories: Record<string, number>;
	uses_subagent: boolean;
	uses_mcp: boolean;
	lines_added: number;
	lines_removed: number;
	files_modified: number;
	message_hours: number[];
	user_message_timestamps: string[];
	// ── omp additions ──
	// Why: omp writes explicit per-call cost, and advisor/subagent sidecars are
	// separate logs with their own spend. total_cost is the parent-attributed
	// sum of all three buckets; the buckets are kept so the report can show
	// where the money actually went (AGENTS.md "Patterns to preserve").
	cost_primary: number;
	cost_advisor: number;
	cost_subagent: number;
	cache_read_tokens: number;
	cache_write_tokens: number;
	utility_cost: number;
	sidecar_counts: { advisor: number; subagent: number };
	sidecar_tool_calls: number;
	sidecar_tool_errors: number;
	thinking_escalations: number;
	model_switches: number;
	compactions: number;
	steering_messages: number;
	// Why: the meta cache is keyed by session id, but a session's logs keep
	// growing (and its advisor sidecar keeps appending) while it is open.
	// Stale cached numbers would silently diverge from the logs, so the size
	// and mtime of the primary log plus every sidecar are recorded and any
	// change invalidates the entry.
	log_signature: string;
	/**
	 * False when the source kept no cost for this session. omp always records
	 * it; Claude Code only writes a cost-state record for some sessions, and
	 * a missing one must read as unavailable, never as $0.
	 */
	cost_recorded: boolean;
	median_ttft_ms: number;
	median_response_ms: number;
	model_usage: Record<string, { input_tokens: number; output_tokens: number; cost: number; message_count: number }>;
	// ── friction-signal additions (interruptions, errors, tool-not-found) ──
	tool_calls_by_tool: Record<string, number>;
	tool_errors_by_tool: Record<string, number>;
	tool_not_found: Record<string, number>;
	error_classes: Record<string, number>;
	error_generations: number;
	aborted_generations: number;
	aborted_at_session_end: number;
	ttsr_injections: number;
	ttsr_rules: Record<string, number>;
	reset_boundaries: number;
	abort_events: AbortEvent[];
	// ── per-turn aggregation (Gap 3) ──
	// Only the percentiles and the worst 5 turns are persisted; the full
	// per-turn list is a transient detail of extraction, not of the cache.
	turn_count: number;
	turn_p50: TurnPercentiles;
	turn_p90: TurnPercentiles;
	worst_turns: TurnStats[];
	// ── per-tool wall-clock (Gap 4) ──
	// Only percentiles are persisted; the raw per-call duration samples a
	// session produced are a transient detail of extraction.
	tool_duration_by_tool: Record<string, { calls: number; total_sec: number; p50_sec: number; p90_sec: number }>;
	tool_time_share: Array<{ tool: string; total_sec: number; share: number }>;
	// ── derived ratios (Gap 5) ──
	cache_hit_ratio: number;
	// Capped to the top 20 paths by edit count; feeds files_modified's .size
	// today, but keeping the paths surfaces same-file rework.
	edits_by_file: Record<string, number>;
};

export type SessionFacets = {
	session_id: string;
	underlying_goal: string;
	goal_categories: Record<string, number>;
	outcome: string;
	user_satisfaction_counts: Record<string, number>;
	assistant_helpfulness: string;
	session_type: string;
	friction_counts: Record<string, number>;
	friction_detail: string;
	primary_success: string;
	brief_summary: string;
	user_instructions_to_assistant?: string[];
	abort_labels?: Array<{
		ts: string;
		label: "user_rephrased" | "agent_wrong_direction" | "agent_too_slow" | "abandoned";
	}>;
};

export type AggregatedData = {
	total_sessions: number;
	sessions_with_facets: number;
	date_range: { start: string; end: string };
	total_messages: number;
	// Why: union of [start, start+duration] per local calendar day, so
	// parallel sessions count once and no day can exceed 24h.
	total_duration_hours: number;
	active_hours_by_day: Record<string, number>;
	total_input_tokens: number;
	total_output_tokens: number;
	total_cost: number;
	tool_counts: Record<string, number>;
	languages: Record<string, number>;
	git_commits: number;
	git_pushes: number;
	projects: Record<string, number>;
	goal_categories: Record<string, number>;
	outcomes: Record<string, number>;
	satisfaction: Record<string, number>;
	helpfulness: Record<string, number>;
	session_types: Record<string, number>;
	friction: Record<string, number>;
	success: Record<string, number>;
	session_summaries: Array<{
		id: string;
		date: string;
		summary: string;
		outcome: string;
		helpfulness: string;
	}>;
	friction_details: string[];
	user_instructions: string[];
	// Same numerator as interruption_rate: mid-session aborts plus steering.
	total_interruptions: number;
	interruptions_aborted: number;
	interruptions_steered: number;
	total_tool_errors: number;
	tool_error_categories: Record<string, number>;
	user_response_times: number[];
	median_response_time: number;
	avg_response_time: number;
	sessions_using_subagent: number;
	sessions_using_mcp: number;
	total_lines_added: number;
	total_lines_removed: number;
	total_files_modified: number;
	days_active: number;
	message_hours: number[];
	concurrent_sessions: {
		overlap_events: number;
		sessions_involved: number;
		user_messages_during: number;
	};
	// ── omp additions ──
	total_cost_primary: number;
	total_cost_advisor: number;
	total_cost_subagent: number;
	total_utility_cost: number;
	total_cache_read_tokens: number;
	total_cache_write_tokens: number;
	advisor_logs: number;
	subagent_logs: number;
	sessions_with_sidecars: number;
	total_thinking_escalations: number;
	total_model_switches: number;
	total_compactions: number;
	total_steering: number;
	median_ttft_ms: number;
	model_usage: Record<string, { input_tokens: number; output_tokens: number; cost: number; message_count: number; sessions: number; tier?: string }>;
	model_efficiency: Array<{
		model: string;
		session_id: string;
		date: string;
		cost: number;
		outcome: string;
		session_type: string;
		goal: string;
		flag: "overspend" | "underspend" | "quota_pressure" | "ok";
		reason: string;
	}>;
	estimated_waste: number;
	// ── friction-signal additions (interruptions, errors, tool-not-found) ──
	tool_calls_by_tool: Record<string, number>;
	tool_errors_by_tool: Record<string, number>;
	tool_not_found: Record<string, number>;
	error_classes: Record<string, number>;
	error_generations: number;
	aborted_generations: number;
	aborted_at_session_end: number;
	ttsr_injections: number;
	ttsr_rules: Record<string, number>;
	reset_boundaries: number;
	interruption_rate: number;
	tool_error_rate_table: Array<{ tool: string; calls: number; errors: number; rate: number }>;
	abort_labels: Record<string, number>;
	// ── per-turn aggregation (Gap 3) ──
	// Pooled approximation: only per-session percentiles are persisted, not
	// every turn, so the corpus p50/p90 is a weighted median of per-session
	// p50/p90 values (weighted by each session's turn_count), not the true
	// percentile over every individual turn.
	total_turns: number;
	turn_p50: TurnPercentiles;
	turn_p90: TurnPercentiles;
	worst_turns_corpus: TurnCorpusEntry[];
	// ── per-tool wall-clock (Gap 4) ──
	// calls/total_sec are exact sums; p50_sec/p90_sec are a pooled
	// approximation, same weighted-median-of-per-session-percentiles
	// pattern as turn_p50/turn_p90 above (weighted by each session's calls
	// for that tool), not a true recomputation over every individual call.
	tool_duration_by_tool: Record<string, { calls: number; total_sec: number; p50_sec: number; p90_sec: number }>;
	tool_time_share: Array<{ tool: string; total_sec: number; share: number }>;
	// ── derived ratios (Gap 5) ──
	// Token-weighted: recomputed from the already-summed totals, not an
	// average of per-session ratios.
	cache_hit_ratio: number;
	worst_cache_sessions: Array<{ session_id: string; project: string; ratio: number; tokens: number; cost: number }>;
	// Pooled from each session's own top-20-by-count edits_by_file, so this
	// can miss a file that is individually common but never in any single
	// session's top 20 - same approximation class as worst_turns_corpus.
	most_churned_files: Array<{ path: string; edits: number; sessions: number }>;
};

export type UserContext = {
	existing_agents_md_rules: string[];
	installed_skills: string[];
	installed_managed_skills: string[];
	installed_extensions: string[];
	installed_hooks: string[];
	mcp_servers: string[];
	model_roles: Record<string, string>;
	fallback_chains: Record<string, string[]>;
	default_model: string;
};

/** What the scan itself saw — reported so the numbers can be audited. */
export type ScanSummary = {
	sessions_dir: string;
	source: string;
	/** Sessions the source kept no cost for; excluded from the totals, not zeroed. */
	cost_unavailable: number;
	primary_logs: number;
	duplicate_logs: number;
	advisor_logs: number;
	subagent_logs: number;
	excluded_meta: number;
	excluded_current: number;
	excluded_unparsed: number;
	excluded_not_substantive: number;
	excluded_by_since: number;
	/** Sessions whose facet extraction failed or returned nothing usable. */
	facet_failures: number;
	facets_analyzed: number;
	included: number;
	/** Set when --no-llm reused prose generated against an older corpus state. */
	reused_stale_sections: boolean;
};

export type DeltaWindow = { start: string; end: string; sessions: number };

export type TemporalDelta = {
	basis: "model_switch" | "week_over_week";
	before: DeltaWindow;
	after: DeltaWindow;
	/** pct is rounded to a whole percent; before/after are per-session means. */
	cost_per_session: { before: number; after: number; pct: number };
	errors_per_session: { before: number; after: number; pct: number };
};

export type TemporalData = {
	diff_headlines: string[];
	this_week: { sessions: number; avg_cost: number; errors_per_session: number; primary_model: string } | null;
	last_week: { sessions: number; avg_cost: number; errors_per_session: number; primary_model: string } | null;
	trajectory: { cost: string; errors: string; note: string };
	anomalies: Array<{ date: string; cost: string; errors: number; reason: string; prompt: string }>;
	major_transition: { when: string; what: string; impact: string } | null;
	resolved_friction: string[];
	ongoing_friction: Array<{ type: string; recent_count: number; total_count: number }>;
	staleness_pct: number;
	/**
	 * The only before/after comparison in the report. Why: the banner, the
	 * transition note and the trajectory line each computed their own delta
	 * over different, unstated windows (-37% vs -43% vs -70% errors). Every
	 * printed delta now quotes this object.
	 */
	delta: TemporalDelta | null;
};


// Why an interface: Stage 3 adds a ~/.claude/projects adapter. Everything
// above this boundary works on SessionRef/AnyEntry and knows nothing about
// omp's on-disk layout.

export type SidecarKind = "advisor" | "subagent";

/**
 * A nested transcript that belongs to a parent session: the advisor log, or a
 * subagent's own log. These are separate sessions with their own spend, so
 * they must never surface as top-level sessions but must be counted.
 */
export type SidecarRef = {
	kind: SidecarKind;
	name: string;
	path: string;
	size: number;
	mtime_ms: number;
};

export type SessionRef = {
	id: string;
	path: string;
	project_path: string;
	size: number;
	created: Date;
	modified: Date;
	sidecars: SidecarRef[];
	/** size:mtime of the primary log and every sidecar; keys the meta cache. */
	signature: string;
};

export type SessionScan = {
	sessions: SessionRef[];
	/** Logs dropped because another copy carried the same session id. */
	duplicate_logs: number;
};

export type SessionSource = {
	readonly name: string;
	/** Root this source scans; reported so the corpus section is truthful. */
	readonly root: string;
	/** Top-level sessions only; nested logs hang off their parent. */
	listSessions(): Promise<SessionScan>;
	readEntries(path: string): Promise<AnyEntry[]>;
	/** True when this log is the insights pipeline talking to itself. */
	isMetaSession(entries: AnyEntry[]): boolean;
	/**
	 * Fold a log and its sidecars into one SessionMeta. Owned by the source
	 * because record schemas differ per harness; everything above this
	 * boundary only ever sees SessionMeta.
	 */
	buildMeta(
		ref: SessionRef,
		entries: AnyEntry[],
		sidecars: Array<{ kind: SidecarKind; usage: SidecarUsage }>,
	): SessionMeta;
	readSidecar(entries: AnyEntry[]): SidecarUsage;
	formatTranscript(entries: AnyEntry[], meta: SessionMeta): string;
};

export type AnyEntry = Record<string, unknown>;
export type AnyMessage = Record<string, unknown>;
export type ContentBlock = {
	type: string;
	text?: string;
	name?: string;
	arguments?: Record<string, unknown>;
	[k: string]: unknown;
};

export type UsageRecord = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
};

export type ModelUsageMap = Record<
	string,
	{ input_tokens: number; output_tokens: number; cost: number; message_count: number }
>;

export type SidecarUsage = {
	totals: UsageRecord;
	utility_cost: number;
	model_usage: ModelUsageMap;
	tool_calls: number;
	tool_errors: number;
};
