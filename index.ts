// SPDX-FileCopyrightText: 2026 Hari Srinivasan <harisrini21@gmail.com>
// SPDX-FileCopyrightText: 2026 Tobias Hoelzer (omp port)
// SPDX-License-Identifier: AGPL-3.0-only
//
// Modified from Observal/pi-insights: ported from the Pi coding agent to the
// omp harness. See README.md "Port status" and the repository history.

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
import { writeFile } from "node:fs/promises";
import { platform } from "node:os";
import { promisify } from "node:util";

import { createClaudeSessionSource } from "./src/sources/claude.ts";
import { createOmpSessionSource, ompSessionSource } from "./src/sources/omp.ts";
import { gatherUserContext, parseSimpleYaml } from "./src/context.ts";
import {
	deleteCachedFacets,
	ensureDirs,
	loadCachedFacets,
	loadCachedSections,
	loadCachedMeta,
	loadLatestSections,
	pruneSections,
	REPORT_MD_PATH,
	REPORT_PATH,
	saveFacets,
	saveMeta,
	saveSections,
	SESSION_SET_PATH,
} from "./src/cache.ts";
import { computeTemporalData } from "./src/temporal.ts";
import { aggregateData, detectConcurrentSessions, excludeToolingSessions } from "./src/aggregate.ts";
import { detectHarnessChanges, gatherHarnessState, type HarnessState } from "./src/harness.ts";
import {
	buildFeaturesReference,
	buildSectionPrompts,
	buildSharedDataBlock,
	buildSynthesisPrompt,
	CHUNK_SUMMARIZE_PROMPT,
	FACET_EXTRACT_PROMPT,
	filterByEvidence,
	filterSuggestions,
	type ConfigAddition,
	type FeatureToTry,
	type OngoingFrictionItem,
	type StopDoingItem,
	type SuggestionSections,
	type UsagePattern,
} from "./src/prompts.ts";
import { callModel, createLimiter, parseJsonFromResponse } from "./src/model.ts";
import { generateMarkdown } from "./src/render/md.ts";
import { generateHTML } from "./src/render/html.ts";
import { buildFacts, checkFacts, type Fact } from "./src/facts.ts";
import {
	buildSessionMeta,
	extractSessionStats,
	extractSidecarUsage,
	isMetaSession,
	readUsage,
	toolErrorCategory,
} from "./src/stats.ts";
import type {
	AggregatedData,
	HarnessChange,
	ScanSummary,
	SessionFacets,
	SessionMeta,
	SessionRef,
	SessionSource,
	TemporalData,
	UserContext,
} from "./src/types.ts";

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


// Why: the corpus is already ~400 sessions, so upstream's 200 load cap would
// silently truncate it. Loading is cached per session and costs no tokens, so
// the default is raised past the corpus size; facet extraction stays capped
// because that phase spends money. All three are flag- and env-overridable
// (--max-sessions / --max-facets / --model-concurrency,
// OMP_INSIGHTS_MAX_SESSIONS / _MAX_FACETS / _MODEL_CONCURRENCY).
const DEFAULT_MAX_SESSIONS_TO_LOAD = 2000;
const DEFAULT_MAX_FACET_EXTRACTIONS = 50;
// Why: caps live `omp -p` subprocesses across every LLM phase. Each is a full
// omp process (~450 MB RSS); upstream's 50 assumed in-process HTTP calls and,
// multiplied by transcript chunks, spawned enough processes to freeze a Mac.
const DEFAULT_MODEL_CONCURRENCY = 4;
const META_BATCH_SIZE = 50;
const LOAD_BATCH_SIZE = 10;
// Stage 2: the LLM phases are wired. Facet extraction, the section prompts and
// the synthesis run through `omp -p` subprocesses (see callModel).
const LLM_PHASES_ENABLED = true;

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

/** `--<flag> a,b` on the command line, else `$ENV` (comma-separated), else the default list. The literal "none" (either source) opts out of the default entirely. */
function resolveProjectList(
	args: string,
	flag: string,
	envVar: string,
	fallback: string[],
): string[] {
	const match = args.match(new RegExp(`--${flag}[\\s=](\\S+)`));
	const raw = match?.[1] ?? process.env[envVar];
	if (!raw) return fallback;
	if (raw.toLowerCase() === "none") return [];
	return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

// B11: this tool's own development sessions dominate worst-turn and friction
// signals meant to reflect the user's other work; excluded by default,
// overridable with --exclude-projects/OMP_INSIGHTS_EXCLUDE_PROJECTS (comma
// separated, substring-matched against project_path; "none" opts out entirely).
const DEFAULT_EXCLUDE_PROJECTS = ["oh-my-pi-insights"];

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
	const excludeProjects = resolveProjectList(
		args,
		"exclude-projects",
		"OMP_INSIGHTS_EXCLUDE_PROJECTS",
		DEFAULT_EXCLUDE_PROJECTS,
	);

	const limits = {
		maxSessions: resolveLimit(args, "max-sessions", "OMP_INSIGHTS_MAX_SESSIONS", DEFAULT_MAX_SESSIONS_TO_LOAD),
		maxFacets: resolveLimit(args, "max-facets", "OMP_INSIGHTS_MAX_FACETS", DEFAULT_MAX_FACET_EXTRACTIONS),
		modelConcurrency: resolveLimit(args, "model-concurrency", "OMP_INSIGHTS_MODEL_CONCURRENCY", DEFAULT_MODEL_CONCURRENCY),
	};
	// One gate shared by facets, chunk summaries, sections and synthesis.
	const limitModel = createLimiter(limits.modelConcurrency);

	// Stage 1 never calls a model, so an active model is only required once the
	// LLM phases are wired.
	if (useLlm && !ctx.model) {
		ctx.ui.notify("No active model — set a model first (/model)", "error");
		return;
	}

	await ensureDirs();

	// --source claude reads ~/.claude/projects instead of omp's sessions. The
	// two corpora are not merged: their records carry different signals, and a
	// single total across both would hide which harness it came from.
	const source: SessionSource = args.includes("--source claude")
		? createClaudeSessionSource()
		: ompSessionSource;
	// Fetched before the LLM phases: the facet phase needs the smol model role
	// out of it, and the section prompts need the installed-skills list.
	const userCtx = await gatherUserContext();
	// B9: config.yml.bak-* snapshots, skill/hook install dates and AGENTS.md
	// mtime, diffed against the report window further down once date_range is
	// known (fs-only, costs no tokens, so gathered alongside userCtx).
	const harnessState = await gatherHarnessState();
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
		sessions_dir: source.root,
		primary_logs: scanned.sessions.length,
		duplicate_logs: scanned.duplicate_logs,
		advisor_logs: 0,
		subagent_logs: 0,
		excluded_meta: 0,
		excluded_current: 0,
		excluded_unparsed: 0,
		excluded_not_substantive: 0,
		excluded_by_since: 0,
		excluded_tooling: 0,
		facet_failures: 0,
		facets_analyzed: 0,
		reused_stale_sections: false,
		included: 0,
		source: source.name,
		cost_unavailable: 0,
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
			batch.map((ref) => loadCachedMeta(source.name, ref.id, ref.signature)),
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

					if (source.isMetaSession(entries)) {
						scan.excluded_meta++;
						return;
					}

					// Sidecars are read here and folded into the parent: advisor and
					// subagent spend is real money that belongs to this session.
					const sidecars = await Promise.all(
						ref.sidecars.map(async (sidecar) => ({
							kind: sidecar.kind,
							usage: source.readSidecar(await source.readEntries(sidecar.path)),
						})),
					);

					const meta = source.buildMeta(ref, entries, sidecars);
					await saveMeta(source.name, meta);
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
		for (let i = 0; i < needsFacets.length; i += limits.modelConcurrency) {
			const batch = needsFacets.slice(i, i + limits.modelConcurrency);
			await Promise.all(
				batch.map(async (meta) => {
					try {
						const entries = await source.readEntries(meta.session_path);
						let transcript = source.formatTranscript(entries, meta);

						// Summarize long transcripts
						if (transcript.length > 30_000) {
							const CHUNK = 25_000;
							const chunks: string[] = [];
							for (let ci = 0; ci < transcript.length; ci += CHUNK)
								chunks.push(transcript.slice(ci, ci + CHUNK));
							const summaries = await Promise.all(
								chunks.map((ch) =>
									limitModel(() => callModel(CHUNK_SUMMARIZE_PROMPT + ch, { model: facetModel })).catch(
										() => ch.slice(0, 2000),
									),
								),
							);
							transcript = `Session: ${meta.session_id.slice(0, 8)}\nDate: ${meta.start_time}\nProject: ${meta.project_path}\n[Long session - summarized]\n\n${summaries.join("\n\n---\n\n")}`;
						}

						const abortBlock = `\n\nABORT EVENTS (generations the user killed mid-flight; label each by its ts; empty list means none occurred):\n${
							meta.abort_events.length
								? meta.abort_events
										.map(
											(e) =>
												`- ts=${e.ts} elapsed=${e.elapsed_sec.toFixed(0)}s tool_calls_before=${e.tool_calls_before_abort}\n  partial: ${e.partial_text || "(empty)"}\n  next_user_message: ${e.next_user_text ?? "(none, session ended here)"}`,
										)
										.join("\n")
								: "(none)"
						}`;

						const prompt = `${FACET_EXTRACT_PROMPT}${transcript}${abortBlock}

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
  "user_instructions_to_assistant": ["instruction1", "instruction2"],
  "abort_labels": [{"ts": "exact ts string from ABORT EVENTS above", "label": "user_rephrased|agent_wrong_direction|agent_too_slow|abandoned"}]
}`;

						const text = await limitModel(() => callModel(prompt, { model: facetModel }));
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
	// B11: drop this tool's own dev sessions before any downstream analysis —
	// see excludeToolingSessions for why this is a full exclude, not a tag.
	const analyzed = excludeToolingSessions(kept, excludeProjects);
	scan.excluded_tooling = kept.length - analyzed.length;
	const agg = aggregateData(analyzed, facetsMap);
	scan.included = analyzed.length;
	scan.facets_analyzed = agg.sessions_with_facets;
	scan.cost_unavailable = analyzed.filter((m) => m.cost_recorded === false).length;
	const temporal = computeTemporalData(analyzed, facetsMap);
	// B9: a separate, config/filesystem-derived "what changed" signal — see
	// src/harness.ts. Only meaningful once a date range exists to diff against.
	if (agg.date_range.start && agg.date_range.end) {
		const harnessChanges: HarnessChange[] = detectHarnessChanges(
			harnessState,
			agg.date_range.start,
			agg.date_range.end,
		);
		if (harnessChanges.length) temporal.harness_changes = harnessChanges;
	}
	const facts = buildFacts(agg, temporal);
	const dataBlock = buildSharedDataBlock(agg, temporal, userCtx, facts);
	const sectionPrompts = buildSectionPrompts(dataBlock, temporal, userCtx, agg);

	// Keyed on the prompt inputs, not the clock: the same corpus and the same
	// model produce the same prose, so a re-run should cost nothing.
	// The source is part of the key: an omp report's prose must never be
	// reused for a Claude Code corpus, which --no-llm would otherwise do.
	const sectionsKey = `${source.name}-${createHash("sha256")
		.update(`${activeModel ?? "default"}\n${dataBlock}`)
		.digest("hex")
		.slice(0, 32)}`;
	const exactSections = refresh ? null : await loadCachedSections(sectionsKey);
	const staleSections =
		exactSections || !noLlm ? null : await loadLatestSections(source.name);
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
				const text = await limitModel(() => callModel(sectionPrompts[key], { model: activeModel }));
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

	// B8: drop suggestions naming an unavailable feature or an installed skill,
	// whether the section came fresh or from cache — the live harness state can
	// change (e.g. memory.backend) after a cached run was generated.
	// B10: drop stop_doing/suggestion items citing fewer than 2 distinct
	// evidence sessions — same reasoning, applied regardless of cache freshness.
	if (sectionResults.suggestions) {
		sectionResults.suggestions = filterSuggestions(
			filterByEvidence(sectionResults.suggestions as SuggestionSections),
			userCtx,
		);
	}

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
			const synthText = await limitModel(() =>
				callModel(buildSynthesisPrompt(dataBlock, sectionResults), { model: activeModel }),
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
			await pruneSections(source.name);
		}
	}

	// Why: the prompts are told to quote facts only; this catches the prose
	// that derived its own percentage or dollar amount anyway.
	const factFlags = checkFacts({ ...sectionResults, at_a_glance: synthesis }, facts);
	if (factFlags.length) {
		const pct = factFlags.filter((f) => f.unit === "pct").length;
		ctx.ui.notify(
			`Fact check: ${pct} percentage(s) and ${factFlags.length - pct} dollar amount(s) in the prose match no computed fact (see fact_check in ${SESSION_SET_PATH})`,
			"warning",
		);
	}

	// ── Phase 5: Render HTML ──────────────────────────────────────────────────────
	ctx.ui.setWidget("insights", [
		"",
		"  📊 omp Insights",
		"  ─────────────────────────────────",
		"  Phase 5/5: Rendering report...",
	]);

	// Audit manifest: the exact session set behind the numbers, so a report's
	// total cost can be reconciled against the logs with jq
	// (tools/verify-cost.sh) instead of being taken on trust.
	await writeFile(
		SESSION_SET_PATH,
		JSON.stringify(
			{
				generated_at: new Date().toISOString(),
				source: source.name,
				sessions_dir: source.root,
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
				fact_check: { flags: factFlags, facts },
				sessions: analyzed.map((m) => ({
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

// Why: tests exercise internals through this single seam rather than importing
// src/ modules directly, so the module layout can change without touching
// tests. Not part of the extension's public surface.
export {
	createClaudeSessionSource,
	createLimiter,
	aggregateData,
	buildFeaturesReference,
	buildSessionMeta,
	computeTemporalData,
	createOmpSessionSource,
	detectConcurrentSessions,
	detectHarnessChanges,
	excludeToolingSessions,
	extractSessionStats,
	extractSidecarUsage,
	filterByEvidence,
	filterSuggestions,
	gatherHarnessState,
	gatherUserContext,
	generateHTML,
	generateMarkdown,
	buildFacts,
	checkFacts,
	isMetaSession,
	parseSimpleYaml,
	readUsage,
	resolveLimit,
	toolErrorCategory,
};
export type {
	AggregatedData,
	ConfigAddition,
	ExtensionAPI,
	ExtensionCommandContext,
	Fact,
	FeatureToTry,
	HarnessState,
	OngoingFrictionItem,
	ScanSummary,
	SessionFacets,
	SessionMeta,
	SessionRef,
	SessionSource,
	StopDoingItem,
	SuggestionSections,
	TemporalData,
	UsagePattern,
	UserContext,
};
