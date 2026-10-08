// SPDX-FileCopyrightText: 2026 Hari Srinivasan <harisrini21@gmail.com>
// SPDX-FileCopyrightText: 2026 Tobias Hoelzer (omp port)
// SPDX-License-Identifier: AGPL-3.0-only


// The facet-extraction prompt, the shared data block, the eight section
// prompts and the synthesis prompt. buildFeaturesReference is load-bearing:
// the model can only suggest features it is told exist, so it is built from
// live harness state rather than a hardcoded list (see B8).


import { top8 } from "./aggregate.ts";
import { displayLabel } from "./stats.ts";
import { formatFactsForPrompt, type Fact } from "./facts.ts";
import type { AggregatedData, TemporalData, UserContext } from "./types.ts";

export const CHUNK_SUMMARIZE_PROMPT = `Summarize this portion of a session transcript. Focus on:
1. What the user asked for
2. What the assistant did (tools used, files modified)
3. Any friction or issues
4. The outcome

Keep it concise - 3-5 sentences. Preserve specific details like file names, error messages, and user feedback.

TRANSCRIPT CHUNK:
`;

export const FACET_EXTRACT_PROMPT = `Analyze this session and extract structured facets.

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

6. abort_labels: for each entry under ABORT EVENTS below (if any), judge from the transcript, the partial text and what the user said next whether the abort was:
   - user_rephrased: the user was going to ask for something slightly different and just restarted
   - agent_wrong_direction: the assistant was headed the wrong way and the user cut it off
   - agent_too_slow: the assistant was on the right track but taking too long or too many steps
   - abandoned: the user dropped the thread, no related follow-up
   Echo back the exact "ts" string from the ABORT EVENTS list. Omit the field entirely (or use an empty array) if no ABORT EVENTS are listed.

SESSION:
`;

export function buildSharedDataBlock(agg: AggregatedData, temporal: TemporalData, userCtx: UserContext, facts: Fact[]): string {
	return (
		// Why first: the facts are the only numbers the prose may quote as a
		// percentage or dollar amount; checkFacts flags anything else.
		`FACTS (read-only; the ONLY percentages and dollar amounts you may write. Quote a fact's value as given, with its n and window where it helps. Never compute a new percentage, ratio, before/after delta or savings estimate yourself, never divide two numbers from the data below. If the number you want is not a fact, describe it in words or as a raw count):
${formatFactsForPrompt(facts)}

${agg.subscription_cost > 0 ? `NOTE: cost_usd below is API-equivalent cost (the list-price value of tokens used), not money spent, because some usage runs on a subscription plan rather than billed API keys. billed_cost_usd is money actually spent via API keys; subscription_cost_usd is list-price equivalent only, never money spent. Say "API-equivalent cost" for the total, never "spend" or "spent".\n\n` : ""}` +
		JSON.stringify(
			{
				sessions: agg.total_sessions,
				analyzed: agg.sessions_with_facets,
				date_range: agg.date_range,
				messages: agg.total_messages,
				hours: Math.round(agg.total_duration_hours),
				commits: agg.git_commits,
				cost_usd: agg.total_cost.toFixed(2),
				cost_by_provider: agg.cost_by_provider,
				billed_cost_usd: agg.billed_cost.toFixed(2),
				subscription_cost_usd: agg.subscription_cost.toFixed(2),
				top_tools: top8(agg.tool_counts),
				top_goals: top8(agg.goal_categories),
				outcomes_decay_weighted: agg.outcomes,
				outcome_counts: agg.outcome_counts,
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
				aborted_generations: agg.aborted_generations,
				aborted_at_session_end: agg.aborted_at_session_end,
				error_generations: agg.error_generations,
				error_classes: agg.error_classes,
				ttsr_injections: agg.ttsr_injections,
				ttsr_rules: agg.ttsr_rules,
				reset_boundaries: agg.reset_boundaries,
				interruption_rate_pct: (agg.interruption_rate * 100).toFixed(1),
				tool_not_found: agg.tool_not_found,
				tool_error_rate_table: agg.tool_error_rate_table.slice(0, 10),
				abort_labels: agg.abort_labels,
				subagent_sessions: agg.sessions_using_subagent,
				mcp_sessions: agg.sessions_using_mcp,
				model_usage: agg.model_usage,
				model_efficiency_flags: agg.model_efficiency.length,
				estimated_waste_usd: agg.estimated_waste.toFixed(2),
				total_turns: agg.total_turns,
				turn_p50: agg.turn_p50,
				turn_p90: agg.turn_p90,
				worst_turns_corpus: agg.worst_turns_corpus,
				tool_time_share: agg.tool_time_share.slice(0, 10),
				cache_hit_ratio_pct: (agg.cache_hit_ratio * 100).toFixed(1),
				worst_cache_sessions: agg.worst_cache_sessions,
				most_churned_files: agg.most_churned_files,
			},
			null,
			2,
		) +
		`

SESSION SUMMARIES (the leading [id] is the session id to cite in evidence_sessions):
${agg.session_summaries.map((s) => `- [${s.id}] ${s.summary} (${s.outcome}, ${s.helpfulness})`).join("\n")}

FRICTION DETAILS:
${agg.friction_details.map((d) => `- ${d}`).join("\n")}

USER INSTRUCTIONS TO ASSISTANT:
${agg.user_instructions.map((i) => `- ${i}`).join("\n")}` +
		`\n\nFRICTION SIGNALS:\nInterruption rate: ${(agg.interruption_rate * 100).toFixed(1)}% of human messages were aborted mid-flight or steered ((${agg.aborted_generations} aborted - ${agg.aborted_at_session_end} ended-at-session + ${agg.total_steering} steered) / ${agg.total_messages} human messages).\nAbort outcome labels: ${Object.entries(agg.abort_labels).map(([k, v]) => `${k}=${v}`).join(", ") || "none"}\nProvider errors: ${agg.error_generations} total, by class: ${Object.entries(agg.error_classes).map(([k, v]) => `${k}=${v}`).join(", ") || "none"}\nInvented tool names (never real tools, excluded from tool error rates): ${Object.entries(agg.tool_not_found).map(([k, v]) => `${k}=${v}`).join(", ") || "none"}\nPer-tool error rate (>=5 calls, worst first; "browser" includes eval calls whose code drives the browser global, so "eval" is plain scripting only): ${agg.tool_error_rate_table.slice(0, 8).map(r => `${r.tool} ${(r.rate * 100).toFixed(1)}% (${r.errors}/${r.calls})`).join(", ") || "none"}\nTTSR rule injections (harness caught a bad generation and injected a rule): ${agg.ttsr_injections} total, rules: ${Object.entries(agg.ttsr_rules).map(([k, v]) => `${k}=${v}`).join(", ") || "none"}\nContext reset boundaries (a path was abandoned and context rewound): ${agg.reset_boundaries}` +
		`\n\nPER-TURN PATHOLOGY (a turn = one human message to the next; the expensive failure mode is one request costing many LLM round trips and tool calls):\n${agg.total_turns} turns across ${agg.total_sessions} sessions. p50: ${agg.turn_p50.round_trips} round trips, ${agg.turn_p50.tool_calls} tool calls, ${agg.turn_p50.exploration} exploration calls before first edit, ${agg.turn_p50.wall_sec.toFixed(0)}s wall clock. p90: ${agg.turn_p90.round_trips} round trips, ${agg.turn_p90.tool_calls} tool calls, ${agg.turn_p90.exploration} exploration calls, ${agg.turn_p90.wall_sec.toFixed(0)}s wall clock.\nWorst turns across the corpus (name these specifically): ${agg.worst_turns_corpus.map(t => `"${t.prompt}" (${t.project}): ${t.llm_round_trips} round trips, ${t.tool_calls} tool calls, ${t.exploration_before_first_mutation} exploration-before-edit, ${t.wall_sec.toFixed(0)}s, $${t.cost.toFixed(2)}`).join("; ") || "none"}` +
		`\n\nPER-TOOL WALL CLOCK (startedAt paired with the matching toolResult by toolCallId${agg.tool_calls_with_intent > 0 ? `; ${agg.tool_calls_with_intent} of these calls also carry an "intent" field: use it to explain why a slow tool call happened, not just which tool` : ""}):\n${agg.tool_time_share.slice(0, 8).map(t => `${t.tool}: ${t.total_sec.toFixed(0)}s (${(t.share * 100).toFixed(0)}% of tool time)`).join(", ") || "none"}` +
		`\n\nCACHE EFFICIENCY:\nOverall cache hit ratio: ${(agg.cache_hit_ratio * 100).toFixed(1)}% (cacheRead / (input + cacheRead)). A low ratio on a large prompt is the resumed-stale-session tax: money and latency burned re-reading context.\nWorst sessions by ratio (>=50k input+cacheRead tokens): ${agg.worst_cache_sessions.map(s => `${s.project} (${s.tokens} tok, $${s.cost.toFixed(2)}): ${(s.ratio * 100).toFixed(1)}%`).join("; ") || "none"}` +
		`\n\nEDIT CHURN (same file edited repeatedly across the corpus = the model did not understand it the first time):\n${agg.most_churned_files.map(f => `${f.path}: ${f.edits} edits across ${f.sessions} session(s)`).join("; ") || "none"}` +
		`\n\nTEMPORAL CONTEXT:\n${temporal.diff_headlines.length ? "Before/after delta (the only one in the report; quote it with its windows, never compute another): " + temporal.diff_headlines.join("; ") : "No significant before/after change."}\nTrajectory: ${temporal.trajectory.note}\n${temporal.major_transition ? "Major transition on " + temporal.major_transition.when + ": " + temporal.major_transition.what + " (" + temporal.major_transition.impact + ")" : ""}\n${temporal.anomalies.length ? "Notable outlier sessions: " + temporal.anomalies.map(a => a.date + " " + a.cost + " - " + a.reason).join("; ") : ""}\nResolved friction (DO NOT suggest fixes): ${temporal.resolved_friction.map(f => displayLabel(f)).join(", ") || "none"}\nOngoing friction (FOCUS here): ${temporal.ongoing_friction.map(f => displayLabel(f.type) + " (" + f.recent_count + " in last 14d)").join(", ") || "none"}\n\nUSER EXISTING SETUP (DO NOT suggest what's already present):\nDefault model: ${userCtx.default_model || "not set"}\nModel roles: ${Object.entries(userCtx.model_roles).map(([r, m]) => r + "=" + m).join(", ") || "none"}\nFallback chains: ${Object.entries(userCtx.fallback_chains).map(([r, c]) => r + "=" + c.join(">")).join(", ") || "none"}\nSkills: ${userCtx.installed_skills.join(", ") || "none"}\nManaged skills: ${userCtx.installed_managed_skills.join(", ") || "none"}\nExtensions: ${userCtx.installed_extensions.join(", ") || "none"}\nHooks: ${userCtx.installed_hooks.join(", ") || "none"}\nMCP servers: ${userCtx.mcp_servers.join(", ") || "none"}\nExisting AGENTS.md rules: ${userCtx.existing_agents_md_rules.slice(0, 10).join(" | ") || "none"}`
	);
}

// B8: the features reference is built at run time from the live harness
// state (memory backend, autolearn, installed skills/hooks) rather than a
// hardcoded, Pi-shaped list: the model can only suggest features it is told
// exist, so a wrong list is the main way the report turns into useless advice.
function memoryFeatureBlock(ctx: UserContext): string {
	const learnAvailable = ctx.autolearn_enabled && ctx.memory_backend !== "off";
	const manageSkillNote = ctx.autolearn_enabled
		? " autolearn is on, so manage_skill can also write new skills on its own."
		: "";
	const learnNote = learnAvailable
		? " The learn tool also records facts automatically (autolearn is on)."
		: "";
	if (ctx.memory_backend === "hindsight" || ctx.memory_backend === "mnemopi") {
		const mnemopi = ctx.memory_backend === "mnemopi";
		const tools = mnemopi ? "retain/recall/reflect/memory_edit" : "retain/recall/reflect";
		return `2. Memory (${ctx.memory_backend}: ${tools}) - durable project/user facts
   recorded via the retain tool, searched via recall or synthesised with
   reflect${mnemopi ? ", corrected via memory_edit" : ""}.${learnNote}
   - Good for: conventions, non-obvious fixes, user preferences that must survive sessions`;
	}
	if (ctx.memory_backend === "local") {
		return `2. Memory (local backend) - file-backed memory readable at memory://root
   (summary, MEMORY.md, skills).${learnNote}
   - Good for: conventions, non-obvious fixes, user preferences that must survive sessions`;
	}
	// "off" (the default) or any other unrecognized value.
	return `2. Memory - no memory backend is enabled (memory.backend is unset or "off"
   in ~/.omp/agent/config.yml), so nothing persists across sessions.${manageSkillNote}
   Enable one by setting memory.backend to "local" (file-backed, summarised at
   memory://root), "hindsight" or "mnemopi" (both add retain/recall/reflect).
   - Good for: suggesting this as a config_additions item when the data shows facts being re-explained every session`;
}

export function buildFeaturesReference(ctx: UserContext): string {
	const managedSkillsNote = ctx.autolearn_enabled ? " (agent-authored via the manage_skill tool)" : "";
	return `## OMP FEATURES REFERENCE:
1. Skills - SKILL.md procedures in ~/.omp/agent/skills/ (user-authored) and
   ~/.omp/agent/managed-skills/${managedSkillsNote};
   surfaced automatically by name/description match, read with skill://<name>
   - Good for: repeatable procedures, debugging recipes, project workflows
   - Rule: never suggest a skill whose name already appears in the installed list

${memoryFeatureBlock(ctx)}

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
}

export type ConfigAddition = { addition: string; why: string; where: string; evidence_sessions: string[] };
export type FeatureToTry = { feature: string; one_liner: string; why_for_you: string; example: string; evidence_sessions: string[] };
export type UsagePattern = { title: string; suggestion: string; detail: string; copyable_prompt: string; evidence_sessions: string[] };
export type StopDoingItem = { what: string; why: string; alternative: string; evidence_sessions: string[] };
/** friction_analysis's "ongoing" items; carries evidence_sessions like the suggestion item types (B10), but is not run through filterByEvidence — the fix design filters stop_doing/suggestions only. */
export type OngoingFrictionItem = { category: string; description: string; examples: string[]; severity: string; evidence_sessions: string[] };

export type SuggestionSections = {
	config_additions?: ConfigAddition[];
	features_to_try?: FeatureToTry[];
	usage_patterns?: UsagePattern[];
	stop_doing?: StopDoingItem[];
};

// Filler words that show up in both naming phrases and skill slugs without
// signalling an actual topic match (e.g. every suggestion title is a "skill"
// or mentions "with"); dropped before comparing tokens below.
const SKILL_MATCH_STOPWORDS: Record<string, true> = {
	skill: true,
	skills: true,
	with: true,
	your: true,
	that: true,
	this: true,
};

/**
 * "Close match" between a suggestion's naming phrase and an installed skill:
 * an exact substring match, or enough shared significant (len > 3,
 * non-filler) tokens relative to the shorter phrase's token count. The
 * suggestion phrase is normally short (a feature/skill name, not a full
 * sentence), so a single shared keyword against a short phrase is already a
 * majority overlap.
 */
function isNearDuplicateSkill(candidateText: string, installedSkill: string): boolean {
	const a = candidateText.toLowerCase().replace(/[-_]/g, " ").replace(/\s+/g, " ").trim();
	const b = installedSkill.toLowerCase().replace(/[-_]/g, " ").replace(/\s+/g, " ").trim();
	if (!a || !b) return false;
	if (b.length >= 4 && a.includes(b)) return true;
	const significant = (t: string) => t.length > 3 && !SKILL_MATCH_STOPWORDS[t];
	const ta = new Set(a.split(" ").filter(significant));
	const tb = new Set(b.split(" ").filter(significant));
	const shared = [...ta].filter((t) => tb.has(t));
	const minLen = Math.min(ta.size, tb.size);
	return minLen > 0 && shared.length / minLen >= 0.5;
}

function primaryName(item: Record<string, unknown>): string {
	for (const key of ["feature", "what", "title", "addition"]) {
		const v = item[key];
		if (typeof v === "string") return v;
	}
	return "";
}

function mentionsInstalledSkill(item: Record<string, unknown>, ctx: UserContext): boolean {
	const name = primaryName(item);
	if (!/skill/i.test(name)) return false;
	const installed = [...ctx.installed_skills, ...ctx.installed_managed_skills];
	return installed.some((skill) => isNearDuplicateSkill(name, skill));
}

function keepSuggestion(item: Record<string, unknown>, ctx: UserContext): boolean {
	const allText = Object.values(item)
		.filter((v): v is string => typeof v === "string")
		.join(" ");
	const learnAvailable = ctx.autolearn_enabled && ctx.memory_backend !== "off";
	const retainAvailable = ctx.memory_backend === "hindsight" || ctx.memory_backend === "mnemopi";
	const unavailableLearn = !learnAvailable && /\blearn tool\b|memory \(learn\)/i.test(allText);
	const unavailableManageSkill = !ctx.autolearn_enabled && /\bmanage_skill\b/i.test(allText);
	const unavailableRetain = !retainAvailable && /\bretain\b|\brecall\b|\breflect\b|\bmemory_edit\b/i.test(allText);
	return !unavailableLearn && !unavailableManageSkill && !unavailableRetain && !mentionsInstalledSkill(item, ctx);
}

/**
 * Drops suggestions naming an unavailable feature (e.g. the learn tool when
 * autolearn is off, or retain/recall when memory.backend is "off" or
 * "local") or an already-installed skill (name or close match), after the
 * model has generated them. Prompt-side instructions alone are not reliable
 * enough to prevent this: a suggestion overlapping an already-installed
 * skill by name is exactly the class of finding this was built to catch.
 */
export function filterSuggestions(
	suggestions: SuggestionSections,
	ctx: UserContext,
): SuggestionSections {
	return {
		config_additions: suggestions.config_additions?.filter((i) => keepSuggestion(i, ctx)),
		features_to_try: suggestions.features_to_try?.filter((i) => keepSuggestion(i, ctx)),
		usage_patterns: suggestions.usage_patterns?.filter((i) => keepSuggestion(i, ctx)),
		stop_doing: suggestions.stop_doing?.filter((i) => keepSuggestion(i, ctx)),
	};
}

const MIN_EVIDENCE_SESSIONS = 2;

/**
 * B10: an item is only as credible as the sessions behind it. A one-off
 * remark misread as a pattern (e.g. "stop using the browser tool" after one
 * complaint, despite otherwise deliberate use) is the finding this exists to
 * catch. Prompts ask every config_additions, features_to_try, usage_patterns
 * and stop_doing item for evidence_sessions (ids from the data block);
 * anything citing fewer than 2 distinct ids is dropped here rather than
 * trusted on the model's say-so.
 */
export function filterByEvidence(suggestions: SuggestionSections): SuggestionSections {
	const hasEvidence = (item: { evidence_sessions: string[] }) =>
		new Set(item.evidence_sessions).size >= MIN_EVIDENCE_SESSIONS;
	return {
		config_additions: suggestions.config_additions?.filter(hasEvidence),
		features_to_try: suggestions.features_to_try?.filter(hasEvidence),
		usage_patterns: suggestions.usage_patterns?.filter(hasEvidence),
		stop_doing: suggestions.stop_doing?.filter(hasEvidence),
	};
}

export function buildSectionPrompts(data: string, temporal: TemporalData, userCtx: UserContext, agg: AggregatedData) {
	return {
		project_areas: `Analyze this usage data and identify project areas.

RESPOND WITH ONLY A VALID JSON OBJECT:
{
  "areas": [
    {
      "name": "area name",
      "session_count": N,
      "description": "2-3 sentences about what was worked on and how omp was used"
    }
  ]
}

Include 4-5 areas. Skip internal tooling sessions.

DATA:
${data}`,

		interaction_style: `Analyze this usage data and describe your interaction style with omp.
Use second person ("you"). Write plain sentences; no bold, no walls of text.

Pick the 3-4 most distinctive facets of how you work, drawn from: how you
delegate tasks, how you steer or interrupt the assistant, how you tune your
setup (models, config, skills), how you verify results. Only include a facet
that has real evidence in the data below; do not force all four if fewer
stand out.

RESPOND WITH ONLY A VALID JSON OBJECT:
{
  "blocks": [
    {
      "title": "short theme title (3-6 words)",
      "body": "2-4 plain sentences on this facet, <= 60 words. Use 'you'. Include a specific example.",
      "evidence_sessions": ["session id", "another session id"]
    }
  ],
  "key_pattern": "one sentence (<= 30 words) summary of the most distinctive interaction style"
}

Include 3-4 blocks. evidence_sessions is optional per block: include it only
when you can cite real session ids (the "[id]" from SESSION SUMMARIES, or
session_id from worst_turns_corpus/worst_cache_sessions in the data below)
backing that block; never invent one.

DATA:
${data}`,

		what_works: `Analyze this usage data and identify what's working well for you with omp.
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

		friction_analysis: `Analyze this usage data and identify friction points for you.
Use second person ("you").

TEMPORAL CONTEXT:
- Resolved friction (no longer occurring): ${temporal.resolved_friction.map(f => displayLabel(f)).join(", ") || "none detected"}
- Ongoing friction (still happening): ${temporal.ongoing_friction.map(f => displayLabel(f.type) + " (" + f.recent_count + " in last 14 days)").join(", ") || "none detected"}

FRICTION SIGNALS (from toolResult.isError and stopReason, not text heuristics):
- Interruption rate: ${(agg.interruption_rate * 100).toFixed(1)}% of human messages were aborted mid-flight or steered. This is the single strongest "went wrong" signal in the corpus; lead with it if it is high.
- Abort outcome labels: ${Object.entries(agg.abort_labels).map(([k, v]) => `${k}=${v}`).join(", ") || "none"} (user_rephrased/course_correction point at the assistant; abandoned/agent_* labels point at the task or model).
- Provider errors (${agg.error_generations} total) by class: ${Object.entries(agg.error_classes).map(([k, v]) => `${k}=${v}`).join(", ") || "none"}.
- Invented tool names that always fail (excluded from per-tool rates below, but a real bug on their own): ${Object.entries(agg.tool_not_found).map(([k, v]) => `${k} (${v}x)`).join(", ") || "none"}.
- Worst real per-tool error rates (>=5 calls): ${agg.tool_error_rate_table.slice(0, 5).map(r => `${r.tool} ${(r.rate * 100).toFixed(0)}% (${r.errors}/${r.calls})`).join(", ") || "none"}.
- Per-turn pathology: p50 is ${agg.turn_p50.round_trips} round trips / ${agg.turn_p50.tool_calls} tool calls per request; p90 is ${agg.turn_p90.round_trips} round trips / ${agg.turn_p90.tool_calls} tool calls. The expensive failure mode is ONE request costing many LLM round trips and tool calls to make a small change; name the worst turns specifically (prompt + round trips + tool calls), don't just cite the percentile.
- Per-tool wall clock (startedAt paired with the matching toolResult${agg.tool_calls_with_intent > 0 ? `; ${agg.tool_calls_with_intent} calls also carry an "intent" field` : ""}): ${agg.tool_time_share.slice(0, 5).map(t => `${t.tool} ${t.total_sec.toFixed(0)}s (${(t.share * 100).toFixed(0)}% of tool time)`).join(", ") || "none"}. "The model is slow" and "the model is waiting on your test suite" are different findings; name the tool, not just the session.
- Edit churn: files edited repeatedly across the corpus are a model that did not understand them the first time: ${agg.most_churned_files.slice(0, 5).map(f => `${f.path} (${f.edits}x across ${f.sessions} session(s))`).join(", ") || "none"}.

Focus on ONGOING friction. Mention resolved items briefly as wins.
EVIDENCE: every "ongoing" item must include evidence_sessions, an array of
the session ids (the "[id]" from SESSION SUMMARIES, or session_id from
worst_turns_corpus/worst_cache_sessions in the data below) that actually show
this pattern. Cite real ids only; never invent one.

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
      "severity": "high|medium|low",
      "evidence_sessions": ["session id", "another session id"]
    }
  ]
}

Max 2 resolved, 3 ongoing.

DATA:
${data}`,

		suggestions: `Analyze this usage data and suggest improvements for working with omp.

${buildFeaturesReference(userCtx)}

CRITICAL: The user's existing setup is in the data below. DO NOT suggest:
- Rules already in their AGENTS.md
- Skills (including managed skills), extensions, hooks or MCP servers they already have installed
- Fixes for "resolved friction" (listed in TEMPORAL CONTEXT)
FOCUS on ongoing friction. Include at least one NEGATIVE suggestion (something to stop/remove).
- A tool that fails near 100% of the time, or an invented tool name the model keeps calling, is exactly the class of finding this section exists to surface: check the per-tool error rate table and invented-tool-name list in the data below before writing stop_doing.
- A turn costing many round trips and tool calls to change little (see worst_turns_corpus in the data) is the other class of finding this section exists to surface: over-exploration before an edit, repeated failed attempts, or a model that should have asked instead of guessing.
Tailor copyable prompts to their actual model (${userCtx.default_model || "unknown"}) and projects.
EVIDENCE: every item below must include evidence_sessions, an array of >= 2
DISTINCT session ids (the "[id]" from SESSION SUMMARIES, or session_id from
worst_turns_corpus/worst_cache_sessions in the data below) that actually
support it. Cite real ids only, never invent one. If you cannot name two
different sessions backing an item, drop the item instead of writing it.

RESPOND WITH ONLY A VALID JSON OBJECT:
{
  "config_additions": [
    {
      "addition": "a specific rule NOT already in their AGENTS.md",
      "why": "1 sentence referencing actual ongoing friction",
      "where": "AGENTS.md | ~/.omp/agent/config.yml | ~/.omp/agent/extensions/ | ~/.omp/agent/managed-skills/ | ~/.omp/agent/hooks/",
      "evidence_sessions": ["session id", "another session id"]
    }
  ],
  "features_to_try": [
    {
      "feature": "feature name from OMP FEATURES REFERENCE",
      "one_liner": "what it does",
      "why_for_you": "why this helps YOUR ongoing friction patterns",
      "example": "actual command or config referencing their real projects",
      "evidence_sessions": ["session id", "another session id"]
    }
  ],
  "usage_patterns": [
    {
      "title": "short title",
      "suggestion": "1-2 sentence summary",
      "detail": "3-4 sentences referencing actual projects and patterns",
      "copyable_prompt": "specific prompt using their model, projects, tools",
      "evidence_sessions": ["session id", "another session id"]
    }
  ],
  "stop_doing": [
    {
      "what": "something to stop or remove",
      "why": "evidence from sessions",
      "alternative": "what to do instead",
      "evidence_sessions": ["session id", "another session id"]
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
      "whats_possible": "2-3 ambitious sentences about autonomous omp workflows",
      "how_to_try": "1-2 sentences on how to start experimenting with this",
      "copyable_prompt": "detailed prompt to try right now"
    }
  ]
}

Include 3 opportunities. Think ambitiously — autonomous workflows, parallel subagents, self-correcting pipelines, iterating against test suites.

DATA:
${data}`,

		model_efficiency: (() => {
			const modelLines = Object.entries(agg.model_usage).sort((a, b) => b[1].cost - a[1].cost).map(([m, u]) => {
				const price = u.list_price ? `list price $${u.list_price.input_per_mtok}/Mtok input, $${u.list_price.output_per_mtok}/Mtok output` : "list price unknown";
				return `- ${m.replace(/.*\//, "")}: ${u.sessions} sessions, $${u.cost.toFixed(2)} total, ${u.message_count} msgs, tier=${u.tier || "mid"}, ${price}`;
			}).join("\n");
			const subscriptionProviders = (agg.cost_by_provider ?? []).filter((p) => p.auth === "subscription");
			const apiKeyProviders = (agg.cost_by_provider ?? []).filter((p) => p.auth === "api_key");
			const unknownProviders = (agg.cost_by_provider ?? []).filter((p) => p.auth === "unknown");
			const providerLines = (agg.cost_by_provider ?? []).map((p) => `- ${p.provider}: $${p.cost.toFixed(2)} (${p.auth})`).join("\n") || "none";
			return `Analyze this model usage data and identify efficiency issues.

IMPORTANT CONTEXT:
- Model tiers and prices are implied list prices: recorded uncached input/output cost divided by uncached input/output tokens. They do not depend on cache hit ratio, so compare models by these, never by total cost divided by tokens (that blends cache reads in and is not comparable across models).
- Models marked as "subscription" are on fixed monthly plans (e.g. Mistral Pro, ChatGPT Plus, Gemini Advanced). Their effective dollar cost per token is $0. Do NOT recommend switching away from subscription models to "save money."
- However, subscriptions have finite quotas (rate limits, daily message caps, monthly token budgets). Within a subscription, heavier models consume more quota than lighter ones:
  * Mistral Pro: Medium 3.5 uses more message budget than Small or Codestral
  * OpenAI Plus: o1/o3 burn cap faster than GPT-4o or GPT-4o-mini
  * Google: Gemini Pro uses more TPM than Flash
  * Anthropic: Opus uses more quota than Sonnet or Haiku
- For subscription models: suggest using lighter models within the same plan for trivial tasks, reserving the heavy model for complex work.
- For PAYG models: optimize for dollar cost as usual.
- Cache hit ratio (cacheRead / (input + cacheRead)) is ${(agg.cache_hit_ratio * 100).toFixed(1)}% overall. A low ratio on a large prompt is the resumed-stale-session tax: the context gets re-read from scratch instead of hitting cache, burning both money and latency. Worst sessions by ratio: ${agg.worst_cache_sessions.map(s => `${s.project} (${s.tokens} tok): ${(s.ratio * 100).toFixed(1)}%`).join(", ") || "none"}.
- Per-provider cost basis (auth from the actual credential used, not inferred from price):
${providerLines}
Billed cost (money actually spent via API keys): $${(agg.billed_cost ?? 0).toFixed(2)}. Subscription cost (API list-price equivalent for subscription/OAuth providers, NOT money spent): $${(agg.subscription_cost ?? 0).toFixed(2)}.
${subscriptionProviders.length ? `- Subscription providers (${subscriptionProviders.map((p) => p.provider).join(", ")}): their cost is an API-equivalent list-price value, not money spent. NEVER quote a dollar savings figure for them; frame any recommendation about them purely as rate-limit/quota headroom and speed.` : ""}
${apiKeyProviders.length ? `- API-key (billed) providers (${apiKeyProviders.map((p) => p.provider).join(", ")}): dollar savings claims are allowed here, backed by the billed cost above.` : ""}
${unknownProviders.length ? `- Providers with unknown auth (${unknownProviders.map((p) => p.provider).join(", ")}): say the cost basis is unknown for them; do not claim dollar savings or quota framing.` : ""}

The user's models from their sessions (derived from actual usage data):
${modelLines}

RESPOND WITH ONLY A VALID JSON OBJECT:
{
  "summary": "2-3 sentences summarizing model usage efficiency. Use 'you'. Be direct. Distinguish between dollar waste (PAYG) and quota waste (subscription).",
  "overspend_pattern": "1-2 sentences about when expensive PAYG models are used unnecessarily, or empty string if none. Never flag subscription models as dollar overspend.",
  "underspend_pattern": "1-2 sentences about when weaker models fail on complex tasks, or empty string if none",
  "quota_pressure": "1-2 sentences about subscription quota being burned by heavy models on trivial tasks. Suggest lighter models within the same subscription, or offloading to cheap PAYG. Empty string if no subscription models detected or if they're already using light subscription models.",
  "recommendation": "1-2 sentences with a specific model selection strategy. Reference the user's actual models by name. For subscriptions: use light models for simple tasks, reserve heavy ones for complex work. For PAYG: match tier to task complexity.",
  "potential_savings_note": "1 sentence about realistic savings. Quote only the estimated_waste fact; never estimate a savings percentage from per-token rates or model price differences. If most usage is subscription, frame as 'quota preservation' or 'extending your monthly budget' rather than dollar savings.",
  "cache_efficiency_note": "1 sentence about cache hit ratio: either reassuring if high, or naming the specific worst session(s) if a low ratio is burning money/latency on stale-context re-reads. Empty string if ratio is healthy and no session stands out."
}

DATA:
${data}`;
		})(),
	};
}

export function buildSynthesisPrompt(
	data: string,
	sections: Record<string, unknown>,
): string {
	return `You're writing an "At a Glance" section for an omp usage insights report. The goal is to help you understand your patterns and improve how you work with AI assistance.

Use this 4-part structure:

1. What's working
   What is your distinctive style and what impactful things have you done? Keep it high level. Don't be flattering or fluffy. Don't focus on which tools you use.

2. What's hindering you
   Split into two parts:
   (a) assistant-side failures — misunderstandings, wrong approaches, buggy output
   (b) user-side friction — insufficient context, environment issues, setup problems
   Be honest and constructive. Aim for patterns, not one-off incidents.

3. Quick wins to try
   Specific omp features or workflow changes you could adopt immediately. Avoid generic advice — suggest concrete things.

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
