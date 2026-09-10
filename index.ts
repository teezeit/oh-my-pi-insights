// SPDX-FileCopyrightText: 2026 Hari Srinivasan <harisrini21@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * /insights — omp Usage Insights
 *
 * Scans all omp session logs, extracts deterministic stats, runs LLM
 * facet extraction per session (cached), fires 7 parallel insight prompts
 * + 1 synthesis, and writes a self-contained HTML report.
 *
 * Ported from Observal/pi-insights (AGPL-3.0-only) to the omp harness.
 *
 * Usage:
 *   /insights             — run with caches (fast on re-runs)
 *   /insights --refresh   — invalidate all LLM facet caches, re-extract
 *   /insights --md        — write the Markdown export instead of HTML
 *   /insights --no-open   — don't open the report in the browser
 *   /insights --since 7d  — restrict the corpus to the last 7 days
 *
 * Data dir: ~/.omp/agent/usage-data/
 *   session-meta/<id>.json   deterministic stats, cached permanently
 *   facets/<id>.json         LLM-extracted facets, cached permanently
 *   report.html              last generated report
 *   session-set.json         audit manifest of the last run's session set
 */

import { execFile as execFileCb } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { extname, join } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

// ─── Host API (structural) ────────────────────────────────────────────────────

// Why: no package-specific type import here. Pi and omp expose the same
// extension API but publish their types under different package names, so the
// host is typed structurally — same rationale as the note at the top of
// ~/.omp/agent/extensions/orca-agent-status.ts.

type ExtensionUI = {
	notify(message: string, level?: "info" | "success" | "warning" | "error"): void;
	setStatus(key: string, text: string): void;
	setWidget(key: string, lines?: string[]): void;
};

type ExtensionCommandContext = {
	ui: ExtensionUI;
	cwd?: string;
	model?: unknown;
	modelRegistry?: {
		getApiKeyAndHeaders(model: unknown): Promise<{
			ok: boolean;
			error?: string;
			apiKey?: string;
			headers?: Record<string, string>;
		}>;
	};
	sessionManager?: { getSessionId?(): string | null | undefined };
};

type ExtensionAPI = {
	registerCommand(
		name: string,
		spec: {
			description: string;
			handler(
				args: string | undefined,
				ctx: ExtensionCommandContext,
			): Promise<void> | void;
		},
	): void;
};

// ─── Constants ────────────────────────────────────────────────────────────────

const AGENT_DIR = join(homedir(), ".omp", "agent");
const SESSIONS_DIR = join(AGENT_DIR, "sessions");
const DATA_DIR = join(AGENT_DIR, "usage-data");
const FACETS_DIR = join(DATA_DIR, "facets");
const META_DIR = join(DATA_DIR, "session-meta");
const SECTIONS_DIR = join(DATA_DIR, "sections");
const REPORT_PATH = join(DATA_DIR, "report.html");
const REPORT_MD_PATH = join(DATA_DIR, "report.md");
const SESSION_SET_PATH = join(DATA_DIR, "session-set.json");

// Why: the corpus is already ~400 sessions, so upstream's 200 load cap would
// silently truncate it. Loading is cached per session and costs no tokens, so
// the default is raised past the corpus size; facet extraction stays capped
// because that phase spends money. All three are flag- and env-overridable
// (--max-sessions / --max-facets / --facet-concurrency,
// OMP_INSIGHTS_MAX_SESSIONS / _MAX_FACETS / _FACET_CONCURRENCY).
const DEFAULT_MAX_SESSIONS_TO_LOAD = 2000;
const DEFAULT_MAX_FACET_EXTRACTIONS = 50;
const DEFAULT_FACET_CONCURRENCY = 50;
const META_BATCH_SIZE = 50;
const LOAD_BATCH_SIZE = 10;
const OVERLAP_WINDOW_MS = 30 * 60_000;

// Stage 2: the LLM phases are wired. Facet extraction, the section prompts and
// the synthesis run through `omp -p` subprocesses (see callModel).
const LLM_PHASES_ENABLED = true;

// The omp binary this extension shells out to for model calls. Overridable so
// a non-PATH install still works.
const OMP_BIN = process.env.OMP_INSIGHTS_OMP_BIN || "omp";
const MODEL_CALL_TIMEOUT_MS = 300_000;

/** `--<flag> N` on the command line, else `$ENV`, else the default. */
function resolveLimit(
	args: string,
	flag: string,
	envVar: string,
	fallback: number,
): number {
	const match = args.match(new RegExp(`--${flag}[\\s=](\\d+)`));
	if (match) return Number(match[1]);
	const env = Number(process.env[envVar]);
	return Number.isFinite(env) && env > 0 ? env : fallback;
}

const EXTENSION_TO_LANGUAGE: Record<string, string> = {
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

const LABEL_MAP: Record<string, string> = {
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

const SATISFACTION_ORDER = [
	"frustrated",
	"dissatisfied",
	"likely_satisfied",
	"satisfied",
	"happy",
	"unsure",
	"neutral",
	"delighted",
];
const OUTCOME_ORDER = [
	"not_achieved",
	"partially_achieved",
	"mostly_achieved",
	"fully_achieved",
	"unclear_from_transcript",
];

function displayLabel(key: string): string {
	return (
		LABEL_MAP[key] ??
		key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
	);
}

// ─── Types ────────────────────────────────────────────────────────────────────

type SessionMeta = {
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
	// where the money actually went (HANDOVER.md "nested logs").
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
	median_ttft_ms: number;
	median_response_ms: number;
	model_usage: Record<string, { input_tokens: number; output_tokens: number; cost: number; message_count: number }>;
};

type SessionFacets = {
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
};

type AggregatedData = {
	total_sessions: number;
	sessions_with_facets: number;
	date_range: { start: string; end: string };
	total_messages: number;
	total_duration_hours: number;
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
	total_interruptions: number;
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
};

type UserContext = {
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
type ScanSummary = {
	sessions_dir: string;
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

type TemporalData = {
	diff_headlines: string[];
	this_week: { sessions: number; avg_cost: number; errors_per_session: number; primary_model: string } | null;
	last_week: { sessions: number; avg_cost: number; errors_per_session: number; primary_model: string } | null;
	trajectory: { cost: string; errors: string; note: string };
	anomalies: Array<{ date: string; cost: string; errors: number; reason: string; prompt: string }>;
	major_transition: { when: string; what: string; impact: string } | null;
	resolved_friction: string[];
	ongoing_friction: Array<{ type: string; recent_count: number; total_count: number }>;
	staleness_pct: number;
};

// ─── Cache Utilities ──────────────────────────────────────────────────────────

async function ensureDirs(): Promise<void> {
	await mkdir(META_DIR, { recursive: true });
	await mkdir(FACETS_DIR, { recursive: true });
	await mkdir(SECTIONS_DIR, { recursive: true });
}

async function loadCachedMeta(
	sessionId: string,
	signature: string,
): Promise<SessionMeta | null> {
	try {
		const raw = await readFile(join(META_DIR, `${sessionId}.json`), "utf-8");
		const meta = JSON.parse(raw) as SessionMeta;
		// A log that has grown since the entry was written must be re-read, or
		// the report's totals stop matching the logs they claim to summarise.
		if (meta.log_signature !== signature) return null;
		return meta;
	} catch {
		return null;
	}
}

async function saveMeta(meta: SessionMeta): Promise<void> {
	await writeFile(
		join(META_DIR, `${meta.session_id}.json`),
		JSON.stringify(meta, null, 2),
		{ encoding: "utf-8", mode: 0o600 },
	);
}

type CachedSections = {
	sections: Record<string, unknown>;
	synthesis: Record<string, string>;
};

/**
 * The eight section prompts and the synthesis are a pure function of the
 * shared data block, so they are cached on a hash of it. Without this a
 * re-run with every facet cached still spent a minute and real money
 * regenerating identical prose.
 */
async function loadCachedSections(key: string): Promise<CachedSections | null> {
	try {
		const raw = await readFile(join(SECTIONS_DIR, `${key}.json`), "utf-8");
		const parsed = JSON.parse(raw) as CachedSections;
		return parsed.sections ? parsed : null;
	} catch {
		return null;
	}
}

async function saveSections(key: string, value: CachedSections): Promise<void> {
	await writeFile(join(SECTIONS_DIR, `${key}.json`), JSON.stringify(value, null, 2), {
		encoding: "utf-8",
		mode: 0o600,
	});
}

/**
 * Every distinct corpus state mints a new entry, and the corpus changes
 * whenever omp runs, so this directory would grow without bound.
 */
async function pruneSections(keep = 5): Promise<void> {
	try {
		const files = await readdir(SECTIONS_DIR);
		const stamped = await Promise.all(
			files
				.filter((f) => f.endsWith(".json"))
				.map(async (f) => ({ f, m: (await stat(join(SECTIONS_DIR, f))).mtimeMs })),
		);
		stamped.sort((a, b) => b.m - a.m);
		for (const { f } of stamped.slice(keep)) {
			await unlink(join(SECTIONS_DIR, f)).catch(() => {});
		}
	} catch {
		/* cache pruning is best effort */
	}
}

/**
 * Newest cached generation regardless of key. Only for --no-llm, where the
 * caller has asked for no spend: reusing prose written against a slightly
 * older corpus beats rendering none, provided the report says so.
 */
async function loadLatestSections(): Promise<CachedSections | null> {
	try {
		const files = await readdir(SECTIONS_DIR);
		const stamped = await Promise.all(
			files
				.filter((f) => f.endsWith(".json"))
				.map(async (f) => ({ f, m: (await stat(join(SECTIONS_DIR, f))).mtimeMs })),
		);
		const newest = stamped.sort((a, b) => b.m - a.m)[0];
		return newest ? await loadCachedSections(newest.f.replace(/\.json$/, "")) : null;
	} catch {
		return null;
	}
}

async function loadCachedFacets(
	sessionId: string,
): Promise<SessionFacets | null> {
	try {
		const raw = await readFile(join(FACETS_DIR, `${sessionId}.json`), "utf-8");
		const parsed = JSON.parse(raw) as SessionFacets;
		// Basic schema check
		if (!parsed.session_id || !parsed.brief_summary || !parsed.outcome)
			return null;
		return parsed;
	} catch {
		return null;
	}
}

async function saveFacets(facets: SessionFacets): Promise<void> {
	await writeFile(
		join(FACETS_DIR, `${facets.session_id}.json`),
		JSON.stringify(facets, null, 2),
		{ encoding: "utf-8", mode: 0o600 },
	);
}

async function deleteCachedFacets(sessionId: string): Promise<void> {
	try {
		await unlink(join(FACETS_DIR, `${sessionId}.json`));
	} catch {
		/* ok */
	}
}

type YamlNode = { [k: string]: string | string[] | YamlNode };

function unquoteYaml(v: string): string {
	const t = v.trim().replace(/\s+#.*$/, "").trim();
	if (
		(t.startsWith('"') && t.endsWith('"')) ||
		(t.startsWith("'") && t.endsWith("'"))
	)
		return t.slice(1, -1);
	return t;
}

/**
 * Minimal YAML-subset reader for ~/.omp/agent/config.yml: indented mappings,
 * `- ` scalar sequences, optionally quoted scalars.
 *
 * Why not a real YAML parser: the port takes no new runtime dependencies
 * (node builtins only), and the only consumers here are `modelRoles` and
 * `retry.fallbackChains` — both plain string maps and string lists.
 */
function parseSimpleYaml(text: string): YamlNode {
	const root: YamlNode = {};
	const stack: Array<{ indent: number; node: YamlNode }> = [
		{ indent: -1, node: root },
	];
	let lastKey: { node: YamlNode; key: string } | null = null;

	for (const raw of text.split("\n")) {
		const trimmed = raw.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const indent = raw.search(/\S/);

		if (trimmed.startsWith("- ")) {
			if (!lastKey) continue;
			const existing = lastKey.node[lastKey.key];
			const item = unquoteYaml(trimmed.slice(2));
			if (Array.isArray(existing)) existing.push(item);
			else lastKey.node[lastKey.key] = [item];
			continue;
		}

		const colon = trimmed.indexOf(":");
		if (colon < 0) continue;
		const key = unquoteYaml(trimmed.slice(0, colon));
		const value = trimmed.slice(colon + 1).trim();

		while (stack.length > 1 && indent <= stack[stack.length - 1]!.indent)
			stack.pop();
		const parent = stack[stack.length - 1]!.node;

		if (!value) {
			const child: YamlNode = {};
			parent[key] = child;
			stack.push({ indent, node: child });
		} else {
			parent[key] = unquoteYaml(value);
		}
		lastKey = { node: parent, key };
	}
	return root;
}

function yamlMap(node: YamlNode | undefined, key: string): YamlNode | undefined {
	const v = node?.[key];
	return v && !Array.isArray(v) && typeof v === "object" ? v : undefined;
}

async function listDirNames(
	dir: string,
	kind: "dirs" | "files",
	exts: string[] = [],
): Promise<string[]> {
	try {
		const entries = await readdir(dir, { withFileTypes: true });
		return entries
			.filter((e) => (kind === "dirs" ? e.isDirectory() : !e.isDirectory()))
			.map((e) => e.name)
			.filter((n) => !n.startsWith("."))
			.filter((n) => !exts.length || exts.some((x) => n.endsWith(x)))
			.map((n) => (exts.length ? n.replace(/\.[^.]+$/, "") : n))
			.sort();
	} catch {
		return [];
	}
}

async function gatherUserContext(): Promise<UserContext> {
	const ctx: UserContext = {
		existing_agents_md_rules: [],
		installed_skills: [],
		installed_managed_skills: [],
		installed_extensions: [],
		installed_hooks: [],
		mcp_servers: [],
		model_roles: {},
		fallback_chains: {},
		default_model: "",
	};

	// Global instructions. omp has no ~/.omp/agent/AGENTS.md; the user-level
	// identity file is ~/.claude/CLAUDE.md, and AGENTS.md files are per project.
	for (const file of [
		join(homedir(), ".claude", "CLAUDE.md"),
		join(AGENT_DIR, "AGENTS.md"),
	]) {
		try {
			const text = await readFile(file, "utf-8");
			for (const line of text.split("\n")) {
				const t = line.trim();
				if (t.length > 20 && t.length < 200 && /\b(always|never|do not|don't|must|require|forbid)\b/i.test(t)) {
					ctx.existing_agents_md_rules.push(t.slice(0, 150));
				}
			}
		} catch {}
	}
	ctx.existing_agents_md_rules = ctx.existing_agents_md_rules.slice(0, 20);

	// config.yml is YAML, not settings.json. The default model is a model role,
	// and retry.fallbackChains is the routing the report must not re-suggest.
	try {
		const cfg = parseSimpleYaml(await readFile(join(AGENT_DIR, "config.yml"), "utf-8"));
		const roles = yamlMap(cfg, "modelRoles");
		if (roles) {
			for (const [role, model] of Object.entries(roles)) {
				if (typeof model === "string") ctx.model_roles[role] = model;
			}
			// Roles may alias another role with "@name" (e.g. tiny: "@smol").
			for (const [role, model] of Object.entries(ctx.model_roles)) {
				if (model.startsWith("@")) {
					const target = ctx.model_roles[model.slice(1)];
					if (target) ctx.model_roles[role] = target;
				}
			}
			ctx.default_model = ctx.model_roles.default ?? "";
		}
		const chains = yamlMap(yamlMap(cfg, "retry"), "fallbackChains");
		if (chains) {
			for (const [role, list] of Object.entries(chains)) {
				if (Array.isArray(list)) ctx.fallback_chains[role] = list;
			}
		}
	} catch {}

	// Both skill dirs matter: a suggestion recommending an already-installed
	// skill is a bug, and most skills live under managed-skills/.
	ctx.installed_skills = await listDirNames(join(AGENT_DIR, "skills"), "dirs");
	ctx.installed_managed_skills = await listDirNames(join(AGENT_DIR, "managed-skills"), "dirs");
	ctx.installed_extensions = await listDirNames(join(AGENT_DIR, "extensions"), "files", [".ts", ".js"]);

	try {
		const events = await readdir(join(AGENT_DIR, "hooks"), { withFileTypes: true });
		for (const event of events) {
			if (!event.isDirectory()) continue;
			const hooks = await listDirNames(join(AGENT_DIR, "hooks", event.name), "files");
			for (const h of hooks) ctx.installed_hooks.push(`${event.name}/${h}`);
		}
	} catch {}

	try {
		const mcp = JSON.parse(await readFile(join(AGENT_DIR, "mcp.json"), "utf-8")) as {
			mcpServers?: Record<string, unknown>;
			servers?: Record<string, unknown>;
		};
		ctx.mcp_servers = Object.keys(mcp.mcpServers ?? mcp.servers ?? {}).sort();
	} catch {}

	return ctx;
}

function modeStr(arr: string[]): string {
	const counts: Record<string, number> = {};
	for (const v of arr) if (v) counts[v] = (counts[v] || 0) + 1;
	return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || "";
}

function computeTemporalData(metas: SessionMeta[], facetsMap: Map<string, SessionFacets>): TemporalData {
	const sorted = [...metas].sort((a, b) => a.start_time.localeCompare(b.start_time));
	if (!sorted.length) return { diff_headlines: [], this_week: null, last_week: null, trajectory: { cost: "stable", errors: "stable", note: "" }, anomalies: [], major_transition: null, resolved_friction: [], ongoing_friction: [], staleness_pct: 0 };

	const now = new Date(sorted[sorted.length - 1]!.start_time).getTime();
	const oneWeek = 7 * 86400000;

	// Diff: this week vs last week
	const thisWeekSessions = sorted.filter(m => now - new Date(m.start_time).getTime() < oneWeek);
	const lastWeekSessions = sorted.filter(m => { const age = now - new Date(m.start_time).getTime(); return age >= oneWeek && age < 2 * oneWeek; });

	function periodSummary(sessions: SessionMeta[]) {
		if (!sessions.length) return null;
		const models: Record<string, number> = {};
		let cost = 0, errors = 0;
		for (const m of sessions) { cost += m.total_cost; errors += m.tool_errors; for (const [model, s] of Object.entries(m.model_usage)) models[model] = (models[model] || 0) + s.message_count; }
		return { sessions: sessions.length, avg_cost: cost / sessions.length, errors_per_session: errors / sessions.length, primary_model: Object.entries(models).sort((a, b) => b[1] - a[1])[0]?.[0]?.replace(/.*\//, "") || "unknown" };
	}

	const tw = periodSummary(thisWeekSessions);
	const lw = periodSummary(lastWeekSessions);
	const diff_headlines: string[] = [];
	if (tw && lw && lw.avg_cost > 0) {
		const costD = Math.round((tw.avg_cost - lw.avg_cost) / lw.avg_cost * 100);
		if (Math.abs(costD) > 15) diff_headlines.push(`Cost ${costD > 0 ? "up" : "down"} ${Math.abs(costD)}% ($${lw.avg_cost.toFixed(1)} \u2192 $${tw.avg_cost.toFixed(1)}/session)`);
		const errD = Math.round((tw.errors_per_session - lw.errors_per_session) / (lw.errors_per_session || 1) * 100);
		if (Math.abs(errD) > 20) diff_headlines.push(`Errors ${errD > 0 ? "up" : "down"} ${Math.abs(errD)}% (${lw.errors_per_session.toFixed(0)} \u2192 ${tw.errors_per_session.toFixed(0)}/session)`);
		if (tw.primary_model !== lw.primary_model) diff_headlines.push(`Model shifted: ${lw.primary_model} \u2192 ${tw.primary_model}`);
	}

	// Trajectory
	const recent10 = sorted.slice(-10);
	const older = sorted.slice(0, -10);
	const recentCost = recent10.reduce((s, m) => s + m.total_cost, 0) / recent10.length;
	const olderCost = older.length ? older.reduce((s, m) => s + m.total_cost, 0) / older.length : recentCost;
	const recentErrors = recent10.reduce((s, m) => s + m.tool_errors, 0) / recent10.length;
	const olderErrors = older.length ? older.reduce((s, m) => s + m.tool_errors, 0) / older.length : recentErrors;
	const trajectory = {
		cost: recentCost > olderCost * 1.2 ? "increasing" : recentCost < olderCost * 0.8 ? "decreasing" : "stable",
		errors: recentErrors > olderErrors * 1.2 ? "increasing" : recentErrors < olderErrors * 0.8 ? "decreasing" : "stable",
		note: older.length ? `Recent 10 vs earlier ${older.length}: cost ${recentCost > olderCost ? "up" : "down"} ${Math.abs(Math.round((recentCost - olderCost) / (olderCost || 1) * 100))}%, errors ${recentErrors > olderErrors ? "up" : "down"} ${Math.abs(Math.round((recentErrors - olderErrors) / (olderErrors || 1) * 100))}%` : "Not enough history",
	};

	// Anomalies
	const anomalies: TemporalData["anomalies"] = [];
	for (let i = 5; i < sorted.length; i++) {
		const m = sorted[i]!;
		const window = sorted.slice(Math.max(0, i - 10), i);
		const avgCost = window.reduce((s, x) => s + x.total_cost, 0) / window.length;
		const avgErrors = window.reduce((s, x) => s + x.tool_errors, 0) / window.length;
		const reasons: string[] = [];
		if (m.total_cost > avgCost * 3 && m.total_cost > 10) reasons.push(`cost spike: $${m.total_cost.toFixed(0)} vs $${avgCost.toFixed(0)} avg`);
		if (m.tool_errors > avgErrors * 3 && m.tool_errors > 10) reasons.push(`error spike: ${m.tool_errors} vs ${avgErrors.toFixed(0)} avg`);
		if (reasons.length) anomalies.push({ date: m.start_time.slice(0, 10), cost: `$${m.total_cost.toFixed(2)}`, errors: m.tool_errors, reason: reasons.join("; "), prompt: m.first_prompt.slice(0, 80) });
	}
	anomalies.sort((a, b) => parseFloat(b.cost.slice(1)) - parseFloat(a.cost.slice(1)));

	// Major transition
	let major_transition: TemporalData["major_transition"] = null;
	for (let i = sorted.length - 1; i >= 10; i--) {
		const after = sorted.slice(i, Math.min(i + 10, sorted.length));
		const before = sorted.slice(Math.max(0, i - 10), i);
		if (before.length < 5 || after.length < 5) continue;
		const beforeModel = modeStr(before.map(m => Object.entries(m.model_usage).sort((a, b) => b[1].cost - a[1].cost)[0]?.[0] || ""));
		const afterModel = modeStr(after.map(m => Object.entries(m.model_usage).sort((a, b) => b[1].cost - a[1].cost)[0]?.[0] || ""));
		if (beforeModel && afterModel && beforeModel !== afterModel) {
			const beforeCost = before.reduce((s, m) => s + m.total_cost, 0) / before.length;
			const afterCost = after.reduce((s, m) => s + m.total_cost, 0) / after.length;
			const beforeErrors = before.reduce((s, m) => s + m.tool_errors, 0) / before.length;
			const afterErrors = after.reduce((s, m) => s + m.tool_errors, 0) / after.length;
			major_transition = {
				when: sorted[i]!.start_time.slice(0, 10),
				what: `Shifted from ${beforeModel.replace(/.*\//, "")} to ${afterModel.replace(/.*\//, "")}`,
				impact: `Cost ${afterCost > beforeCost ? "up" : "down"} ${Math.abs(Math.round((afterCost - beforeCost) / (beforeCost || 1) * 100))}%, errors ${afterErrors > beforeErrors ? "up" : "down"} ${Math.abs(Math.round((afterErrors - beforeErrors) / (beforeErrors || 1) * 100))}%`,
			};
			break;
		}
	}

	// Resolved vs ongoing friction
	const recentCutoff = now - 14 * 86400000;
	const recentMetas = sorted.filter(m => new Date(m.start_time).getTime() >= recentCutoff);
	const olderMetas = sorted.filter(m => new Date(m.start_time).getTime() < recentCutoff);
	const recentFriction: Record<string, number> = {};
	const olderFriction: Record<string, number> = {};
	for (const m of recentMetas) { const f = facetsMap.get(m.session_id); if (f) for (const [k, v] of Object.entries(f.friction_counts)) if (v > 0) recentFriction[k] = (recentFriction[k] || 0) + v; }
	for (const m of olderMetas) { const f = facetsMap.get(m.session_id); if (f) for (const [k, v] of Object.entries(f.friction_counts)) if (v > 0) olderFriction[k] = (olderFriction[k] || 0) + v; }
	const resolved_friction: string[] = [];
	const ongoing_friction: TemporalData["ongoing_friction"] = [];
	for (const [type] of Object.entries(olderFriction)) { if (!recentFriction[type]) resolved_friction.push(type); }
	for (const [type, count] of Object.entries(recentFriction)) { if (count > 0) ongoing_friction.push({ type, recent_count: count, total_count: count + (olderFriction[type] || 0) }); }
	ongoing_friction.sort((a, b) => b.recent_count - a.recent_count);

	// Staleness
	const flatCost = sorted.reduce((s, m) => s + m.total_cost, 0) / sorted.length;
	const staleness_pct = flatCost > 0 ? Math.abs((recentCost - flatCost) / flatCost * 100) : 0;

	return { diff_headlines, this_week: tw, last_week: lw, trajectory, anomalies: anomalies.slice(0, 5), major_transition, resolved_friction: resolved_friction.slice(0, 5), ongoing_friction: ongoing_friction.slice(0, 8), staleness_pct };
}

// ─── Session Sources ──────────────────────────────────────────────────────────

// Why an interface: Stage 3 adds a ~/.claude/projects adapter. Everything
// above this boundary works on SessionRef/AnyEntry and knows nothing about
// omp's on-disk layout.

type SidecarKind = "advisor" | "subagent";

/**
 * A nested transcript that belongs to a parent session: the advisor log, or a
 * subagent's own log. These are separate sessions with their own spend, so
 * they must never surface as top-level sessions but must be counted.
 */
type SidecarRef = {
	kind: SidecarKind;
	name: string;
	path: string;
	size: number;
	mtime_ms: number;
};

type SessionRef = {
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

type SessionScan = {
	sessions: SessionRef[];
	/** Logs dropped because another copy carried the same session id. */
	duplicate_logs: number;
};

type SessionSource = {
	readonly name: string;
	/** Top-level sessions only; nested logs hang off their parent. */
	listSessions(): Promise<SessionScan>;
	readEntries(path: string): Promise<AnyEntry[]>;
};

async function readJsonl(path: string): Promise<AnyEntry[]> {
	const raw = await readFile(path, "utf-8");
	const out: AnyEntry[] = [];
	for (const line of raw.split("\n")) {
		// Why the brace check: a live session's tail can be a partial write, and
		// the first record is padded — both are cheaper to skip than to parse.
		if (!line.startsWith("{")) continue;
		try {
			out.push(JSON.parse(line) as AnyEntry);
		} catch {
			/* truncated or mid-write line */
		}
	}
	return out;
}

/** The subset of node's Dirent this scanner needs. */
type DirEntry = { name: string; isDirectory(): boolean };

/** Collect every *.jsonl under a session's sidecar directory, recursively. */
async function collectSidecars(
	dir: string,
	prefix: string,
	out: SidecarRef[],
): Promise<void> {
	let entries: DirEntry[] = [];
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			await collectSidecars(path, `${prefix}${entry.name}/`, out);
			continue;
		}
		// *.bash.log / *.read.log / *.eval.log are tool-output spill, not
		// transcripts. Only .jsonl files carry messages and cost.
		if (!entry.name.endsWith(".jsonl")) continue;
		const info = await stat(path).catch(() => null);
		if (!info) continue;
		out.push({
			kind: entry.name === "__advisor.jsonl" ? "advisor" : "subagent",
			name: `${prefix}${entry.name.replace(/\.jsonl$/, "")}`,
			path,
			size: info.size,
			mtime_ms: info.mtimeMs,
		});
	}
}

/**
 * ~/.omp/agent/sessions/<slugified-cwd>/<ISO-ts>_<session-id>.jsonl, with an
 * optional sibling directory of the same basename holding __advisor.jsonl,
 * subagent logs and tool-output spill.
 *
 * Filesystem-only by design: no omp internals, so the scan keeps working
 * across harness versions.
 */
// Why a factory: the sessions directory is injectable so the scanner can be
// exercised against a fixture tree instead of the user's real corpus.
function createOmpSessionSource(sessionsDir: string = SESSIONS_DIR): SessionSource {
	return {
		name: "omp",
		readEntries: readJsonl,
		async listSessions(): Promise<SessionScan> {
			const sessions: SessionRef[] = [];
			let projects: DirEntry[] = [];
			try {
				projects = await readdir(sessionsDir, { withFileTypes: true });
			} catch {
				return { sessions, duplicate_logs: 0 };
			}

			for (const project of projects) {
				if (!project.isDirectory()) continue;
				const projectDir = join(sessionsDir, project.name);
				let entries: DirEntry[] = [];
				try {
					entries = await readdir(projectDir, { withFileTypes: true });
				} catch {
					continue;
				}
				const sidecarDirs = new Set(
					entries.filter((e) => e.isDirectory()).map((e) => e.name),
				);

				for (const entry of entries) {
					if (entry.isDirectory() || !entry.name.endsWith(".jsonl")) continue;
					const base = entry.name.replace(/\.jsonl$/, "");
					const path = join(projectDir, entry.name);
					const info = await stat(path).catch(() => null);
					if (!info) continue;

					const sidecars: SidecarRef[] = [];
					if (sidecarDirs.has(base))
						await collectSidecars(join(projectDir, base), "", sidecars);

					// <ISO-ts>_<session-id>: the id is authoritative from the session
					// record, but the filename gives it before parsing so the meta
					// cache can be consulted without reading the log.
					const sep = base.indexOf("_");
					sessions.push({
						id: sep >= 0 ? base.slice(sep + 1) : base,
						path,
						project_path: "",
						size: info.size,
						created: info.birthtime.getTime() ? info.birthtime : info.mtime,
						modified: info.mtime,
						sidecars,
						signature: [
							`${info.size}:${info.mtimeMs}`,
							...sidecars.map((s) => `${s.name}=${s.size}:${s.mtime_ms}`),
						].join("|"),
					});
				}
			}

			// The same session can exist twice on disk under two slugified-cwd
			// directories (a copied or relocated log keeps its session record id).
			// Counting it twice would double-count its spend, so the largest copy
			// wins — it is the most complete one.
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

const ompSessionSource = createOmpSessionSource();

// ─── Session Parsing ──────────────────────────────────────────────────────────

type AnyEntry = Record<string, unknown>;
type AnyMessage = Record<string, unknown>;
type ContentBlock = {
	type: string;
	text?: string;
	name?: string;
	arguments?: Record<string, unknown>;
	[k: string]: unknown;
};

function getLanguageFromPath(filePath: string): string | null {
	return EXTENSION_TO_LANGUAGE[extname(filePath).toLowerCase()] ?? null;
}

function extractTextFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return (content as ContentBlock[])
		.filter((b) => b.type === "text" && typeof b.text === "string")
		.map((b) => b.text as string)
		.join(" ");
}

function isHumanMessage(msg: AnyMessage): boolean {
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

function countNewlines(s: string): number {
	return (s.match(/\n/g) ?? []).length;
}

/** Detect sessions that were spawned by the insights pipeline itself */
function isMetaSession(entries: AnyEntry[]): boolean {
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

type UsageRecord = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
};

type ModelUsageMap = Record<
	string,
	{ input_tokens: number; output_tokens: number; cost: number; message_count: number }
>;

/**
 * omp prices every model call itself: assistant messages carry
 * `message.usage`, and out-of-band calls (titles, auto-thinking, advisor
 * prompts) are `model_usage` records. Both hold `usage.cost.total` in USD, so
 * this port reads the recorded cost instead of re-deriving it from token
 * counts and a price table the way upstream had to.
 */
function readUsage(usage: unknown): UsageRecord {
	const u = (usage ?? {}) as Record<string, unknown>;
	const cost = (u.cost ?? {}) as Record<string, unknown>;
	return {
		input: typeof u.input === "number" ? u.input : 0,
		output: typeof u.output === "number" ? u.output : 0,
		cacheRead: typeof u.cacheRead === "number" ? u.cacheRead : 0,
		cacheWrite: typeof u.cacheWrite === "number" ? u.cacheWrite : 0,
		cost: typeof cost.total === "number" ? cost.total : 0,
	};
}

function addUsage(target: UsageRecord, add: UsageRecord): void {
	target.input += add.input;
	target.output += add.output;
	target.cacheRead += add.cacheRead;
	target.cacheWrite += add.cacheWrite;
	target.cost += add.cost;
}

function accumulateModel(
	map: ModelUsageMap,
	model: string,
	usage: UsageRecord,
): void {
	const slot = (map[model] ??= {
		input_tokens: 0,
		output_tokens: 0,
		cost: 0,
		message_count: 0,
	});
	slot.input_tokens += usage.input;
	slot.output_tokens += usage.output;
	slot.cost += usage.cost;
	slot.message_count++;
}

const TOOL_ERROR_FAMILY: Record<string, string> = {
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
function toolErrorCategory(toolName: string): string {
	if (!toolName) return "Unknown Tool";
	if (toolName.startsWith("mcp__"))
		return `MCP: ${toolName.slice(5).split("_")[0]}`;
	return TOOL_ERROR_FAMILY[toolName] ?? `${displayLabel(toolName)} Failed`;
}

type SidecarUsage = {
	totals: UsageRecord;
	utility_cost: number;
	model_usage: ModelUsageMap;
	tool_calls: number;
	tool_errors: number;
};

/**
 * Sidecar logs (advisor, subagents) are separate sessions with their own
 * spend. Only that spend and their tool volume are folded into the parent:
 * their "user" messages are prompts omp wrote, so counting them as human
 * activity would corrupt message counts, response times and hour-of-day.
 */
function extractSidecarUsage(entries: AnyEntry[]): SidecarUsage {
	const totals: UsageRecord = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
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

function extractSessionStats(entries: AnyEntry[]) {
	const toolCounts: Record<string, number> = {};
	const languages: Record<string, number> = {};
	const toolErrorCategories: Record<string, number> = {};
	const filesModified = new Set<string>();
	const userResponseTimes: number[] = [];
	const messageHours: number[] = [];
	const userMessageTimestamps: string[] = [];
	const ttfts: number[] = [];
	const responseDurations: number[] = [];
	const totals: UsageRecord = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	const modelUsage: ModelUsageMap = {};

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

		// Assistant/user messages carry epoch-ms timestamps; fall back to the
		// envelope's ISO timestamp for records that do not.
		const msgTs =
			typeof msg.timestamp === "number"
				? msg.timestamp
				: Number.isNaN(entryTs)
					? null
					: entryTs;

		// ── assistant message ──
		if (msg.role === "assistant") {
			assistantMessageCount++;
			if (msgTs) lastAssistantTs = msgTs;

			const usage = readUsage(msg.usage);
			addUsage(totals, usage);
			accumulateModel(modelUsage, typeof msg.model === "string" ? msg.model : "unknown", usage);

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

					const args = (block.arguments as Record<string, unknown>) ?? {};
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
		if (msg.role === "toolResult" && msg.isError === true) {
			toolErrors++;
			const cat = toolErrorCategory((msg.toolName as string) ?? "");
			toolErrorCategories[cat] = (toolErrorCategories[cat] ?? 0) + 1;
		}
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
	};
}

/**
 * Fold a session and its sidecars into one SessionMeta. Cost is attributed to
 * the parent and broken out per class, so a run's total can be reconciled
 * against the logs while still showing where the money went.
 */
function buildSessionMeta(
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
			});
			// accumulateModel counts one message; restore the real count.
			modelUsage[model]!.message_count += usage.message_count - 1;
		}
	}

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
		median_ttft_ms: median(stats.ttfts),
		median_response_ms: median(stats.responseDurations),
		model_usage: modelUsage,
	};
}

function formatTranscript(entries: AnyEntry[], meta: SessionMeta): string {
	const lines: string[] = [
		`Session: ${meta.session_id.slice(0, 8)}`,
		`Date: ${meta.start_time}`,
		`Project: ${meta.project_path}`,
		`Duration: ${meta.duration_minutes} min`,
		"",
	];

	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const msg = entry.message as AnyMessage | undefined;
		if (!msg) continue;

		if (msg.role === "user" && isHumanMessage(msg)) {
			const text = extractTextFromContent(msg.content).slice(0, 500);
			if (text.trim()) lines.push(`[User]: ${text}`);
		} else if (msg.role === "assistant") {
			const content = msg.content;
			if (Array.isArray(content)) {
				for (const block of content as ContentBlock[]) {
					if (block.type === "text" && block.text) {
						lines.push(`[Assistant]: ${(block.text as string).slice(0, 300)}`);
					} else if (block.type === "toolCall" && block.name) {
						lines.push(`[Tool: ${block.name as string}]`);
					}
				}
			}
		}
	}

	return lines.join("\n");
}

// ─── Parallel Session Detection ───────────────────────────────────────────────

/** Sessions whose user messages interleave inside a 30-minute window. */
function detectConcurrentSessions(
	sessions: Array<{ session_id: string; user_message_timestamps: string[] }>,
) {
	const all: Array<{ ts: number; sid: string }> = [];
	for (const s of sessions) {
		for (const iso of s.user_message_timestamps) {
			const ts = new Date(iso).getTime();
			if (!isNaN(ts)) all.push({ ts, sid: s.session_id });
		}
	}
	all.sort((a, b) => a.ts - b.ts);

	const pairs = new Set<string>();
	const duringMsgs = new Set<string>();
	let windowStart = 0;
	const sessionLastIdx = new Map<string, number>();

	for (let i = 0; i < all.length; i++) {
		const msg = all[i]!;
		while (
			windowStart < i &&
			msg.ts - all[windowStart]!.ts > OVERLAP_WINDOW_MS
		) {
			const exp = all[windowStart]!;
			if (sessionLastIdx.get(exp.sid) === windowStart)
				sessionLastIdx.delete(exp.sid);
			windowStart++;
		}
		const prevIdx = sessionLastIdx.get(msg.sid);
		if (prevIdx !== undefined) {
			for (let j = prevIdx + 1; j < i; j++) {
				const between = all[j]!;
				if (between.sid !== msg.sid) {
					const pair = [msg.sid, between.sid].sort().join(":");
					pairs.add(pair);
					duringMsgs.add(`${all[prevIdx]!.ts}:${msg.sid}`);
					duringMsgs.add(`${between.ts}:${between.sid}`);
					duringMsgs.add(`${msg.ts}:${msg.sid}`);
					break;
				}
			}
		}
		sessionLastIdx.set(msg.sid, i);
	}

	const involvedSessions = new Set<string>();
	for (const pair of pairs) {
		const [a, b] = pair.split(":");
		if (a) involvedSessions.add(a);
		if (b) involvedSessions.add(b);
	}

	return {
		overlap_events: pairs.size,
		sessions_involved: involvedSessions.size,
		user_messages_during: duringMsgs.size,
	};
}

// ─── Aggregation ──────────────────────────────────────────────────────────────

function median(arr: number[]): number {
	if (!arr.length) return 0;
	const s = [...arr].sort((a, b) => a - b);
	const mid = Math.floor(s.length / 2);
	return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function mergeRecord(
	target: Record<string, number>,
	source: Record<string, number>,
) {
	for (const [k, v] of Object.entries(source)) {
		target[k] = (target[k] ?? 0) + v;
	}
}

function top8(rec: Record<string, number>): [string, number][] {
	return Object.entries(rec)
		.sort((a, b) => b[1] - a[1])
		.slice(0, 8);
}

function aggregateData(
	metas: SessionMeta[],
	facetsMap: Map<string, SessionFacets>,
): AggregatedData {
	const agg: AggregatedData = {
		total_sessions: metas.length,
		sessions_with_facets: 0,
		date_range: { start: "", end: "" },
		total_messages: 0,
		total_duration_hours: 0,
		total_input_tokens: 0,
		total_output_tokens: 0,
		total_cost: 0,
		tool_counts: {},
		languages: {},
		git_commits: 0,
		git_pushes: 0,
		projects: {},
		goal_categories: {},
		outcomes: {},
		satisfaction: {},
		helpfulness: {},
		session_types: {},
		friction: {},
		success: {},
		session_summaries: [],
		friction_details: [],
		user_instructions: [],
		total_interruptions: 0,
		total_tool_errors: 0,
		tool_error_categories: {},
		user_response_times: [],
		median_response_time: 0,
		avg_response_time: 0,
		sessions_using_subagent: 0,
		sessions_using_mcp: 0,
		total_lines_added: 0,
		total_lines_removed: 0,
		total_files_modified: 0,
		days_active: 0,
		message_hours: [],
		concurrent_sessions: {
			overlap_events: 0,
			sessions_involved: 0,
			user_messages_during: 0,
		},
		total_cost_primary: 0,
		total_cost_advisor: 0,
		total_cost_subagent: 0,
		total_utility_cost: 0,
		total_cache_read_tokens: 0,
		total_cache_write_tokens: 0,
		advisor_logs: 0,
		subagent_logs: 0,
		sessions_with_sidecars: 0,
		total_thinking_escalations: 0,
		total_model_switches: 0,
		total_compactions: 0,
		total_steering: 0,
		median_ttft_ms: 0,
		model_usage: {},
		model_efficiency: [],
		estimated_waste: 0,
	};

	const dates: string[] = [];
	const activeDays = new Set<string>();

	// Decay weighting: half-life of 10 days for facet-derived charts
	const latestTs = metas.reduce((max, m) => {
		const t = new Date(m.start_time).getTime();
		return t > max ? t : max;
	}, 0);
	const HALF_LIFE_MS = 10 * 86400000;
	const LAMBDA = Math.log(2) / HALF_LIFE_MS;

	function decayWeight(meta: SessionMeta): number {
		const age = latestTs - new Date(meta.start_time).getTime();
		return Math.exp(-LAMBDA * age);
	}

	function mergeWeighted(target: Record<string, number>, source: Record<string, number>, weight: number) {
		for (const [k, v] of Object.entries(source)) {
			target[k] = (target[k] ?? 0) + v * weight;
		}
	}

	for (const meta of metas) {
		agg.total_messages += meta.user_message_count;
		agg.total_duration_hours += meta.duration_minutes / 60;
		agg.total_input_tokens += meta.input_tokens;
		agg.total_output_tokens += meta.output_tokens;
		agg.total_cost += meta.total_cost;
		mergeRecord(agg.tool_counts, meta.tool_counts);
		mergeRecord(agg.languages, meta.languages);
		mergeRecord(agg.tool_error_categories, meta.tool_error_categories);
		agg.git_commits += meta.git_commits;
		agg.git_pushes += meta.git_pushes;
		agg.total_interruptions += meta.user_interruptions;
		agg.total_tool_errors += meta.tool_errors;
		agg.total_lines_added += meta.lines_added;
		agg.total_lines_removed += meta.lines_removed;
		agg.total_files_modified += meta.files_modified;
		agg.user_response_times.push(...meta.user_response_times);
		agg.message_hours.push(...meta.message_hours);
		if (meta.uses_subagent) agg.sessions_using_subagent++;
		if (meta.uses_mcp) agg.sessions_using_mcp++;
		agg.total_cost_primary += meta.cost_primary;
		agg.total_cost_advisor += meta.cost_advisor;
		agg.total_cost_subagent += meta.cost_subagent;
		agg.total_utility_cost += meta.utility_cost;
		agg.total_cache_read_tokens += meta.cache_read_tokens;
		agg.total_cache_write_tokens += meta.cache_write_tokens;
		agg.advisor_logs += meta.sidecar_counts.advisor;
		agg.subagent_logs += meta.sidecar_counts.subagent;
		if (meta.sidecar_counts.advisor + meta.sidecar_counts.subagent > 0)
			agg.sessions_with_sidecars++;
		agg.total_thinking_escalations += meta.thinking_escalations;
		agg.total_model_switches += meta.model_switches;
		agg.total_compactions += meta.compactions;
		agg.total_steering += meta.steering_messages;

		// Aggregate per-model usage
		for (const [model, usage] of Object.entries(meta.model_usage ?? {})) {
			if (!agg.model_usage[model]) agg.model_usage[model] = { input_tokens: 0, output_tokens: 0, cost: 0, message_count: 0, sessions: 0 };
			agg.model_usage[model]!.input_tokens += usage.input_tokens;
			agg.model_usage[model]!.output_tokens += usage.output_tokens;
			agg.model_usage[model]!.cost += usage.cost;
			agg.model_usage[model]!.message_count += usage.message_count;
			agg.model_usage[model]!.sessions++;
		}

		if (meta.start_time) {
			dates.push(meta.start_time);
			activeDays.add(meta.start_time.slice(0, 10));
		}

		if (meta.project_path) {
			const proj = meta.project_path.replace(/.*\//, "") || meta.project_path;
			agg.projects[proj] = (agg.projects[proj] ?? 0) + 1;
		}

		const facets = facetsMap.get(meta.session_id);
		if (facets) {
			agg.sessions_with_facets++;
			const w = decayWeight(meta);
			mergeWeighted(agg.goal_categories, facets.goal_categories, w);
			if (facets.outcome)
				agg.outcomes[facets.outcome] = (agg.outcomes[facets.outcome] ?? 0) + w;
			mergeWeighted(agg.satisfaction, facets.user_satisfaction_counts, w);
			if (facets.assistant_helpfulness)
				agg.helpfulness[facets.assistant_helpfulness] =
					(agg.helpfulness[facets.assistant_helpfulness] ?? 0) + w;
			if (facets.session_type)
				agg.session_types[facets.session_type] =
					(agg.session_types[facets.session_type] ?? 0) + w;
			mergeWeighted(agg.friction, facets.friction_counts, w);
			if (facets.primary_success && facets.primary_success !== "none") {
				agg.success[facets.primary_success] =
					(agg.success[facets.primary_success] ?? 0) + w;
			}
			agg.session_summaries.push({
				id: meta.session_id.slice(0, 8),
				date: meta.start_time.slice(0, 10),
				summary: facets.brief_summary,
				outcome: facets.outcome,
				helpfulness: facets.assistant_helpfulness,
			});
			if (facets.friction_detail?.trim())
				agg.friction_details.push(facets.friction_detail.trim());
			if (facets.user_instructions_to_assistant) {
				agg.user_instructions.push(...facets.user_instructions_to_assistant);
			}
		}
	}

	dates.sort();
	agg.date_range = {
		start: dates[0]?.slice(0, 10) ?? "",
		end: dates[dates.length - 1]?.slice(0, 10) ?? "",
	};
	agg.days_active = activeDays.size;
	agg.median_response_time = median(agg.user_response_times);
	agg.avg_response_time = agg.user_response_times.length
		? agg.user_response_times.reduce((a, b) => a + b, 0) /
			agg.user_response_times.length
		: 0;

	// Trim to caps
	agg.session_summaries = agg.session_summaries.slice(-50);
	agg.friction_details = agg.friction_details.slice(0, 20);
	agg.user_instructions = agg.user_instructions.slice(0, 15);

	agg.median_ttft_ms = median(
		metas.map((m) => m.median_ttft_ms).filter((v) => v > 0),
	);

	agg.concurrent_sessions = detectConcurrentSessions(
		metas.map((m) => ({
			session_id: m.session_id,
			user_message_timestamps: m.user_message_timestamps,
		})),
	);

	// Model efficiency analysis
	// Classify models by observed cost-per-token from actual usage data.
	// Models with negligible cost-per-token (subscriptions like Mistral Pro, ChatGPT Plus)
	// are classified as "subscription" and excluded from cost optimization recommendations.
	const MODEL_TIERS: Record<string, "high" | "mid" | "low" | "subscription"> = {};
	const MODEL_CPT: Record<string, number> = {}; // cost per 1k tokens

	// Pre-compute cost-per-token for each model across all sessions
	for (const meta of metas) {
		for (const [model, usage] of Object.entries(meta.model_usage ?? {})) {
			const totalTokens = usage.input_tokens + usage.output_tokens;
			if (totalTokens > 0 && !MODEL_CPT[model]) {
				// Use aggregate data for a stable estimate
				const aggUsage = agg.model_usage[model];
				if (aggUsage) {
					const aggTotal = aggUsage.input_tokens + aggUsage.output_tokens;
					if (aggTotal > 0) MODEL_CPT[model] = (aggUsage.cost / aggTotal) * 1000;
				}
			}
		}
	}

	// Derive tiers from cost-per-token distribution
	const cptValues = Object.values(MODEL_CPT).filter(v => v > 0);
	const cptMedian = cptValues.length ? cptValues.sort((a, b) => a - b)[Math.floor(cptValues.length / 2)]! : 0.01;

	const classifyModel = (name: string): "high" | "mid" | "low" | "subscription" => {
		if (MODEL_TIERS[name]) return MODEL_TIERS[name]!;
		const cpt = MODEL_CPT[name];
		// Subscription detection: effectively zero cost-per-token or no cost recorded
		// despite significant usage (fixed monthly plans)
		const aggUsage = agg.model_usage[name];
		if (aggUsage && (aggUsage.input_tokens + aggUsage.output_tokens) > 10000 && aggUsage.cost < 0.01) {
			MODEL_TIERS[name] = "subscription";
			return "subscription";
		}
		if (!cpt || cpt < 0.001) {
			// Very low cost, likely subscription or free tier
			if (aggUsage && aggUsage.message_count > 20) {
				MODEL_TIERS[name] = "subscription";
				return "subscription";
			}
			MODEL_TIERS[name] = "low";
			return "low";
		}
		// Classify relative to the median observed cost-per-token
		if (cpt > cptMedian * 3) {
			MODEL_TIERS[name] = "high";
		} else if (cpt < cptMedian * 0.4) {
			MODEL_TIERS[name] = "low";
		} else {
			MODEL_TIERS[name] = "mid";
		}
		return MODEL_TIERS[name]!;
	};

	const COMPLEX_TYPES = new Set(["multi_task", "iterative_refinement"]);
	const SIMPLE_TYPES = new Set(["quick_question", "single_task"]);

	let estimatedWaste = 0;

	for (const meta of metas) {
		const facets = facetsMap.get(meta.session_id);
		if (!facets) continue;

		// Determine primary model (highest cost or most messages)
		const models = Object.entries(meta.model_usage ?? {});
		if (!models.length) continue;
		const primaryModel = models.sort((a, b) => b[1].cost - a[1].cost)[0]!;
		const [modelName, modelStats] = primaryModel;
		const tier = classifyModel(modelName);

		const isSimple = SIMPLE_TYPES.has(facets.session_type)
			|| (meta.user_message_count <= 3 && meta.duration_minutes < 5);
		const isComplex = COMPLEX_TYPES.has(facets.session_type)
			|| meta.user_message_count > 8
			|| meta.files_modified > 5;
		const poorOutcome = facets.outcome === "not_achieved" || facets.outcome === "partially_achieved";
		const goodOutcome = facets.outcome === "fully_achieved" || facets.outcome === "mostly_achieved";

		let flag: "overspend" | "underspend" | "quota_pressure" | "ok" = "ok";
		let reason = "";

		// Subscription models: no dollar cost, but quota is finite.
		// Within a subscription plan, heavier models consume more quota (messages,
		// tokens, or rate limit budget) than lighter ones. For example:
		// - Mistral Pro: Medium 3.5 uses more of message quota than Small
		// - OpenAI Plus: o1/o3 burn cap faster than GPT-4o-mini
		// - Google: Pro uses more TPM budget than Flash
		// Flag when a subscription's heavier model is used for trivial tasks.
		if (tier === "subscription") {
			if (isSimple && goodOutcome && modelStats.message_count > 3) {
				// Check if there's a lighter subscription model available from the same provider
				const modelLower = modelName.toLowerCase();
				const provider = modelLower.includes("mistral") ? "mistral"
					: modelLower.includes("gpt") || modelLower.includes("o1") || modelLower.includes("o3") ? "openai"
					: modelLower.includes("gemini") ? "google"
					: modelLower.includes("claude") ? "anthropic" : "unknown";
				
				// Detect if this is a "heavy" model within its subscription
				const isHeavySubscription = /medium|large|pro|opus|o[13]/i.test(modelLower)
					&& !/small|mini|flash|haiku|lite/i.test(modelLower);
				
				if (isHeavySubscription) {
					flag = "quota_pressure";
					reason = `Used ${modelName} (subscription) for a simple ${facets.session_type}. Within your plan, this model consumes more quota than lighter alternatives. Consider using a smaller model from the same subscription (e.g. ${provider === "mistral" ? "Mistral Small" : provider === "openai" ? "GPT-4o-mini" : provider === "google" ? "Gemini Flash" : "a lighter tier"}) for trivial tasks, or offload to a cheap PAYG model to preserve quota for complex work.`;
				} else {
					// Already using a light subscription model for simple tasks: this is fine
					// No flag needed
				}
			}
		}
		// PAYG overspend: expensive model on simple task
		else if (tier === "high" && isSimple && goodOutcome) {
			flag = "overspend";
			reason = `Used ${modelName} for a simple ${facets.session_type} that completed successfully. A lower-tier model would likely suffice.`;
			estimatedWaste += modelStats.cost * 0.8;
		}
		// PAYG underspend: low-tier model on complex task with poor outcome
		else if (tier === "low" && isComplex && poorOutcome) {
			flag = "underspend";
			reason = `Used ${modelName} for a complex ${facets.session_type} that ended with ${facets.outcome}. A more capable model may have succeeded.`;
			estimatedWaste += modelStats.cost;
		}
		// PAYG overspend: expensive model on ANY task with poor outcome (wasted tokens)
		else if (tier === "high" && poorOutcome && modelStats.cost > 0.10) {
			flag = "overspend";
			reason = `Spent $${modelStats.cost.toFixed(2)} on ${modelName} but outcome was ${facets.outcome}. Tokens were burned without reaching the goal.`;
			estimatedWaste += modelStats.cost * 0.5;
		}

		if (flag !== "ok") {
			agg.model_efficiency.push({
				model: modelName,
				session_id: meta.session_id,
				date: meta.start_time.slice(0, 10),
				cost: modelStats.cost,
				outcome: facets.outcome,
				session_type: facets.session_type,
				goal: facets.underlying_goal?.slice(0, 80) ?? "",
				flag,
				reason,
			});
		}
	}

	agg.estimated_waste = estimatedWaste;
	agg.model_efficiency.sort((a, b) => b.cost - a.cost);
	agg.model_efficiency = agg.model_efficiency.slice(0, 20);

	// Annotate model_usage with tier info for downstream prompts
	for (const [model, usage] of Object.entries(agg.model_usage)) {
		usage.tier = MODEL_TIERS[model] || "mid";
	}

	return agg;
}

// ─── LLM Calling ─────────────────────────────────────────────────────────────

/**
 * omp hands extensions credentials (`ctx.modelRegistry.getApiKeyAndHeaders`)
 * but no completion client, so this shells out to omp itself instead of
 * reimplementing a provider client.
 *
 * Why a subprocess: `omp -p` already speaks every provider dialect and auth
 * scheme omp supports, including the OAuth-backed ones a fallback chain
 * reaches on a rate limit. An in-process HTTP client would have to own
 * anthropic-messages, openai-responses and github-copilot and would rot the
 * first time a model role moved. The prompt goes over stdin, not argv, so
 * transcript-sized prompts cannot hit an argument-length limit.
 *
 * `--no-session` keeps these calls out of the session corpus this report
 * reads, and `--no-tools --no-extensions --no-skills` keeps them from doing
 * anything but answering.
 */
async function callModel(
	prompt: string,
	opts: { model?: string; timeoutMs?: number } = {},
): Promise<string> {
	const args = ["--no-session", "--no-tools", "--no-extensions", "--no-skills", "--no-title"];
	if (opts.model) args.push("--model", opts.model);
	args.push("-p");

	const child = execFileCb(
		OMP_BIN,
		args,
		{ maxBuffer: 32 * 1024 * 1024, timeout: opts.timeoutMs ?? MODEL_CALL_TIMEOUT_MS },
		() => {},
	);

	const stdout: string[] = [];
	const stderr: string[] = [];
	child.stdout?.on("data", (c: Buffer) => stdout.push(c.toString()));
	child.stderr?.on("data", (c: Buffer) => stderr.push(c.toString()));
	child.stdin?.end(prompt);

	const code = await new Promise<number>((resolve, reject) => {
		child.on("error", reject);
		child.on("close", (c) => resolve(c ?? -1));
	});

	const text = stdout.join("");
	if (code !== 0) {
		throw new Error(
			`omp -p exited ${code}: ${(stderr.join("") || text).trim().slice(0, 300)}`,
		);
	}
	// `omp -p` prints a progress line before the answer on a TTY-less run.
	return text.replace(/^Working\.\.\.\s*/, "").trim();
}

function parseJsonFromResponse(text: string): unknown {
	const match = text.match(/\{[\s\S]*\}/);
	if (!match) return null;
	try {
		return JSON.parse(match[0]);
	} catch {
		return null;
	}
}

// ─── Prompts ──────────────────────────────────────────────────────────────────

const CHUNK_SUMMARIZE_PROMPT = `Summarize this portion of a session transcript. Focus on:
1. What the user asked for
2. What the assistant did (tools used, files modified)
3. Any friction or issues
4. The outcome

Keep it concise - 3-5 sentences. Preserve specific details like file names, error messages, and user feedback.

TRANSCRIPT CHUNK:
`;

const FACET_EXTRACT_PROMPT = `Analyze this session and extract structured facets.

CRITICAL GUIDELINES:

1. goal_categories: Count ONLY what the USER explicitly asked for.
   - DO NOT count autonomous exploration the assistant decided to do
   - ONLY count when user says "can you...", "please...", "I need...", "let's..."

2. user_satisfaction_counts: Base ONLY on explicit user signals.
   - "Yay!", "great!", "perfect!" → happy
   - "thanks", "looks good", "that works" → satisfied
   - "ok, now let's..." (continuing without complaint) → likely_satisfied
   - "that's not right", "try again" → dissatisfied
   - "this is broken", "I give up" → frustrated

3. friction_counts: Be specific about what went wrong.
   - misunderstood_request: assistant interpreted the request incorrectly
   - wrong_approach: right goal, wrong solution method
   - buggy_code: code didn't work correctly
   - user_rejected_action: user said no/stop to a proposed action
   - excessive_changes: over-engineered or changed too much

4. user_instructions_to_assistant: direct instructions the user gave, e.g. "always show diffs before editing". Include only reusable instructions (not one-off requests).

5. If very short or just a warmup, use warmup_minimal for goal_category

SESSION:
`;

function buildSharedDataBlock(agg: AggregatedData, temporal: TemporalData, userCtx: UserContext): string {
	return (
		JSON.stringify(
			{
				sessions: agg.total_sessions,
				analyzed: agg.sessions_with_facets,
				date_range: agg.date_range,
				messages: agg.total_messages,
				hours: Math.round(agg.total_duration_hours),
				commits: agg.git_commits,
				cost_usd: agg.total_cost.toFixed(2),
				top_tools: top8(agg.tool_counts),
				top_goals: top8(agg.goal_categories),
				outcomes: agg.outcomes,
				satisfaction: agg.satisfaction,
				friction: agg.friction,
				success: agg.success,
				languages: agg.languages,
				lines_added: agg.total_lines_added,
				lines_removed: agg.total_lines_removed,
				files_modified: agg.total_files_modified,
				concurrent_sessions: agg.concurrent_sessions,
				cost_primary_usd: agg.total_cost_primary.toFixed(2),
				cost_advisor_usd: agg.total_cost_advisor.toFixed(2),
				cost_subagent_usd: agg.total_cost_subagent.toFixed(2),
				cache_read_tokens: agg.total_cache_read_tokens,
				cache_write_tokens: agg.total_cache_write_tokens,
				thinking_escalations: agg.total_thinking_escalations,
				model_switches: agg.total_model_switches,
				compactions: agg.total_compactions,
				steering_messages: agg.total_steering,
				subagent_sessions: agg.sessions_using_subagent,
				mcp_sessions: agg.sessions_using_mcp,
				model_usage: agg.model_usage,
				model_efficiency_flags: agg.model_efficiency.length,
				estimated_waste_usd: agg.estimated_waste.toFixed(2),
			},
			null,
			2,
		) +
		`

SESSION SUMMARIES:
${agg.session_summaries.map((s) => `- ${s.summary} (${s.outcome}, ${s.helpfulness})`).join("\n")}

FRICTION DETAILS:
${agg.friction_details.map((d) => `- ${d}`).join("\n")}

USER INSTRUCTIONS TO ASSISTANT:
${agg.user_instructions.map((i) => `- ${i}`).join("\n")}` +
		`\n\nTEMPORAL CONTEXT:\n${temporal.diff_headlines.length ? "What changed this week: " + temporal.diff_headlines.join("; ") : "No significant weekly changes."}\nTrajectory: ${temporal.trajectory.note}\n${temporal.major_transition ? "Major transition on " + temporal.major_transition.when + ": " + temporal.major_transition.what + " (" + temporal.major_transition.impact + ")" : ""}\n${temporal.anomalies.length ? "Notable outlier sessions: " + temporal.anomalies.map(a => a.date + " " + a.cost + " - " + a.reason).join("; ") : ""}\nResolved friction (DO NOT suggest fixes): ${temporal.resolved_friction.map(f => displayLabel(f)).join(", ") || "none"}\nOngoing friction (FOCUS here): ${temporal.ongoing_friction.map(f => displayLabel(f.type) + " (" + f.recent_count + " in last 14d)").join(", ") || "none"}\n\nUSER EXISTING SETUP (DO NOT suggest what's already present):\nDefault model: ${userCtx.default_model || "not set"}\nModel roles: ${Object.entries(userCtx.model_roles).map(([r, m]) => r + "=" + m).join(", ") || "none"}\nFallback chains: ${Object.entries(userCtx.fallback_chains).map(([r, c]) => r + "=" + c.join(">")).join(", ") || "none"}\nSkills: ${userCtx.installed_skills.join(", ") || "none"}\nManaged skills: ${userCtx.installed_managed_skills.join(", ") || "none"}\nExtensions: ${userCtx.installed_extensions.join(", ") || "none"}\nHooks: ${userCtx.installed_hooks.join(", ") || "none"}\nMCP servers: ${userCtx.mcp_servers.join(", ") || "none"}\nExisting AGENTS.md rules: ${userCtx.existing_agents_md_rules.slice(0, 10).join(" | ") || "none"}`
	);
}

// Why this list is load-bearing: the model can only suggest features it is
// told exist, so a wrong or Pi-shaped list is the main way the report turns
// into useless advice. Keep it aligned with omp's real surface.
const OMP_FEATURES_REFERENCE = `## OMP FEATURES REFERENCE:
1. Skills — SKILL.md procedures in ~/.omp/agent/skills/ (user-authored) and
   ~/.omp/agent/managed-skills/ (agent-authored via the manage_skill tool);
   surfaced automatically by name/description match, read with skill://<name>
   - Good for: repeatable procedures, debugging recipes, project workflows
   - Rule: never suggest a skill whose name already appears in the installed list

2. Memory (learn tool) — durable project/user facts recorded to long-term
   memory, summarised at memory://root
   - Good for: conventions, non-obvious fixes, user preferences that must survive sessions

3. Hooks — executables under ~/.omp/agent/hooks/<event>/ (e.g. pre/) that run
   on tool lifecycle events and can block or annotate a call
   - Good for: format/type gates, permission gates, injecting scoped instructions

4. Extensions — TypeScript modules in ~/.omp/agent/extensions/ that register
   commands, tools and widgets (this report is one)
   - Good for: custom commands, external integrations, bespoke UI

5. Subagents (task tool) — background agents with their own context, batched in
   one tasks[] array; typed agents (scout for read-only research, reviewer,
   sonic for mechanical edits); coordinate over hub messaging
   - Good for: parallel independent slices, unknown-code mapping, review passes

6. xd:// tool devices — schema-driven tools invoked by writing JSON args
   (ast_edit for codemods, lsp for symbol-aware refactors, debug for DAP,
   github for gh ops, plus every mounted MCP tool)
   - Good for: structural rewrites, reference-safe renames, breakpoint debugging

7. MCP servers — configured in ~/.omp/agent/mcp.json, mounted as xd:// devices
   - Good for: Jira/Confluence, Outline, Sentry, Metabase, Postgres and similar

8. Model roles and fallback chains — ~/.omp/agent/config.yml modelRoles
   (default, plan, task, smol, tiny, advisor) and retry.fallbackChains
   - Good for: routing cheap work to smol/tiny, pinning a stronger default,
     surviving provider rate limits

9. Advisor — a second model reviewing the main loop, logged to a per-session
   __advisor.jsonl sidecar with its own cost
   - Good for: catching wrong turns early; costs real money, so worth toggling

10. AGENTS.md — per-repo instruction files, plus scoped
   .agent/instructions/*.instructions.md with applyTo globs
   - Good for: team conventions and per-path rules the agent always follows`;

function buildSectionPrompts(data: string, temporal: TemporalData, userCtx: UserContext, agg: AggregatedData) {
	return {
		project_areas: `Analyze this usage data and identify project areas.

RESPOND WITH ONLY A VALID JSON OBJECT:
{
  "areas": [
    {
      "name": "area name",
      "session_count": N,
      "description": "2-3 sentences about what was worked on and how Pi was used"
    }
  ]
}

Include 4-5 areas. Skip internal tooling sessions.

DATA:
${data}`,

		interaction_style: `Analyze this usage data and describe the user's interaction style with Pi.

RESPOND WITH ONLY A VALID JSON OBJECT:
{
  "narrative": "2-3 paragraphs analyzing HOW the user interacts. Use second person 'you'. Describe patterns: do they iterate quickly or write detailed specs upfront? Do they interrupt often or let it run? Include specific examples. Use **bold** for key insights.",
  "key_pattern": "one sentence summary of the most distinctive interaction style"
}

DATA:
${data}`,

		what_works: `Analyze this usage data and identify what's working well for this user with Pi.
Use second person ("you").

RESPOND WITH ONLY A VALID JSON OBJECT:
{
  "intro": "1 sentence of context",
  "impressive_workflows": [
    {
      "title": "short title (3-6 words)",
      "description": "2-3 sentences describing the workflow. Use 'you' not 'the user'."
    }
  ]
}

Include 3 impressive workflows.

DATA:
${data}`,

		friction_analysis: `Analyze this usage data and identify friction points for this user.
Use second person ("you").

TEMPORAL CONTEXT:
- Resolved friction (no longer occurring): ${temporal.resolved_friction.map(f => displayLabel(f)).join(", ") || "none detected"}
- Ongoing friction (still happening): ${temporal.ongoing_friction.map(f => displayLabel(f.type) + " (" + f.recent_count + " in last 14 days)").join(", ") || "none detected"}

Focus on ONGOING friction. Mention resolved items briefly as wins.

RESPOND WITH ONLY A VALID JSON OBJECT:
{
  "intro": "1 sentence summarizing friction trajectory (improving/worsening/stable)",
  "resolved": [
    {
      "category": "friction that stopped",
      "note": "brief note on resolution"
    }
  ],
  "ongoing": [
    {
      "category": "concrete category name",
      "description": "1-2 sentences. Use 'you' not 'the user'.",
      "examples": ["specific example with consequence", "another example"],
      "severity": "high|medium|low"
    }
  ]
}

Max 2 resolved, 3 ongoing.

DATA:
${data}`,

		suggestions: `Analyze this usage data and suggest improvements for working with omp.

${OMP_FEATURES_REFERENCE}

CRITICAL: The user's existing setup is in the data below. DO NOT suggest:
- Rules already in their AGENTS.md
- Skills (including managed skills), extensions, hooks or MCP servers they already have installed
- Fixes for "resolved friction" (listed in TEMPORAL CONTEXT)
FOCUS on ongoing friction. Include at least one NEGATIVE suggestion (something to stop/remove).
Tailor copyable prompts to their actual model (${userCtx.default_model || "unknown"}) and projects.

RESPOND WITH ONLY A VALID JSON OBJECT:
{
  "config_additions": [
    {
      "addition": "a specific rule NOT already in their AGENTS.md",
      "why": "1 sentence referencing actual ongoing friction",
      "where": "AGENTS.md | ~/.omp/agent/config.yml | ~/.omp/agent/extensions/ | ~/.omp/agent/managed-skills/ | ~/.omp/agent/hooks/"
    }
  ],
  "features_to_try": [
    {
      "feature": "feature name from OMP FEATURES REFERENCE",
      "one_liner": "what it does",
      "why_for_you": "why this helps YOUR ongoing friction patterns",
      "example": "actual command or config referencing their real projects"
    }
  ],
  "usage_patterns": [
    {
      "title": "short title",
      "suggestion": "1-2 sentence summary",
      "detail": "3-4 sentences referencing actual projects and patterns",
      "copyable_prompt": "specific prompt using their model, projects, tools"
    }
  ],
  "stop_doing": [
    {
      "what": "something to stop or remove",
      "why": "evidence from sessions",
      "alternative": "what to do instead"
    }
  ]
}

DATA:
${data}`,

		on_the_horizon: `Analyze this usage data and identify future opportunities as models become more capable.

RESPOND WITH ONLY A VALID JSON OBJECT:
{
  "intro": "1 sentence about the trajectory of AI-assisted development",
  "opportunities": [
    {
      "title": "short title (4-8 words)",
      "whats_possible": "2-3 ambitious sentences about autonomous Pi workflows",
      "how_to_try": "1-2 sentences on how to start experimenting with this",
      "copyable_prompt": "detailed prompt to try right now"
    }
  ]
}

Include 3 opportunities. Think ambitiously — autonomous workflows, parallel subagents, self-correcting pipelines, iterating against test suites.

DATA:
${data}`,

		fun_ending: `Analyze this usage data and find one memorable moment from the sessions.

RESPOND WITH ONLY A VALID JSON OBJECT:
{
  "headline": "a memorable QUALITATIVE moment from the transcripts — not a statistic. something human, funny, or genuinely surprising.",
  "detail": "brief context about when or where this happened"
}

Find something interesting or amusing. Avoid generic observations.

DATA:
${data}`,

		model_efficiency: (() => {
			const modelLines = Object.entries(agg.model_usage).sort((a, b) => b[1].cost - a[1].cost).map(([m, u]) => {
				const totalTok = u.input_tokens + u.output_tokens;
				const cpt = totalTok > 0 ? (u.cost / totalTok * 1000).toFixed(4) : "0";
				return `- ${m.replace(/.*\//, "")}: ${u.sessions} sessions, $${u.cost.toFixed(2)} total, ${u.message_count} msgs, tier=${u.tier || "mid"}, $/1k-tok=${cpt}`;
			}).join("\n");
			return `Analyze this model usage data and identify efficiency issues.

IMPORTANT CONTEXT:
- Model tiers are derived from observed cost-per-token in the user's actual usage
- Models marked as "subscription" are on fixed monthly plans (e.g. Mistral Pro, ChatGPT Plus, Gemini Advanced). Their effective dollar cost per token is $0. Do NOT recommend switching away from subscription models to "save money."
- However, subscriptions have finite quotas (rate limits, daily message caps, monthly token budgets). Within a subscription, heavier models consume more quota than lighter ones:
  * Mistral Pro: Medium 3.5 uses more message budget than Small or Codestral
  * OpenAI Plus: o1/o3 burn cap faster than GPT-4o or GPT-4o-mini
  * Google: Gemini Pro uses more TPM than Flash
  * Anthropic: Opus uses more quota than Sonnet or Haiku
- For subscription models: suggest using lighter models within the same plan for trivial tasks, reserving the heavy model for complex work.
- For PAYG models: optimize for dollar cost as usual.

The user's models from their sessions (derived from actual usage data):
${modelLines}

RESPOND WITH ONLY A VALID JSON OBJECT:
{
  "summary": "2-3 sentences summarizing model usage efficiency. Use 'you'. Be direct. Distinguish between dollar waste (PAYG) and quota waste (subscription).",
  "overspend_pattern": "1-2 sentences about when expensive PAYG models are used unnecessarily, or empty string if none. Never flag subscription models as dollar overspend.",
  "underspend_pattern": "1-2 sentences about when weaker models fail on complex tasks, or empty string if none",
  "quota_pressure": "1-2 sentences about subscription quota being burned by heavy models on trivial tasks. Suggest lighter models within the same subscription, or offloading to cheap PAYG. Empty string if no subscription models detected or if they're already using light subscription models.",
  "recommendation": "1-2 sentences with a specific model selection strategy. Reference the user's actual models by name. For subscriptions: use light models for simple tasks, reserve heavy ones for complex work. For PAYG: match tier to task complexity.",
  "potential_savings_note": "1 sentence about realistic savings. If most usage is subscription, frame as 'quota preservation' or 'extending your monthly budget' rather than dollar savings."
}

DATA:
${data}`;
		})(),
	};
}

function buildSynthesisPrompt(
	data: string,
	sections: Record<string, unknown>,
): string {
	return `You're writing an "At a Glance" section for a Pi usage insights report. The goal is to help the user understand their patterns and improve how they work with AI assistance.

Use this 4-part structure:

1. What's working
   What is the user's distinctive style and what impactful things have they done? Keep it high level. Don't be flattering or fluffy. Don't focus on which tools they use.

2. What's hindering you
   Split into two parts:
   (a) assistant-side failures — misunderstandings, wrong approaches, buggy output
   (b) user-side friction — insufficient context, environment issues, setup problems
   Be honest and constructive. Aim for patterns, not one-off incidents.

3. Quick wins to try
   Specific Pi features or workflow changes they could adopt immediately. Avoid generic advice — suggest concrete things.

4. Ambitious workflows
   As models become significantly more capable, what workflows that feel out of reach today will become practical?

Keep each part to 2-3 sentences. Coaching tone, not report tone. Don't cite specific numbers or raw category names.

RESPOND WITH ONLY A VALID JSON OBJECT:
{
  "whats_working": "...",
  "whats_hindering": "...",
  "quick_wins": "...",
  "ambitious_workflows": "..."
}

DATA:
${data}

## Project Areas
${JSON.stringify((sections.project_areas as { areas?: unknown })?.areas ?? [], null, 2)}

## Impressive Workflows
${JSON.stringify((sections.what_works as { impressive_workflows?: unknown })?.impressive_workflows ?? [], null, 2)}

## Friction Categories
${JSON.stringify((sections.friction_analysis as { categories?: unknown })?.categories ?? [], null, 2)}

## Features to Try
${JSON.stringify((sections.suggestions as { features_to_try?: unknown })?.features_to_try ?? [], null, 2)}

## Usage Patterns
${JSON.stringify((sections.suggestions as { usage_patterns?: unknown })?.usage_patterns ?? [], null, 2)}

## On the Horizon
${JSON.stringify((sections.on_the_horizon as { opportunities?: unknown })?.opportunities ?? [], null, 2)}`;
}

// ─── HTML Generation ──────────────────────────────────────────────────────────

function esc(s: unknown): string {
	return String(s ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function renderMarkdown(text: string): string {
	return text
		.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
		.replace(/\n\n/g, "</p><p>")
		.replace(/\n/g, "<br>")
		.replace(/^- /gm, "• ");
}

function wrapP(text: string): string {
	return `<p>${renderMarkdown(esc(text))}</p>`;
}

function barChart(
	data: Record<string, number>,
	opts: { order?: string[]; limit?: number } = {},
): string {
	let entries: [string, number][];
	if (opts.order) {
		entries = opts.order
			.filter((k) => k in data && data[k]! > 0)
			.map((k) => [k, data[k]!]);
	} else {
		entries = Object.entries(data).sort((a, b) => b[1] - a[1]);
		if (opts.limit) entries = entries.slice(0, opts.limit);
	}
	if (!entries.length) return "<p class='muted'>No data</p>";
	const max = Math.max(...entries.map(([, v]) => v));
	return entries
		.map(([key, val]) => {
			const pct = max > 0 ? (val / max) * 100 : 0;
			return `<div class="bar-row">
  <div class="bar-label">${esc(displayLabel(key))}</div>
  <div class="bar-track"><div class="bar-fill" style="width:${pct.toFixed(1)}%"></div></div>
  <div class="bar-count">${Math.round(val)}</div>
</div>`;
		})
		.join("\n");
}

function timeOfDayChart(hours: number[]): string {
	const buckets: Record<string, number> = {};
	for (let h = 0; h < 24; h++) buckets[String(h).padStart(2, "0") + ":00"] = 0;
	for (const h of hours) {
		const key = String(h).padStart(2, "0") + ":00";
		buckets[key] = (buckets[key] ?? 0) + 1;
	}
	const max = Math.max(...Object.values(buckets));
	return Object.entries(buckets)
		.map(([label, val]) => {
			const pct = max > 0 ? (val / max) * 100 : 0;
			return `<div class="bar-row compact">
  <div class="bar-label">${esc(label)}</div>
  <div class="bar-track"><div class="bar-fill" style="width:${pct.toFixed(1)}%"></div></div>
  <div class="bar-count">${val || ""}</div>
</div>`;
		})
		.join("\n");
}

function responseTimeChart(times: number[]): string {
	const buckets: Record<string, number> = {
		"2–10s": 0,
		"10–30s": 0,
		"30s–1m": 0,
		"1–2m": 0,
		"2–5m": 0,
		"5–15m": 0,
		">15m": 0,
	};
	for (const t of times) {
		if (t < 10) buckets["2–10s"]!++;
		else if (t < 30) buckets["10–30s"]!++;
		else if (t < 60) buckets["30s–1m"]!++;
		else if (t < 120) buckets["1–2m"]!++;
		else if (t < 300) buckets["2–5m"]!++;
		else if (t < 900) buckets["5–15m"]!++;
		else buckets[">15m"]!++;
	}
	const max = Math.max(...Object.values(buckets));
	return Object.entries(buckets)
		.map(([label, val]) => {
			const pct = max > 0 ? (val / max) * 100 : 0;
			return `<div class="bar-row">
  <div class="bar-label">${esc(label)}</div>
  <div class="bar-track"><div class="bar-fill" style="width:${pct.toFixed(1)}%"></div></div>
  <div class="bar-count">${val || ""}</div>
</div>`;
		})
		.join("\n");
}

function statCard(label: string, value: string, sub?: string): string {
	return `<div class="stat-card">
  <div class="stat-value">${esc(value)}</div>
  <div class="stat-label">${esc(label)}</div>
  ${sub ? `<div class="stat-sub">${esc(sub)}</div>` : ""}
</div>`;
}

function fmtHours(h: number): string {
	if (h < 1) return `${Math.round(h * 60)}m`;
	return `${h.toFixed(1)}h`;
}

function fmtTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
	return String(n);
}

function fmtCost(n: number): string {
	if (n < 0.01) return `<$0.01`;
	return `$${n.toFixed(2)}`;
}

function generateMarkdown(
	agg: AggregatedData,
	sections: Record<string, unknown>,
	synthesis: Record<string, string>,
	temporal: TemporalData,
	scan: ScanSummary,
	userCtx: UserContext,
): string {
	const lines: string[] = [];
	lines.push("# omp Insights");
	lines.push(`> ${agg.date_range.start} to ${agg.date_range.end} | ${agg.total_sessions} sessions | Generated ${new Date().toLocaleDateString()}`);
	lines.push("");

	if (temporal.diff_headlines.length) {
		lines.push("## \u{1F4C8} What Changed This Week");
		for (const h of temporal.diff_headlines) lines.push(`- ${h}`);
		if (temporal.major_transition) lines.push(`- **Major shift (${temporal.major_transition.when}):** ${temporal.major_transition.what}. ${temporal.major_transition.impact}`);
		lines.push("");
	}

	if (synthesis.whats_working || synthesis.whats_hindering || synthesis.quick_wins || synthesis.ambitious_workflows) {
		lines.push("## \u26A1 Summary");
		if (synthesis.whats_working) lines.push(`**What's working:** ${synthesis.whats_working}`);
		if (synthesis.whats_hindering) lines.push(`\n**What's hindering you:** ${synthesis.whats_hindering}`);
		if (synthesis.quick_wins) lines.push(`\n**Quick wins:** ${synthesis.quick_wins}`);
		if (synthesis.ambitious_workflows) lines.push(`\n**Ambitious workflows:** ${synthesis.ambitious_workflows}`);
		lines.push("");
	}

	lines.push("## \u{1F4CA} By the Numbers");
	lines.push(`| Metric | Value |`);
	lines.push(`|--------|-------|`);
	lines.push(`| Sessions | ${agg.total_sessions} (${agg.days_active} active days) |`);
	lines.push(`| User Messages | ${agg.total_messages} |`);
	lines.push(`| Total Cost | $${agg.total_cost.toFixed(2)} |`);
	lines.push(`| Tokens In | ${fmtTokens(agg.total_input_tokens)} |`);
	lines.push(`| Tokens Out | ${fmtTokens(agg.total_output_tokens)} |`);
	lines.push(`| Cache Read | ${fmtTokens(agg.total_cache_read_tokens)} |`);
	lines.push(`| Cache Write | ${fmtTokens(agg.total_cache_write_tokens)} |`);
	lines.push(`| Lines Added | ${agg.total_lines_added} |`);
	lines.push(`| Lines Removed | ${agg.total_lines_removed} |`);
	lines.push(`| Files Touched | ${agg.total_files_modified} |`);
	lines.push(`| Git Commits | ${agg.git_commits} |`);
	lines.push(`| Git Pushes | ${agg.git_pushes} |`);
	lines.push(`| Tool Errors | ${agg.total_tool_errors} |`);
	lines.push(`| Steering / Interruptions | ${agg.total_steering} |`);
	lines.push(`| Thinking Escalations | ${agg.total_thinking_escalations} |`);
	lines.push(`| Model Switches | ${agg.total_model_switches} |`);
	lines.push(`| Compactions | ${agg.total_compactions} |`);
	lines.push(`| Median TTFT | ${(agg.median_ttft_ms / 1000).toFixed(1)}s |`);
	lines.push(`| Median Reply Wait | ${agg.median_response_time.toFixed(0)}s |`);
	lines.push(`| Parallel Sessions | ${agg.concurrent_sessions.overlap_events} overlap events across ${agg.concurrent_sessions.sessions_involved} sessions |`);
	lines.push("");

	// Cost attribution. Advisor and subagent logs are separate sessions with
	// their own spend; omitting them undercounts badly, so they are folded
	// into the total and shown separately.
	lines.push("## \u{1F4B0} Where the Money Went");
	lines.push(`| Bucket | Cost | Share |`);
	lines.push(`|--------|------|-------|`);
	const share = (v: number) => (agg.total_cost > 0 ? `${((v / agg.total_cost) * 100).toFixed(1)}%` : "0%");
	lines.push(`| Primary sessions | $${agg.total_cost_primary.toFixed(2)} | ${share(agg.total_cost_primary)} |`);
	lines.push(`| Advisor sidecars (${agg.advisor_logs} ${agg.advisor_logs === 1 ? "log" : "logs"}) | $${agg.total_cost_advisor.toFixed(2)} | ${share(agg.total_cost_advisor)} |`);
	lines.push(`| Subagent sidecars (${agg.subagent_logs} ${agg.subagent_logs === 1 ? "log" : "logs"}) | $${agg.total_cost_subagent.toFixed(2)} | ${share(agg.total_cost_subagent)} |`);
	lines.push(`| **Total** | **$${agg.total_cost.toFixed(2)}** | 100% |`);
	lines.push("");
	lines.push(`Out-of-band model calls (titles, auto-thinking, advisor prompts) inside that total: $${agg.total_utility_cost.toFixed(2)}. ${agg.sessions_with_sidecars} of ${agg.total_sessions} sessions had at least one sidecar.`);
	lines.push("");

	lines.push("## \u{1F527} Tools");
	lines.push(`| Tool | Calls |`);
	lines.push(`|------|-------|`);
	for (const [tool, count] of top8(agg.tool_counts)) lines.push(`| ${tool} | ${count} |`);
	lines.push("");
	if (Object.keys(agg.tool_error_categories).length) {
		lines.push("**Failures by tool** (from `toolResult.isError`, not text matching):");
		for (const [cat, count] of top8(agg.tool_error_categories)) lines.push(`- ${cat}: ${count}`);
		lines.push("");
	}

	if (Object.keys(agg.languages).length) {
		lines.push("## \u{1F4C1} Languages and Projects");
		lines.push(`Languages: ${top8(agg.languages).map(([l, c]) => `${l} (${c})`).join(", ")}`);
		lines.push("");
		lines.push(`| Project | Sessions |`);
		lines.push(`|---------|----------|`);
		for (const [project, count] of top8(agg.projects)) lines.push(`| ${project} | ${count} |`);
		lines.push("");
	}

	// Provenance: what the scan actually looked at, so the numbers above can
	// be reconciled against the logs rather than trusted.
	lines.push("## \u{1F50D} Corpus");
	lines.push(`Scanned \`${scan.sessions_dir}\`: ${scan.primary_logs} distinct sessions, ${scan.advisor_logs} advisor sidecars, ${scan.subagent_logs} subagent sidecars${scan.duplicate_logs ? `, ${scan.duplicate_logs} duplicate log(s) dropped` : ""}.`);
	lines.push("");
	lines.push(`| Excluded | Sessions |`);
	lines.push(`|----------|----------|`);
	lines.push(`| Current session | ${scan.excluded_current} |`);
	lines.push(`| Insights meta-sessions | ${scan.excluded_meta} |`);
	lines.push(`| Unparseable | ${scan.excluded_unparsed} |`);
	lines.push(`| Below substance floor (<2 user messages or <1 min) | ${scan.excluded_not_substantive} |`);
	lines.push(`| Outside --since window | ${scan.excluded_by_since} |`);
	lines.push(`| **Included** | **${scan.included}** |`);
	lines.push("");
	lines.push(
		`Facet coverage: ${scan.facets_analyzed} of ${scan.included} sessions analysed${scan.facet_failures ? `, ${scan.facet_failures} extraction(s) failed` : ""}. Sessions without facets still count in every deterministic number above; they are absent only from the LLM-derived sections.`,
	);
	if (scan.reused_stale_sections) {
		lines.push("");
		lines.push(
			"_The narrative sections below were generated against an earlier corpus state and reused because this run was asked not to call a model (`--no-llm`). The numbers above are current._",
		);
	}
	lines.push("");
	lines.push(`Session set and per-session cost: \`${SESSION_SET_PATH}\``);
	lines.push("");

	lines.push("## \u2699\uFE0F Your Setup");
	lines.push(`- Default model: \`${userCtx.default_model || "not set"}\``);
	if (Object.keys(userCtx.model_roles).length)
		lines.push(`- Model roles: ${Object.entries(userCtx.model_roles).map(([r, m]) => `${r}=\`${m}\``).join(", ")}`);
	if (Object.keys(userCtx.fallback_chains).length)
		lines.push(`- Fallback chains: ${Object.entries(userCtx.fallback_chains).map(([r, c]) => `${r}: ${c.join(" \u2192 ")}`).join("; ")}`);
	lines.push(`- Skills: ${userCtx.installed_skills.length} user + ${userCtx.installed_managed_skills.length} managed`);
	lines.push(`- Extensions: ${userCtx.installed_extensions.length ? userCtx.installed_extensions.join(", ") : "none"}`);
	lines.push(`- Hooks: ${userCtx.installed_hooks.length ? userCtx.installed_hooks.join(", ") : "none"}`);
	lines.push(`- MCP servers: ${userCtx.mcp_servers.length ? userCtx.mcp_servers.join(", ") : "none"}`);
	lines.push(`- Global instruction rules read: ${userCtx.existing_agents_md_rules.length}`);
	lines.push("");

	const areas = (sections.project_areas as { areas?: Array<{ name: string; session_count: number; description: string }> })?.areas ?? [];
	if (areas.length) {
		lines.push("## \u{1F5C2}\uFE0F Where You Worked");
		for (const a of areas) lines.push(`- **${a.name}** (${a.session_count} sessions): ${a.description}`);
		lines.push("");
	}

	const iStyle = sections.interaction_style as { narrative?: string; key_pattern?: string } | undefined;
	if (iStyle?.narrative) {
		lines.push("## \u{1F3AF} How You Work");
		lines.push(iStyle.narrative);
		if (iStyle.key_pattern) lines.push(`\n> ${iStyle.key_pattern}`);
		lines.push("");
	}

	const whatWorks = sections.what_works as { impressive_workflows?: Array<{ title: string; description: string }> } | undefined;
	if (whatWorks?.impressive_workflows?.length) {
		lines.push("## \u2728 Wins");
		for (const w of whatWorks.impressive_workflows) lines.push(`- **${w.title}**: ${w.description}`);
		lines.push("");
	}

	const frictionSec = sections.friction_analysis as { intro?: string; resolved?: Array<{ category: string; note: string }>; ongoing?: Array<{ category: string; description: string; examples: string[] }>; categories?: Array<{ category: string; description: string; examples: string[] }> } | undefined;
	if (frictionSec) {
		lines.push("## \u26A0\uFE0F Where Things Broke");
		if (frictionSec.intro) lines.push(frictionSec.intro);
		if (frictionSec.resolved?.length) {
			lines.push("\n**Resolved:**");
			for (const r of frictionSec.resolved) lines.push(`- \u2705 ${r.category}: ${r.note}`);
		}
		const ongoing = frictionSec.ongoing ?? frictionSec.categories ?? [];
		if (ongoing.length) {
			lines.push("\n**Ongoing:**");
			for (const o of ongoing) {
				lines.push(`- **${o.category}**: ${o.description}`);
				for (const ex of o.examples ?? []) lines.push(`  - ${ex}`);
			}
		}
		lines.push("");
	}

	const suggSec = sections.suggestions as { config_additions?: Array<{ addition: string; why: string; where: string }>; features_to_try?: Array<{ feature: string; why_for_you: string; example: string }>; usage_patterns?: Array<{ title: string; detail: string; copyable_prompt: string }>; stop_doing?: Array<{ what: string; why: string; alternative: string }> } | undefined;
	if (suggSec) {
		lines.push("## \u{1F4A1} Next Steps");
		if (suggSec.config_additions?.length) {
			lines.push("**Config additions:**");
			for (const c of suggSec.config_additions) lines.push(`- \`${c.where}\`: ${c.addition} (${c.why})`);
		}
		if (suggSec.features_to_try?.length) {
			lines.push("\n**Features to try:**");
			for (const f of suggSec.features_to_try) lines.push(`- **${f.feature}**: ${f.why_for_you}\n  \`\`\`\n  ${f.example}\n  \`\`\``);
		}
		if (suggSec.usage_patterns?.length) {
			lines.push("\n**Usage patterns:**");
			for (const p of suggSec.usage_patterns) lines.push(`- **${p.title}**: ${p.detail}\n  \`\`\`\n  ${p.copyable_prompt}\n  \`\`\``);
		}
		if (suggSec.stop_doing?.length) {
			lines.push("\n**\u{1F6D1} Stop doing:**");
			for (const s of suggSec.stop_doing) lines.push(`- **${s.what}**: ${s.why}. Instead: ${s.alternative}`);
		}
		lines.push("");
	}

	const horizonSec = sections.on_the_horizon as { opportunities?: Array<{ title: string; whats_possible: string; copyable_prompt: string }> } | undefined;
	if (horizonSec?.opportunities?.length) {
		lines.push("## \u{1F680} Future Workflows");
		for (const o of horizonSec.opportunities) lines.push(`- **${o.title}**: ${o.whats_possible}\n  \`\`\`\n  ${o.copyable_prompt}\n  \`\`\``);
		lines.push("");
	}

	lines.push("## \u{1F4B8} Model Spend");
	lines.push(`| Model | Cost | Messages |`);
	lines.push(`|-------|------|----------|`);
	for (const [model, usage] of Object.entries(agg.model_usage).sort((a, b) => b[1].cost - a[1].cost).slice(0, 8)) {
		lines.push(`| ${model.replace(/.*\//, "")} | $${usage.cost.toFixed(2)} | ${usage.message_count} |`);
	}
	if (agg.estimated_waste > 0) lines.push(`\n**Estimated waste from model mismatch:** $${agg.estimated_waste.toFixed(2)}`);
	lines.push("");

	return lines.join("\n");
}

function generateHTML(
	agg: AggregatedData,
	sections: Record<string, unknown>,
	synthesis: Record<string, string>,
	temporal: TemporalData,
): string {
	const areas =
		(
			sections.project_areas as {
				areas?: Array<{
					name: string;
					session_count: number;
					description: string;
				}>;
			}
		)?.areas ?? [];
	const iStyle = sections.interaction_style as
		| { narrative?: string; key_pattern?: string }
		| undefined;
	const whatWorks = sections.what_works as
		| {
				intro?: string;
				impressive_workflows?: Array<{ title: string; description: string }>;
		  }
		| undefined;
	const frictionSec = sections.friction_analysis as
		| {
				intro?: string;
				categories?: Array<{ category: string; description: string; examples: string[] }>;
				resolved?: Array<{ category: string; note: string }>;
				ongoing?: Array<{ category: string; description: string; examples: string[]; severity?: string }>;
		  }
		| undefined;
	const suggSec = sections.suggestions as
		| {
				config_additions?: Array<{ addition: string; why: string; where: string }>;
				features_to_try?: Array<{ feature: string; one_liner: string; why_for_you: string; example: string }>;
				usage_patterns?: Array<{ title: string; suggestion: string; detail: string; copyable_prompt: string }>;
				stop_doing?: Array<{ what: string; why: string; alternative: string }>;
		  }
		| undefined;
	const horizonSec = sections.on_the_horizon as
		| {
				intro?: string;
				opportunities?: Array<{
					title: string;
					whats_possible: string;
					how_to_try: string;
					copyable_prompt: string;
				}>;
		  }
		| undefined;
	const funSec = sections.fun_ending as
		| { headline?: string; detail?: string }
		| undefined;
	const modelEffSec = sections.model_efficiency as
		| { summary?: string; overspend_pattern?: string; underspend_pattern?: string; quota_pressure?: string; recommendation?: string; potential_savings_note?: string }
		| undefined;

	const topTools = top8(agg.tool_counts);
	const topGoals = top8(agg.goal_categories);

	const configAdditions = suggSec?.config_additions ?? [];
	const featuresToTry = suggSec?.features_to_try ?? [];
	const usagePatterns = suggSec?.usage_patterns ?? [];

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Pi Insights — ${esc(agg.date_range.start)} to ${esc(agg.date_range.end)}</title>
<style>
  :root {
    --bg: #0d0f12; --bg2: #161a1f; --bg3: #1e2329;
    --border: #2a2f38; --border2: #343b47;
    --text: #e4e8ef; --dim: #8892a0; --muted: #4e5866;
    --accent: #4f9cf9; --accent2: #38bdf8;
    --green: #4ade80; --yellow: #fbbf24; --red: #f87171;
    --purple: #c084fc; --teal: #2dd4bf;
    --radius: 10px; --radius-sm: 6px;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font-family: -apple-system, 'Segoe UI', sans-serif; font-size: 16px; line-height: 1.7; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  strong { font-weight: 600; }

  .container { max-width: 1040px; margin: 0 auto; padding: 40px 24px 80px; }
  header { text-align: center; padding: 48px 0 40px; border-bottom: 1px solid var(--border); margin-bottom: 40px; }
  header h1 { font-size: 38px; font-weight: 700; color: var(--text); letter-spacing: -0.5px; }
  header .subtitle { color: var(--dim); margin-top: 8px; font-size: 14px; }

  nav { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; margin-bottom: 40px; }
  nav a { background: var(--bg3); border: 1px solid var(--border); padding: 6px 14px; border-radius: 20px; color: var(--dim); font-size: 13px; transition: all 0.15s; }
  nav a:hover { color: var(--text); border-color: var(--border2); text-decoration: none; background: var(--bg2); }

  section { margin-bottom: 48px; }
  h2 { font-size: 24px; font-weight: 700; color: var(--text); margin-bottom: 24px; padding-bottom: 12px; border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 10px; }
  h2 .emoji { font-size: 18px; }
  h3 { font-size: 16px; font-weight: 600; color: var(--text); margin-bottom: 10px; }

  .card { background: var(--bg2); border: 1px solid var(--border); border-radius: var(--radius); padding: 20px 24px; }
  .card + .card { margin-top: 12px; }
  .card-grid { display: grid; gap: 12px; }
  .card-grid.cols2 { grid-template-columns: repeat(2, 1fr); }
  .card-grid.cols3 { grid-template-columns: repeat(3, 1fr); }

  .stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; margin-bottom: 24px; }
  .stat-card { background: var(--bg2); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px 18px; text-align: center; }
  .stat-value { font-size: 26px; font-weight: 700; color: var(--accent); }
  .stat-label { font-size: 12px; color: var(--dim); margin-top: 4px; text-transform: uppercase; letter-spacing: 0.5px; }
  .stat-sub { font-size: 11px; color: var(--muted); margin-top: 2px; }

  .bar-row { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; font-size: 14px; }
  .bar-row.compact { margin-bottom: 2px; }
  .bar-label { width: 140px; flex-shrink: 0; color: var(--dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .bar-track { flex: 1; height: 10px; background: var(--bg3); border-radius: 5px; overflow: hidden; }
  .bar-fill { height: 100%; background: linear-gradient(90deg, var(--accent), var(--accent2)); border-radius: 5px; transition: width 0.4s ease; }
  .bar-count { width: 40px; text-align: right; color: var(--muted); flex-shrink: 0; }

  .charts-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 20px; }
  .chart-box { background: var(--bg2); border: 1px solid var(--border); border-radius: var(--radius); padding: 18px 20px; }
  .chart-box h3 { font-size: 13px; font-weight: 600; color: var(--dim); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 14px; }

  .at-a-glance { background: var(--bg2); border: 1px solid var(--border2); border-radius: var(--radius); overflow: hidden; }
  .at-a-glance-part { padding: 20px 24px; border-bottom: 1px solid var(--border); }
  .at-a-glance-part:last-child { border-bottom: none; }
  .at-a-glance-part h3 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.8px; color: var(--accent); margin-bottom: 10px; }
  .at-a-glance-part p { color: var(--text); line-height: 1.7; }

  .area-card { background: var(--bg2); border: 1px solid var(--border); border-radius: var(--radius); padding: 18px 20px; }
  .area-card h3 { color: var(--accent2); font-size: 17px; }
  .area-card .count { color: var(--muted); font-size: 12px; margin-left: 8px; }
  .area-card p { color: var(--dim); margin-top: 8px; font-size: 14px; }

  .workflow-card { background: var(--bg2); border: 1px solid var(--border); border-radius: var(--radius); padding: 18px 20px; }
  .workflow-card h3 { color: var(--green); font-size: 17px; }
  .workflow-card p { color: var(--dim); margin-top: 8px; font-size: 14px; }

  .friction-card { background: var(--bg2); border: 1px solid var(--border); border-radius: var(--radius); padding: 18px 20px; }
  .friction-card h3 { color: var(--yellow); font-size: 17px; }
  .friction-card p { color: var(--dim); margin-top: 8px; font-size: 14px; }
  .friction-card .examples { margin-top: 10px; }
  .friction-card .example { font-size: 13px; color: var(--muted); padding: 4px 0 4px 14px; border-left: 2px solid var(--border2); margin-top: 6px; }

  .sugg-card { background: var(--bg2); border: 1px solid var(--border); border-radius: var(--radius); padding: 18px 20px; }
  .sugg-card .tag { display: inline-block; font-size: 11px; padding: 2px 8px; border-radius: 4px; font-weight: 600; margin-bottom: 8px; background: var(--bg3); color: var(--dim); border: 1px solid var(--border2); }
  .sugg-card h3 { font-size: 14px; color: var(--text); }
  .sugg-card p { color: var(--dim); font-size: 13px; margin-top: 6px; }
  .sugg-card .why { color: var(--muted); font-size: 12px; margin-top: 6px; font-style: italic; }
  .sugg-card label { display: flex; align-items: flex-start; gap: 10px; cursor: pointer; }
  .sugg-card input[type=checkbox] { margin-top: 3px; accent-color: var(--accent); width: 15px; height: 15px; flex-shrink: 0; }

  .copy-box { background: var(--bg3); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 12px 14px; font-family: 'SF Mono', 'Fira Code', monospace; font-size: 12px; color: var(--teal); white-space: pre-wrap; word-break: break-all; margin-top: 10px; }
  .copy-btn { display: inline-flex; align-items: center; gap: 6px; background: var(--bg3); border: 1px solid var(--border2); color: var(--dim); font-size: 12px; padding: 5px 12px; border-radius: var(--radius-sm); cursor: pointer; margin-top: 8px; transition: all 0.15s; }
  .copy-btn:hover { color: var(--text); border-color: var(--accent); background: var(--bg2); }
  .copy-all-btn { background: var(--accent); color: #fff; font-weight: 600; border: none; padding: 8px 18px; border-radius: var(--radius-sm); cursor: pointer; font-size: 13px; margin-top: 16px; transition: opacity 0.15s; }
  .copy-all-btn:hover { opacity: 0.85; }

  .horizon-card { background: var(--bg2); border: 1px solid var(--border); border-radius: var(--radius); padding: 20px 24px; }
  .horizon-card h3 { color: var(--purple); font-size: 15px; }
  .horizon-card p { color: var(--dim); margin-top: 8px; font-size: 14px; }
  .horizon-card .how { color: var(--muted); font-size: 13px; margin-top: 8px; }

  .fun-box { background: linear-gradient(135deg, #1a1f2e, #1e2329); border: 1px solid var(--border2); border-radius: var(--radius); padding: 28px 32px; text-align: center; }
  .fun-box .headline { font-size: 18px; font-weight: 600; color: var(--text); line-height: 1.5; }
  .fun-box .detail { color: var(--dim); font-size: 14px; margin-top: 10px; }

  .muted { color: var(--muted); font-size: 14px; }
  .badge { display: inline-block; font-size: 11px; padding: 2px 8px; border-radius: 4px; font-weight: 600; }
  .badge.green { background: rgba(74,222,128,0.15); color: var(--green); }
  .badge.yellow { background: rgba(251,191,36,0.15); color: var(--yellow); }
  .badge.red { background: rgba(248,113,113,0.15); color: var(--red); }

  @media (max-width: 700px) {
    .card-grid.cols2, .card-grid.cols3 { grid-template-columns: 1fr; }
    .stat-grid { grid-template-columns: repeat(2, 1fr); }
    .charts-grid { grid-template-columns: 1fr; }
  }
</style>
</head>
<body>
<div class="container">

<header>
  <h1>🔍 Pi Insights</h1>
  <div class="subtitle">
    ${esc(agg.date_range.start)} – ${esc(agg.date_range.end)}
    &nbsp;·&nbsp;
    ${agg.total_sessions} sessions
    &nbsp;·&nbsp;
    Generated ${new Date().toLocaleDateString()}
  </div>
</header>

<nav>
  <a href="#at-a-glance">Summary</a>
  <a href="#stats">Numbers</a>
  <a href="#projects">Where You Worked</a>
  <a href="#style">How You Work</a>
  <a href="#what-works">Wins</a>
  <a href="#friction">Friction</a>
  <a href="#suggestions">Next Steps</a>
  <a href="#horizon">Future</a>
  <a href="#model-efficiency">Model Spend</a>
</nav>

${temporal.diff_headlines.length ? `
<div style="background:linear-gradient(135deg,#1a2332,#1e2a3a);border:1px solid var(--border2);border-radius:var(--radius);padding:24px 28px;margin-bottom:32px">
  <h3 style="color:var(--accent2);font-size:13px;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:14px">\u{1F4C8} What Changed This Week</h3>
  <div style="display:flex;flex-wrap:wrap;gap:10px">
    ${temporal.diff_headlines.map(h => `<div style="background:var(--bg3);border:1px solid var(--border);border-radius:var(--radius-sm);padding:8px 14px;font-size:14px;color:var(--text)">${esc(h)}</div>`).join("\n    ")}
  </div>
  ${temporal.major_transition ? `<div style="margin-top:14px;padding:10px 14px;background:var(--bg);border-radius:var(--radius-sm);border-left:3px solid var(--purple);font-size:13px;color:var(--dim)"><strong style="color:var(--purple)">Major shift (${esc(temporal.major_transition.when)}):</strong> ${esc(temporal.major_transition.what)}. Impact: ${esc(temporal.major_transition.impact)}</div>` : ""}
</div>` : ""}

<!-- ── At a Glance ── -->
<section id="at-a-glance">
  <h2><span class="emoji">⚡</span> Summary</h2>
  <div class="at-a-glance">
    <div class="at-a-glance-part">
      <h3>What's Working</h3>
      ${wrapP(synthesis.whats_working ?? "")}
    </div>
    <div class="at-a-glance-part">
      <h3>What's Hindering You</h3>
      ${wrapP(synthesis.whats_hindering ?? "")}
    </div>
    <div class="at-a-glance-part">
      <h3>Quick Wins to Try</h3>
      ${wrapP(synthesis.quick_wins ?? "")}
    </div>
    <div class="at-a-glance-part">
      <h3>Ambitious Workflows</h3>
      ${wrapP(synthesis.ambitious_workflows ?? "")}
    </div>
  </div>
</section>

<!-- ── Stats ── -->
<section id="stats">
  <h2><span class="emoji">📊</span> By the Numbers</h2>
  <div class="stat-grid">
    ${statCard("Sessions", String(agg.total_sessions), `${agg.days_active} active days`)}
    ${statCard("Messages", String(agg.total_messages), `${(agg.total_messages / Math.max(agg.total_sessions, 1)).toFixed(1)} per session`)}
    ${statCard("Active Time", fmtHours(agg.total_duration_hours), `${(agg.total_duration_hours / Math.max(agg.days_active, 1)).toFixed(1)}h/day`)}
    ${statCard("Tokens In", fmtTokens(agg.total_input_tokens), "")}
    ${statCard("Tokens Out", fmtTokens(agg.total_output_tokens), "")}
    ${statCard("Total Cost", fmtCost(agg.total_cost), "")}
    ${statCard("Lines Added", fmtTokens(agg.total_lines_added), "")}
    ${statCard("Lines Removed", fmtTokens(agg.total_lines_removed), "")}
    ${statCard("Git Commits", String(agg.git_commits), `${agg.git_pushes} pushes`)}
    ${statCard("Files Modified", fmtTokens(agg.total_files_modified), "")}
    ${statCard("Tool Errors", String(agg.total_tool_errors), "")}
    ${statCard("Interruptions", String(agg.total_interruptions), "")}
    ${agg.sessions_using_subagent ? statCard("Subagent Sessions", String(agg.sessions_using_subagent), "") : ""}
    ${agg.sessions_using_mcp ? statCard("MCP Sessions", String(agg.sessions_using_mcp), "") : ""}
    ${agg.concurrent_sessions.overlap_events ? statCard("Parallel Sessions", String(agg.concurrent_sessions.overlap_events), "overlap events") : ""}
  </div>

  <div class="charts-grid">
    <div class="chart-box">
      <h3>Goal Categories</h3>
      ${barChart(agg.goal_categories, { limit: 10 })}
    </div>
    <div class="chart-box">
      <h3>Outcomes</h3>
      ${barChart(agg.outcomes, { order: OUTCOME_ORDER })}
    </div>
    <div class="chart-box">
      <h3>Satisfaction</h3>
      ${barChart(agg.satisfaction, { order: SATISFACTION_ORDER })}
    </div>
    <div class="chart-box">
      <h3>Top Tools</h3>
      ${barChart(agg.tool_counts, { limit: 10 })}
    </div>
    <div class="chart-box">
      <h3>Languages</h3>
      ${barChart(agg.languages, { limit: 10 })}
    </div>
    <div class="chart-box">
      <h3>Friction Types</h3>
      ${barChart(agg.friction, { limit: 10 })}
    </div>
    <div class="chart-box">
      <h3>Tool Errors</h3>
      ${barChart(agg.tool_error_categories)}
    </div>
    <div class="chart-box">
      <h3>Response Times</h3>
      ${responseTimeChart(agg.user_response_times)}
    </div>
    <div class="chart-box">
      <h3>Time of Day</h3>
      ${timeOfDayChart(agg.message_hours)}
    </div>
  </div>
</section>

<!-- ── Project Areas ── -->
<section id="projects">
  <h2><span class="emoji">🗂️</span> Where You Worked</h2>
  <div class="card-grid ${areas.length > 2 ? "cols2" : ""}">
    ${areas
			.map(
				(a) => `<div class="area-card">
      <h3>${esc(a.name)}<span class="count">${a.session_count} sessions</span></h3>
      <p>${esc(a.description)}</p>
    </div>`,
			)
			.join("\n")}
  </div>
</section>

<!-- ── Interaction Style ── -->
<section id="style">
  <h2><span class="emoji">🎯</span> How You Work</h2>
  <div class="card">
    ${iStyle?.narrative ? `<div style="line-height:1.8">${renderMarkdown(esc(iStyle.narrative))}</div>` : "<p class='muted'>No data</p>"}
    ${iStyle?.key_pattern ? `<div style="margin-top:16px;padding:14px 16px;background:var(--bg3);border-radius:var(--radius-sm);border:1px solid var(--border2);color:var(--accent2);font-size:14px;font-style:italic">"${esc(iStyle.key_pattern)}"</div>` : ""}
  </div>
</section>

<!-- ── What's Working ── -->
<section id="what-works">
  <h2><span class="emoji">✨</span> Wins</h2>
  ${whatWorks?.intro ? `<p style="color:var(--dim);margin-bottom:16px">${esc(whatWorks.intro)}</p>` : ""}
  <div class="card-grid ${(whatWorks?.impressive_workflows?.length ?? 0) > 1 ? "cols2" : ""}">
    ${(whatWorks?.impressive_workflows ?? [])
			.map(
				(w) => `<div class="workflow-card">
      <h3>${esc(w.title)}</h3>
      <p>${esc(w.description)}</p>
    </div>`,
			)
			.join("\n")}
  </div>
</section>

<!-- ── Friction ── -->
<section id="friction">
  <h2><span class="emoji">⚠️</span> Where Things Broke</h2>
  ${frictionSec?.intro ? `<p style="color:var(--dim);margin-bottom:16px">${esc(frictionSec.intro)}</p>` : ""}
  ${(frictionSec?.resolved?.length) ? `<div style="margin-bottom:20px">
    <h3 style="color:var(--green);font-size:14px;margin-bottom:10px">\u2705 Resolved</h3>
    ${frictionSec.resolved.map(r => `<div style="padding:6px 14px;color:var(--dim);font-size:13px;border-left:2px solid var(--green);margin-bottom:6px"><strong>${esc(r.category)}</strong> \u2014 ${esc(r.note)}</div>`).join("\n")}
  </div>` : ""}
  <div class="card-grid ${((frictionSec?.ongoing ?? frictionSec?.categories)?.length ?? 0) > 1 ? "cols2" : ""}">
    ${((frictionSec?.ongoing ?? frictionSec?.categories) ?? [])
			.map(
				(cat) => `<div class="friction-card">
      <h3>${esc(cat.category)}${(cat as any).severity ? ` <span class="badge ${(cat as any).severity === "high" ? "red" : (cat as any).severity === "medium" ? "yellow" : "green"}">${(cat as any).severity}</span>` : ""}</h3>
      <p>${esc(cat.description)}</p>
      <div class="examples">
        ${(cat.examples ?? []).map((ex) => `<div class="example">${esc(ex)}</div>`).join("")}
      </div>
    </div>`,
			)
			.join("\n")}
  </div>
</section>

<!-- ── Suggestions ── -->
<section id="suggestions">
  <h2><span class="emoji">💡</span> Next Steps</h2>

  ${
		configAdditions.length
			? `<h3 style="margin-bottom:12px">Config Additions</h3>
  <p style="color:var(--muted);font-size:13px;margin-bottom:16px">Select the ones you want, then copy them all at once.</p>
  <div id="config-list">
    ${configAdditions
			.map(
				(
					c,
					i,
				) => `<div class="sugg-card" id="cfg-${i}" style="margin-bottom:10px">
      <label>
        <input type="checkbox" class="cfg-check" checked data-addition="${esc(c.addition)}" data-where="${esc(c.where)}">
        <div>
          <div class="tag">${esc(c.where)}</div>
          <h3>${esc(c.addition)}</h3>
          <p class="why">Why: ${esc(c.why)}</p>
        </div>
      </label>
    </div>`,
			)
			.join("\n")}
  </div>
  <button class="copy-all-btn" onclick="copyAllConfig()">Copy Selected as AGENTS.md Block</button>
  <div id="copy-all-output" style="display:none;margin-top:10px">
    <div class="copy-box" id="copy-all-text"></div>
    <button class="copy-btn" onclick="copyText('copy-all-text')">📋 Copy</button>
  </div>`
			: ""
	}

  ${
		featuresToTry.length
			? `<h3 style="margin:24px 0 12px">Features to Try</h3>
  <div class="card-grid ${featuresToTry.length > 1 ? "cols2" : ""}">
    ${featuresToTry
			.map(
				(f) => `<div class="sugg-card">
      <div class="tag">${esc(f.feature)}</div>
      <h3>${esc(f.one_liner)}</h3>
      <p>${esc(f.why_for_you)}</p>
      <div class="copy-box">${esc(f.example)}</div>
      <button class="copy-btn" onclick="copyFromBox(this)">📋 Copy</button>
    </div>`,
			)
			.join("\n")}
  </div>`
			: ""
	}

  ${
		usagePatterns.length
			? `<h3 style="margin:24px 0 12px">Usage Patterns</h3>
  <div style="display:flex;flex-direction:column;gap:12px">
    ${usagePatterns
			.map(
				(p) => `<div class="sugg-card">
      <h3>${esc(p.title)}</h3>
      <p>${esc(p.suggestion)}</p>
      <p style="margin-top:8px;font-size:13px;color:var(--muted)">${esc(p.detail)}</p>
      <div class="copy-box">${esc(p.copyable_prompt)}</div>
      <button class="copy-btn" onclick="copyFromBox(this)">📋 Copy</button>
    </div>`,
			)
			.join("\n")}
  </div>`
			: ""
	}

  ${(suggSec?.stop_doing?.length) ? `<h3 style="margin:24px 0 12px;color:var(--red)">\u{1F6D1} Consider Stopping</h3>
  <div style="display:flex;flex-direction:column;gap:12px">
    ${suggSec.stop_doing.map(s => `<div class="card" style="border-left:3px solid var(--red)">
      <h3 style="color:var(--red);font-size:14px">${esc(s.what)}</h3>
      <p style="color:var(--dim);margin-top:6px;font-size:13px">${esc(s.why)}</p>
      <p style="color:var(--green);margin-top:6px;font-size:13px"><strong>Instead:</strong> ${esc(s.alternative)}</p>
    </div>`).join("\n")}
  </div>` : ""}
</section>

<!-- ── On the Horizon ── -->
<section id="horizon">
  <h2><span class="emoji">🚀</span> Future Workflows</h2>
  ${horizonSec?.intro ? `<p style="color:var(--dim);margin-bottom:16px">${esc(horizonSec.intro)}</p>` : ""}
  <div style="display:flex;flex-direction:column;gap:12px">
    ${(horizonSec?.opportunities ?? [])
			.map(
				(o) => `<div class="horizon-card">
      <h3>${esc(o.title)}</h3>
      <p>${esc(o.whats_possible)}</p>
      <p class="how">${esc(o.how_to_try)}</p>
      <div class="copy-box">${esc(o.copyable_prompt)}</div>
      <button class="copy-btn" onclick="copyFromBox(this)">📋 Copy</button>
    </div>`,
			)
			.join("\n")}
  </div>
</section>

<!-- ── Model Efficiency ── -->
<section id="model-efficiency">
  <h2><span class="emoji">💸</span> Model Spend</h2>
  ${modelEffSec?.summary ? `<p style="color:var(--dim);margin-bottom:16px">${esc(modelEffSec.summary)}</p>` : ""}

  <div class="stat-grid">
    ${statCard("Estimated Waste", fmtCost(agg.estimated_waste), "from model mismatch")}
    ${statCard("Efficiency Flags", String(agg.model_efficiency.length), `${agg.model_efficiency.filter(e => e.flag === "overspend").length} overspend, ${agg.model_efficiency.filter(e => e.flag === "underspend").length} underspend, ${agg.model_efficiency.filter(e => e.flag === "quota_pressure").length} quota pressure`)}
    ${statCard("Models Used", String(Object.keys(agg.model_usage).length), "")}
  </div>

  <div class="charts-grid">
    <div class="chart-box">
      <h3>Cost by Model</h3>
      ${barChart(Object.fromEntries(Object.entries(agg.model_usage).map(([k, v]) => [k, Math.round(v.cost * 100)])), { limit: 8 })}
      <p class="muted" style="margin-top:8px;font-size:11px">Values in cents</p>
    </div>
    <div class="chart-box">
      <h3>Messages by Model</h3>
      ${barChart(Object.fromEntries(Object.entries(agg.model_usage).map(([k, v]) => [k, v.message_count])), { limit: 8 })}
    </div>
  </div>

  ${modelEffSec?.overspend_pattern ? `<div class="card" style="margin-top:16px;border-left:3px solid var(--yellow)">
    <h3 style="color:var(--yellow);font-size:14px">Overspend Pattern</h3>
    <p style="color:var(--dim);margin-top:8px">${esc(modelEffSec.overspend_pattern)}</p>
  </div>` : ""}

  ${modelEffSec?.underspend_pattern ? `<div class="card" style="margin-top:12px;border-left:3px solid var(--red)">
    <h3 style="color:var(--red);font-size:14px">Underspend Pattern</h3>
    <p style="color:var(--dim);margin-top:8px">${esc(modelEffSec.underspend_pattern)}</p>
  </div>` : ""}

  ${modelEffSec?.quota_pressure ? `<div class="card" style="margin-top:12px;border-left:3px solid var(--blue)">
    <h3 style="color:var(--blue);font-size:14px">Subscription Quota Pressure</h3>
    <p style="color:var(--dim);margin-top:8px">${esc(modelEffSec.quota_pressure)}</p>
  </div>` : ""}

  ${modelEffSec?.recommendation ? `<div class="card" style="margin-top:12px;border-left:3px solid var(--green)">
    <h3 style="color:var(--green);font-size:14px">Recommendation</h3>
    <p style="color:var(--dim);margin-top:8px">${esc(modelEffSec.recommendation)}</p>
    ${modelEffSec.potential_savings_note ? `<p style="color:var(--muted);margin-top:6px;font-size:12px;font-style:italic">${esc(modelEffSec.potential_savings_note)}</p>` : ""}
  </div>` : ""}

  ${agg.model_efficiency.length ? `<h3 style="margin-top:24px;margin-bottom:12px">Flagged Sessions</h3>
  <div style="display:flex;flex-direction:column;gap:8px">
    ${agg.model_efficiency.slice(0, 10).map(e => `<div class="card" style="padding:14px 18px">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div>
          <span class="badge ${e.flag === "overspend" ? "yellow" : "red"}">${esc(e.flag)}</span>
          <span style="color:var(--dim);font-size:13px;margin-left:8px">${esc(e.date)} · ${esc(e.model)}</span>
        </div>
        <span style="color:var(--accent);font-weight:600;font-size:14px">${fmtCost(e.cost)}</span>
      </div>
      <p style="color:var(--dim);font-size:13px;margin-top:6px">${esc(e.reason)}</p>
      <p style="color:var(--muted);font-size:12px;margin-top:4px">${esc(e.goal)}</p>
    </div>`).join("\n")}
  </div>` : ""}
</section>

<!-- ── Fun Ending ── -->
${
	funSec?.headline
		? `<section>
  <div class="fun-box">
    <div class="headline">${esc(funSec.headline)}</div>
    ${funSec.detail ? `<div class="detail">${esc(funSec.detail)}</div>` : ""}
  </div>
</section>`
		: ""
}

</div>
<script>
function copyText(id) {
  const el = document.getElementById(id);
  if (!el) return;
  navigator.clipboard.writeText(el.textContent).then(() => {
    const btn = el.nextElementSibling;
    if (btn) { btn.textContent = '✅ Copied'; setTimeout(() => { btn.textContent = '📋 Copy'; }, 2000); }
  });
}
function copyFromBox(btn) {
  const box = btn.previousElementSibling;
  if (!box) return;
  navigator.clipboard.writeText(box.textContent).then(() => {
    btn.textContent = '✅ Copied';
    setTimeout(() => { btn.textContent = '📋 Copy'; }, 2000);
  });
}
function copyAllConfig() {
  const checks = document.querySelectorAll('.cfg-check:checked');
  const lines = ['# Pi AGENTS.md additions (generated by /insights)', ''];
  for (const ch of checks) {
    const where = ch.dataset.where || '';
    const addition = ch.dataset.addition || '';
    lines.push('# ' + where);
    lines.push(addition);
    lines.push('');
  }
  const text = lines.join('\\n');
  const out = document.getElementById('copy-all-output');
  const textEl = document.getElementById('copy-all-text');
  if (out && textEl) { textEl.textContent = text; out.style.display = 'block'; }
  navigator.clipboard.writeText(text);
}
</script>
</body>
</html>`;
}

// ─── Main Command Handler ─────────────────────────────────────────────────────

async function runInsights(
	args: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const refresh = args.includes("--refresh") || args.includes("-r");
	const noOpen = args.includes("--no-open");
	const formatMd = args.includes("--format md") || args.includes("--md");
	// --no-llm renders from whatever is already cached and never calls a model:
	// the corpus changes whenever omp runs, so on a busy machine the section
	// cache legitimately misses and a plain re-run is not free.
	const noLlm = args.includes("--no-llm");
	const useLlm = LLM_PHASES_ENABLED && !noLlm;

	// Parse --since flag (e.g. --since 7d, --since 2w, --since 30d)
	const sinceMatch = args.match(/--since\s+(\d+)([dw])/);
	const sinceDays = sinceMatch
		? Number(sinceMatch[1]) * (sinceMatch[2] === "w" ? 7 : 1)
		: 0;

	const limits = {
		maxSessions: resolveLimit(args, "max-sessions", "OMP_INSIGHTS_MAX_SESSIONS", DEFAULT_MAX_SESSIONS_TO_LOAD),
		maxFacets: resolveLimit(args, "max-facets", "OMP_INSIGHTS_MAX_FACETS", DEFAULT_MAX_FACET_EXTRACTIONS),
		facetConcurrency: resolveLimit(args, "facet-concurrency", "OMP_INSIGHTS_FACET_CONCURRENCY", DEFAULT_FACET_CONCURRENCY),
	};

	// Stage 1 never calls a model, so an active model is only required once the
	// LLM phases are wired.
	if (useLlm && !ctx.model) {
		ctx.ui.notify("No active model — set a model first (/model)", "error");
		return;
	}

	await ensureDirs();

	const source = ompSessionSource;
	// Fetched before the LLM phases: the facet phase needs the smol model role
	// out of it, and the section prompts need the installed-skills list.
	const userCtx = await gatherUserContext();
	// The subprocess would otherwise use the configured default; pin it to the
	// model actually active in this session so the report reflects /model.
	const activeModel =
		(ctx.model as { id?: string; provider?: string } | undefined)?.id ?? undefined;
	const currentSessionId = ctx.sessionManager?.getSessionId?.() ?? "";

	// ── Phase 1: Scan ────────────────────────────────────────────────────────────
	ctx.ui.setStatus("insights", "🔍 Scanning sessions...");
	ctx.ui.setWidget("insights", [
		"",
		"  📊 omp Insights",
		"  ─────────────────────────────────",
		"  Phase 1/5: Scanning session files...",
	]);

	const scanned = await source.listSessions();
	const scan: ScanSummary = {
		sessions_dir: SESSIONS_DIR,
		primary_logs: scanned.sessions.length,
		duplicate_logs: scanned.duplicate_logs,
		advisor_logs: 0,
		subagent_logs: 0,
		excluded_meta: 0,
		excluded_current: 0,
		excluded_unparsed: 0,
		excluded_not_substantive: 0,
		excluded_by_since: 0,
		facet_failures: 0,
		facets_analyzed: 0,
		reused_stale_sections: false,
		included: 0,
	};
	for (const ref of scanned.sessions) {
		for (const sidecar of ref.sidecars) {
			if (sidecar.kind === "advisor") scan.advisor_logs++;
			else scan.subagent_logs++;
		}
	}

	// The session running this command is excluded by id: its own transcript
	// would otherwise be summarised mid-write.
	const allRefs = scanned.sessions.filter((ref) => {
		if (ref.id === currentSessionId) {
			scan.excluded_current++;
			return false;
		}
		return true;
	});

	ctx.ui.setWidget("insights", [
		"",
		"  📊 omp Insights",
		"  ─────────────────────────────────",
		`  Phase 1/5 done — ${allRefs.length} sessions, ${scan.advisor_logs} advisor + ${scan.subagent_logs} subagent logs`,
		"  Phase 2/5: Extracting session stats...",
	]);

	// ── Phase 2: Session Metadata ────────────────────────────────────────────────
	const metas: SessionMeta[] = [];

	// Load cached metas first (batch)
	const cachedMetaIds = new Set<string>();
	for (let i = 0; i < allRefs.length; i += META_BATCH_SIZE) {
		const batch = allRefs.slice(i, i + META_BATCH_SIZE);
		const results = await Promise.all(
			batch.map((ref) => loadCachedMeta(ref.id, ref.signature)),
		);
		for (let j = 0; j < batch.length; j++) {
			const cached = results[j];
			if (cached) {
				cachedMetaIds.add(batch[j]!.id);
				metas.push(cached);
			}
		}
	}

	// Parse uncached sessions (up to the load cap)
	const uncached = allRefs.filter((ref) => !cachedMetaIds.has(ref.id));
	const toLoad = uncached.slice(0, limits.maxSessions);

	let loadedCount = 0;
	for (let i = 0; i < toLoad.length; i += LOAD_BATCH_SIZE) {
		const batch = toLoad.slice(i, i + LOAD_BATCH_SIZE);
		await Promise.all(
			batch.map(async (ref) => {
				try {
					const entries = await source.readEntries(ref.path);

					if (isMetaSession(entries)) {
						scan.excluded_meta++;
						return;
					}

					// Sidecars are read here and folded into the parent: advisor and
					// subagent spend is real money that belongs to this session.
					const sidecars = await Promise.all(
						ref.sidecars.map(async (sidecar) => ({
							kind: sidecar.kind,
							usage: extractSidecarUsage(await source.readEntries(sidecar.path)),
						})),
					);

					const meta = buildSessionMeta(ref, entries, sidecars);
					await saveMeta(meta);
					metas.push(meta);
				} catch {
					// Skip sessions that fail to load
					scan.excluded_unparsed++;
				}
				loadedCount++;
			}),
		);
		ctx.ui.setWidget("insights", [
			"",
			"  📊 omp Insights",
			"  ─────────────────────────────────",
			`  Phase 2/5: Loaded ${cachedMetaIds.size} cached, ${loadedCount}/${toLoad.length} new`,
		]);
	}

	// Filter substantive sessions (≥2 user messages, ≥1 min)
	const substantive = metas.filter((m) => {
		if (m.user_message_count < 2 || m.duration_minutes < 1) {
			scan.excluded_not_substantive++;
			return false;
		}
		if (sinceDays) {
			const age = Date.now() - new Date(m.start_time).getTime();
			if (age >= sinceDays * 86400000) {
				scan.excluded_by_since++;
				return false;
			}
		}
		return true;
	});
	scan.included = substantive.length;

	ctx.ui.setWidget("insights", [
		"",
		"  📊 omp Insights",
		"  ─────────────────────────────────",
		`  Phase 2/5 done — ${substantive.length} substantive sessions`,
		useLlm
			? "  Phase 3/5: LLM facet extraction..."
			: "  Phase 3/5: skipped (deterministic run)",
	]);

	// ── Phase 3: Facet Extraction ─────────────────────────────────────────────────
	const facetsMap = new Map<string, SessionFacets>();

	// Load cached facets
	for (const meta of substantive) {
		if (refresh) {
			await deleteCachedFacets(meta.session_id);
		} else {
			const cached = await loadCachedFacets(meta.session_id);
			if (cached) facetsMap.set(meta.session_id, cached);
		}
	}

	// Facet extraction is structured classification against a fixed JSON
	// schema, so it runs on the smol role rather than the active model: one
	// call per uncached session adds up, and the quality that matters shows in
	// the section prompts and the synthesis, which use the default model.
	const facetModel = userCtx.model_roles.smol || undefined;
	const needsFacets = useLlm
		? substantive
				.filter((m) => !facetsMap.has(m.session_id))
				.slice(0, limits.maxFacets)
		: [];

	if (needsFacets.length > 0) {
		let facetsDone = 0;
		for (let i = 0; i < needsFacets.length; i += limits.facetConcurrency) {
			const batch = needsFacets.slice(i, i + limits.facetConcurrency);
			await Promise.all(
				batch.map(async (meta) => {
					try {
						const entries = await source.readEntries(meta.session_path);
						let transcript = formatTranscript(entries, meta);

						// Summarize long transcripts
						if (transcript.length > 30_000) {
							const CHUNK = 25_000;
							const chunks: string[] = [];
							for (let ci = 0; ci < transcript.length; ci += CHUNK)
								chunks.push(transcript.slice(ci, ci + CHUNK));
							const summaries = await Promise.all(
								chunks.map((ch) =>
									callModel(CHUNK_SUMMARIZE_PROMPT + ch, { model: facetModel }).catch(
										() => ch.slice(0, 2000),
									),
								),
							);
							transcript = `Session: ${meta.session_id.slice(0, 8)}\nDate: ${meta.start_time}\nProject: ${meta.project_path}\n[Long session - summarized]\n\n${summaries.join("\n\n---\n\n")}`;
						}

						const prompt = `${FACET_EXTRACT_PROMPT}${transcript}

RESPOND WITH ONLY A VALID JSON OBJECT:
{
  "underlying_goal": "...",
  "goal_categories": {"category_name": count},
  "outcome": "fully_achieved|mostly_achieved|partially_achieved|not_achieved|unclear_from_transcript",
  "user_satisfaction_counts": {"level": count},
  "assistant_helpfulness": "unhelpful|slightly_helpful|moderately_helpful|very_helpful|essential",
  "session_type": "single_task|multi_task|iterative_refinement|exploration|quick_question",
  "friction_counts": {"friction_type": count},
  "friction_detail": "one sentence or empty string",
  "primary_success": "none|fast_accurate_search|correct_code_edits|good_explanations|proactive_help|multi_file_changes|good_debugging",
  "brief_summary": "one sentence: what user wanted and whether they got it",
  "user_instructions_to_assistant": ["instruction1", "instruction2"]
}`;

						const text = await callModel(prompt, { model: facetModel });
						const parsed = parseJsonFromResponse(text) as SessionFacets | null;
						if (parsed?.brief_summary) {
							const facets: SessionFacets = {
								...parsed,
								session_id: meta.session_id,
							};
							await saveFacets(facets);
							facetsMap.set(meta.session_id, facets);
						} else {
							// A reply that parsed but carried no summary is a failure too:
							// the session silently drops out of every facet-derived chart.
							scan.facet_failures++;
						}
					} catch {
						scan.facet_failures++;
					}
					facetsDone++;
					ctx.ui.setWidget("insights", [
						"",
						"  📊 omp Insights",
						"  ─────────────────────────────────",
						`  Phase 3/5: Facets ${facetsDone}/${needsFacets.length}...`,
					]);
				}),
			);
		}
	}

	// Post-facet filter: remove sessions where only goal is warmup_minimal
	const kept = substantive.filter((m) => {
		const facets = facetsMap.get(m.session_id);
		if (!facets) return true; // keep if no facets
		const cats = Object.keys(facets.goal_categories).filter(
			(k) => (facets.goal_categories[k] ?? 0) > 0,
		);
		return !(cats.length === 1 && cats[0] === "warmup_minimal");
	});

	ctx.ui.setWidget("insights", [
		"",
		"  📊 omp Insights",
		"  ─────────────────────────────────",
		useLlm
			? `  Phase 3/5 done — ${facetsMap.size} facets extracted`
			: "  Phase 3/5 skipped — deterministic sections only",
		"  Phase 4/5: Aggregating...",
	]);

	// ── Phase 4: Aggregate + Insight Prompts ─────────────────────────────────────
	const agg = aggregateData(kept, facetsMap);
	scan.included = kept.length;
	scan.facets_analyzed = agg.sessions_with_facets;
	const temporal = computeTemporalData(kept, facetsMap);
	const dataBlock = buildSharedDataBlock(agg, temporal, userCtx);
	const sectionPrompts = buildSectionPrompts(dataBlock, temporal, userCtx, agg);

	// Keyed on the prompt inputs, not the clock: the same corpus and the same
	// model produce the same prose, so a re-run should cost nothing.
	const sectionsKey = createHash("sha256")
		.update(`${activeModel ?? "default"}\n${dataBlock}`)
		.digest("hex")
		.slice(0, 32);
	const exactSections = refresh ? null : await loadCachedSections(sectionsKey);
	const staleSections = exactSections || !noLlm ? null : await loadLatestSections();
	const cachedSections = exactSections ?? staleSections;

	scan.reused_stale_sections = Boolean(staleSections);

	const sectionKeys =
		useLlm && !cachedSections
			? (Object.keys(sectionPrompts) as Array<keyof typeof sectionPrompts>)
			: [];
	const sectionResults: Record<string, unknown> = { ...(cachedSections?.sections ?? {}) };
	let sectionsDone = 0;
	await Promise.all(
		sectionKeys.map(async (key) => {
			try {
				// Sections and the synthesis run on the active model: this is where
				// judgement quality shows up in the report.
				const text = await callModel(sectionPrompts[key], { model: activeModel });
				const parsed = parseJsonFromResponse(text);
				if (parsed) sectionResults[key] = parsed;
			} catch {
				// Section failed — continue without it
			}
			sectionsDone++;
			ctx.ui.setWidget("insights", [
				"",
				"  📊 omp Insights",
				"  ─────────────────────────────────",
				`  Phase 4/5: Insights ${sectionsDone}/${sectionKeys.length}...`,
			]);
		}),
	);

	let synthesis: Record<string, string> = cachedSections?.synthesis ?? {};
	if (useLlm && !cachedSections) {
		// Synthesis (At a Glance)
		ctx.ui.setWidget("insights", [
			"",
			"  📊 omp Insights",
			"  ─────────────────────────────────",
			"  Phase 4/5: Synthesis...",
		]);

		try {
			const synthText = await callModel(
				buildSynthesisPrompt(dataBlock, sectionResults),
				{ model: activeModel },
			);
			synthesis =
				(parseJsonFromResponse(synthText) as Record<string, string>) ?? {};
		} catch (err) {
			// Upstream substituted placeholder prose here. A failed synthesis is
			// better reported than papered over: generateMarkdown omits the
			// Summary section when synthesis is empty.
			ctx.ui.notify(`Synthesis failed: ${(err as Error).message}`, "warning");
		}

		// Only cache a run that actually produced sections; a wholly failed
		// generation must not be replayed as if it were a result.
		if (Object.keys(sectionResults).length) {
			await saveSections(sectionsKey, { sections: sectionResults, synthesis });
			await pruneSections();
		}
	}

	// ── Phase 5: Render HTML ──────────────────────────────────────────────────────
	ctx.ui.setWidget("insights", [
		"",
		"  📊 omp Insights",
		"  ─────────────────────────────────",
		"  Phase 5/5: Rendering report...",
	]);

	// Audit manifest: the exact session set behind the numbers, so a report's
	// total cost can be reconciled against the logs with jq (acceptance
	// criterion 2 in HANDOVER.md) instead of being taken on trust.
	await writeFile(
		SESSION_SET_PATH,
		JSON.stringify(
			{
				generated_at: new Date().toISOString(),
				source: source.name,
				sessions_dir: SESSIONS_DIR,
				since_days: sinceDays || null,
				scan,
				totals: {
					sessions: agg.total_sessions,
					cost: agg.total_cost,
					cost_primary: agg.total_cost_primary,
					cost_advisor: agg.total_cost_advisor,
					cost_subagent: agg.total_cost_subagent,
					input_tokens: agg.total_input_tokens,
					output_tokens: agg.total_output_tokens,
				},
				sessions: kept.map((m) => ({
					session_id: m.session_id,
					path: m.session_path,
					log_signature: m.log_signature,
					start_time: m.start_time,
					cost: m.total_cost,
					cost_primary: m.cost_primary,
					cost_advisor: m.cost_advisor,
					cost_subagent: m.cost_subagent,
					sidecars:
						scanned.sessions.find((r) => r.id === m.session_id)?.sidecars.map((s) => s.path) ?? [],
				})),
			},
			null,
			2,
		),
		{ encoding: "utf-8", mode: 0o600 },
	);

	const html = generateHTML(agg, sectionResults, synthesis, temporal);
	await writeFile(REPORT_PATH, html, { encoding: "utf-8" });

	if (formatMd) {
		const md = generateMarkdown(agg, sectionResults, synthesis, temporal, scan, userCtx);
		await writeFile(REPORT_MD_PATH, md, { encoding: "utf-8" });
		ctx.ui.setStatus("insights", "");
		ctx.ui.setWidget("insights", undefined);
		ctx.ui.notify(`✅ Markdown report saved: ${REPORT_MD_PATH}`, "success");
		return;
	}

	ctx.ui.setStatus("insights", "");
	ctx.ui.setWidget("insights", undefined);

	ctx.ui.notify(`✅ Report saved: ${REPORT_PATH}`, "success");

	if (!noOpen) {
		const opener = platform() === "darwin" ? "open" : "xdg-open";
		execFile(opener, [REPORT_PATH]).catch(() => {
			ctx.ui.notify(`Open manually: ${REPORT_PATH}`, "info");
		});
	}
}

// ─── Extension Entry ──────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	pi.registerCommand("insights", {
		description:
			"Generate a personal usage insights report from your omp session history",
		handler: async (args, ctx) => {
			try {
				await runInsights(args ?? "", ctx);
			} catch (err) {
				ctx.ui.setStatus("insights", "");
				ctx.ui.setWidget("insights", undefined);
				ctx.ui.notify(`Insights failed: ${(err as Error).message}`, "error");
			}
		},
	});
}

// ─── Test Seam ────────────────────────────────────────────────────────────────

// Why: the port stays a single file until Stage 2 lands (see HANDOVER.md
// constraints), so the unit-testable internals are re-exported here rather
// than split into modules. Not part of the extension's public surface.
export {
	aggregateData,
	buildSessionMeta,
	computeTemporalData,
	createOmpSessionSource,
	detectConcurrentSessions,
	extractSessionStats,
	extractSidecarUsage,
	gatherUserContext,
	generateMarkdown,
	isMetaSession,
	parseSimpleYaml,
	readUsage,
	resolveLimit,
	toolErrorCategory,
};
export type {
	AggregatedData,
	ScanSummary,
	SessionMeta,
	SessionSource,
	TemporalData,
	UserContext,
};
