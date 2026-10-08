// SPDX-FileCopyrightText: 2026 Hari Srinivasan <harisrini21@gmail.com>
// SPDX-FileCopyrightText: 2026 Tobias Hoelzer (omp port)
// SPDX-License-Identifier: AGPL-3.0-only


// The facet-extraction prompt, the shared data block, the eight section
// prompts and the synthesis prompt. The OMP_FEATURES_REFERENCE list is
// load-bearing: the model can only suggest features it is told exist.

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

` +
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

SESSION SUMMARIES:
${agg.session_summaries.map((s) => `- ${s.summary} (${s.outcome}, ${s.helpfulness})`).join("\n")}

FRICTION DETAILS:
${agg.friction_details.map((d) => `- ${d}`).join("\n")}

USER INSTRUCTIONS TO ASSISTANT:
${agg.user_instructions.map((i) => `- ${i}`).join("\n")}` +
		`\n\nFRICTION SIGNALS:\nInterruption rate: ${(agg.interruption_rate * 100).toFixed(1)}% of human messages were aborted mid-flight or steered ((${agg.aborted_generations} aborted - ${agg.aborted_at_session_end} ended-at-session + ${agg.total_steering} steered) / ${agg.total_messages} human messages).\nAbort outcome labels: ${Object.entries(agg.abort_labels).map(([k, v]) => `${k}=${v}`).join(", ") || "none"}\nProvider errors: ${agg.error_generations} total, by class: ${Object.entries(agg.error_classes).map(([k, v]) => `${k}=${v}`).join(", ") || "none"}\nInvented tool names (never real tools, excluded from tool error rates): ${Object.entries(agg.tool_not_found).map(([k, v]) => `${k}=${v}`).join(", ") || "none"}\nPer-tool error rate (>=5 calls, worst first; "browser" includes eval calls that drive the browser global or failed on the browser relay, so "eval" is plain scripting only; error causes in brackets, cite the cause, not just the tool): ${agg.tool_error_rate_table.slice(0, 8).map(r => `${r.tool} ${(r.rate * 100).toFixed(1)}% (${r.errors}/${r.calls}) [${Object.entries(r.classes).map(([k, v]) => `${k}=${v}`).join(", ")}]`).join(", ") || "none"}\nTTSR rule injections (harness caught a bad generation and injected a rule): ${agg.ttsr_injections} total, rules: ${Object.entries(agg.ttsr_rules).map(([k, v]) => `${k}=${v}`).join(", ") || "none"}\nContext reset boundaries (a path was abandoned and context rewound): ${agg.reset_boundaries}` +
		`\n\nPER-TURN PATHOLOGY (a turn = one human message to the next; the expensive failure mode is one request costing many LLM round trips and tool calls):\n${agg.total_turns} turns across ${agg.total_sessions} sessions. p50: ${agg.turn_p50.round_trips} round trips, ${agg.turn_p50.tool_calls} tool calls, ${agg.turn_p50.exploration} exploration calls before first edit, ${agg.turn_p50.wall_sec.toFixed(0)}s wall clock. p90: ${agg.turn_p90.round_trips} round trips, ${agg.turn_p90.tool_calls} tool calls, ${agg.turn_p90.exploration} exploration calls, ${agg.turn_p90.wall_sec.toFixed(0)}s wall clock.\nWorst turns across the corpus (name these specifically): ${agg.worst_turns_corpus.map(t => `"${t.prompt}" (${t.project}): ${t.llm_round_trips} round trips, ${t.tool_calls} tool calls, ${t.exploration_before_first_mutation} exploration-before-edit, ${t.wall_sec.toFixed(0)}s, $${t.cost.toFixed(2)}`).join("; ") || "none"}` +
		`\n\nPER-TOOL WALL CLOCK (startedAt paired with the matching toolResult by toolCallId; "intent" is absent for sessions after 2026-10-07 since tools.intentTracing was disabled, so it is never shown):\n${agg.tool_time_share.slice(0, 8).map(t => `${t.tool}: ${t.total_sec.toFixed(0)}s (${(t.share * 100).toFixed(0)}% of tool time)`).join(", ") || "none"}` +
		`\n\nCACHE EFFICIENCY:\nOverall cache hit ratio: ${(agg.cache_hit_ratio * 100).toFixed(1)}% (cacheRead / (input + cacheRead)). A low ratio on a large prompt is the resumed-stale-session tax: money and latency burned re-reading context.\nWorst sessions by ratio (>=50k input+cacheRead tokens): ${agg.worst_cache_sessions.map(s => `${s.project} (${s.tokens} tok, $${s.cost.toFixed(2)}): ${(s.ratio * 100).toFixed(1)}%`).join("; ") || "none"}` +
		`\n\nEDIT CHURN (same file edited repeatedly across the corpus = the model did not understand it the first time):\n${agg.most_churned_files.map(f => `${f.path}: ${f.edits} edits across ${f.sessions} session(s)`).join("; ") || "none"}` +
		`\n\nTEMPORAL CONTEXT:\n${temporal.diff_headlines.length ? "Before/after delta (the only one in the report; quote it with its windows, never compute another): " + temporal.diff_headlines.join("; ") : "No significant before/after change."}\nTrajectory: ${temporal.trajectory.note}\n${temporal.major_transition ? "Major transition on " + temporal.major_transition.when + ": " + temporal.major_transition.what + " (" + temporal.major_transition.impact + ")" : ""}\n${temporal.anomalies.length ? "Notable outlier sessions: " + temporal.anomalies.map(a => a.date + " " + a.cost + " - " + a.reason).join("; ") : ""}\nResolved friction (DO NOT suggest fixes): ${temporal.resolved_friction.map(f => displayLabel(f)).join(", ") || "none"}\nOngoing friction (FOCUS here): ${temporal.ongoing_friction.map(f => displayLabel(f.type) + " (" + f.recent_count + " in last 14d)").join(", ") || "none"}\n\nUSER EXISTING SETUP (DO NOT suggest what's already present):\nDefault model: ${userCtx.default_model || "not set"}\nModel roles: ${Object.entries(userCtx.model_roles).map(([r, m]) => r + "=" + m).join(", ") || "none"}\nFallback chains: ${Object.entries(userCtx.fallback_chains).map(([r, c]) => r + "=" + c.join(">")).join(", ") || "none"}\nSkills: ${userCtx.installed_skills.join(", ") || "none"}\nManaged skills: ${userCtx.installed_managed_skills.join(", ") || "none"}\nExtensions: ${userCtx.installed_extensions.join(", ") || "none"}\nHooks: ${userCtx.installed_hooks.join(", ") || "none"}\nMCP servers: ${userCtx.mcp_servers.join(", ") || "none"}\nExisting AGENTS.md rules: ${userCtx.existing_agents_md_rules.slice(0, 10).join(" | ") || "none"}`
	);
}

// Why this list is load-bearing: the model can only suggest features it is
// told exist, so a wrong or Pi-shaped list is the main way the report turns
// into useless advice. Keep it aligned with omp's real surface.
export const OMP_FEATURES_REFERENCE = `## OMP FEATURES REFERENCE:
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

export function buildSectionPrompts(data: string, temporal: TemporalData, userCtx: UserContext, agg: AggregatedData) {
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

FRICTION SIGNALS (from toolResult.isError and stopReason, not text heuristics):
- Interruption rate: ${(agg.interruption_rate * 100).toFixed(1)}% of human messages were aborted mid-flight or steered. This is the single strongest "went wrong" signal in the corpus; lead with it if it is high.
- Abort outcome labels: ${Object.entries(agg.abort_labels).map(([k, v]) => `${k}=${v}`).join(", ") || "none"} (user_rephrased/course_correction point at the assistant; abandoned/agent_* labels point at the task or model).
- Provider errors (${agg.error_generations} total) by class: ${Object.entries(agg.error_classes).map(([k, v]) => `${k}=${v}`).join(", ") || "none"}.
- Invented tool names that always fail (excluded from per-tool rates below, but a real bug on their own): ${Object.entries(agg.tool_not_found).map(([k, v]) => `${k} (${v}x)`).join(", ") || "none"}.
- Worst real per-tool error rates (>=5 calls): ${agg.tool_error_rate_table.slice(0, 5).map(r => `${r.tool} ${(r.rate * 100).toFixed(0)}% (${r.errors}/${r.calls})`).join(", ") || "none"}.
- Per-turn pathology: p50 is ${agg.turn_p50.round_trips} round trips / ${agg.turn_p50.tool_calls} tool calls per request; p90 is ${agg.turn_p90.round_trips} round trips / ${agg.turn_p90.tool_calls} tool calls. The expensive failure mode is ONE request costing many LLM round trips and tool calls to make a small change; name the worst turns specifically (prompt + round trips + tool calls), don't just cite the percentile.
- Per-tool wall clock (startedAt paired with the matching toolResult; "intent" is only available before 2026-10-07): ${agg.tool_time_share.slice(0, 5).map(t => `${t.tool} ${t.total_sec.toFixed(0)}s (${(t.share * 100).toFixed(0)}% of tool time)`).join(", ") || "none"}. "The model is slow" and "the model is waiting on your test suite" are different findings; name the tool, not just the session.
- Edit churn: files edited repeatedly across the corpus are a model that did not understand them the first time: ${agg.most_churned_files.slice(0, 5).map(f => `${f.path} (${f.edits}x across ${f.sessions} session(s))`).join(", ") || "none"}.

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
- A tool that fails near 100% of the time, or an invented tool name the model keeps calling, is exactly the class of finding this section exists to surface: check the per-tool error rate table and invented-tool-name list in the data below before writing stop_doing.
- A turn costing many round trips and tool calls to change little (see worst_turns_corpus in the data) is the other class of finding this section exists to surface: over-exploration before an edit, repeated failed attempts, or a model that should have asked instead of guessing.
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
				const price = u.list_price ? `list price $${u.list_price.input_per_mtok}/Mtok input, $${u.list_price.output_per_mtok}/Mtok output` : "list price unknown";
				return `- ${m.replace(/.*\//, "")}: ${u.sessions} sessions, $${u.cost.toFixed(2)} total, ${u.message_count} msgs, tier=${u.tier || "mid"}, ${price}`;
			}).join("\n");
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
