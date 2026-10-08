// SPDX-FileCopyrightText: 2026 Hari Srinivasan <harisrini21@gmail.com>
// SPDX-FileCopyrightText: 2026 Tobias Hoelzer (omp port)
// SPDX-License-Identifier: AGPL-3.0-only


// Deterministic Markdown export (--md): cost attribution, tool error and
// wall-clock tables, worst turns, cache efficiency, edit churn, corpus
// provenance and the user's own setup, plus the LLM-generated narrative.

import { top8 } from "../aggregate.ts";
import { SESSION_SET_PATH } from "../cache.ts";
import { buildActionList } from "./actions.ts";
import { diffConfigAddition } from "./configDiff.ts";
import { itemTitle, stripEmoji } from "./text.ts";
import type { AggregatedData, ScanSummary, TemporalData, UserContext } from "../types.ts";

export function fmtHours(h: number): string {
	if (h < 1) return `${Math.round(h * 60)}m`;
	return `${h.toFixed(1)}h`;
}

export function fmtTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
	return String(n);
}

export function fmtCost(n: number): string {
	if (n < 0.01) return `<$0.01`;
	return `$${n.toFixed(2)}`;
}

export function generateMarkdown(
	agg: AggregatedData,
	sections: Record<string, unknown>,
	synthesis: Record<string, string>,
	temporal: TemporalData,
	scan: ScanSummary,
	userCtx: UserContext,
): string {
	// Why: every rendered text field is LLM-sourced or user-supplied, not
	// chrome; strip emoji from it the same way the HTML renderer does
	// rather than trust the model not to decorate a heading or title.
	const clean = (s: string): string => stripEmoji(s);
	const lines: string[] = [];
	lines.push(scan.source === "omp" ? "# omp Insights" : `# Insights (${scan.source})`);
	lines.push(`> ${agg.date_range.start} to ${agg.date_range.end} | ${agg.total_sessions} sessions | Generated ${new Date().toLocaleDateString()}`);
	lines.push("");
	const actionItems = buildActionList(sections);
	if (actionItems.length) {
		lines.push("## Top Actions");
		actionItems.forEach((item, i) => {
			lines.push(`${i + 1}. **${clean(item.title)}**${item.where ? ` (\`${item.where}\`)` : ""}`);
			lines.push(`   ${clean(item.reason)}`);
			if (item.instead) lines.push(`   ${item.instead.label}: ${clean(item.instead.text)}`);
			if (item.copyable) {
				lines.push("   ```");
				lines.push(`   ${item.copyable.text}`);
				lines.push("   ```");
			}
		});
		lines.push("");
	}

	if (temporal.diff_headlines.length || temporal.major_transition || temporal.harness_changes?.length) {
		lines.push(`## What Changed${temporal.delta ? ` (${temporal.delta.basis === "model_switch" ? "around the model switch" : "last week vs this week"})` : ""}`);
		for (const h of temporal.diff_headlines) lines.push(`- ${clean(h)}`);
		if (temporal.major_transition) lines.push(`- **Major shift (${temporal.major_transition.when}):** ${clean(temporal.major_transition.what)}. ${clean(temporal.major_transition.impact)}`);
		for (const c of temporal.harness_changes ?? []) {
			lines.push(`- **Harness change (${c.when.slice(0, 10)}):** ${clean(c.detail)}${c.too_recent ? " _(too recent to assess impact)_" : ""}`);
		}
		lines.push("");
	}

	if (synthesis.whats_working || synthesis.whats_hindering || synthesis.quick_wins || synthesis.ambitious_workflows) {
		lines.push("## Summary");
		if (synthesis.whats_working) lines.push(`**What's working:** ${clean(synthesis.whats_working)}`);
		if (synthesis.whats_hindering) lines.push(`\n**What's hindering you:** ${clean(synthesis.whats_hindering)}`);
		if (synthesis.quick_wins) lines.push(`\n**Quick wins:** ${clean(synthesis.quick_wins)}`);
		if (synthesis.ambitious_workflows) lines.push(`\n**Ambitious workflows:** ${clean(synthesis.ambitious_workflows)}`);
		lines.push("");
	}

	lines.push("## By the Numbers");
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

	lines.push("## Interruptions and Failures");
	lines.push(`| Metric | Value |`);
	lines.push(`|--------|-------|`);
	lines.push(`| Interruption rate | ${(agg.interruption_rate * 100).toFixed(1)}% of human messages |`);
	lines.push(`| Aborted generations | ${agg.aborted_generations} (${agg.aborted_at_session_end} ended the session there) |`);
	lines.push(`| Steering messages | ${agg.total_steering} |`);
	lines.push(`| Provider errors | ${agg.error_generations} |`);
	lines.push(`| TTSR rule injections | ${agg.ttsr_injections} |`);
	lines.push(`| Context reset boundaries | ${agg.reset_boundaries} |`);
	lines.push("");
	if (Object.keys(agg.abort_labels).length) {
		lines.push("**Abort outcome labels** (facet LLM judgment per event where available, heuristic otherwise):");
		for (const [label, count] of Object.entries(agg.abort_labels).sort((a, b) => b[1] - a[1]))
			lines.push(`- ${label}: ${count}`);
		lines.push("");
	}
	if (agg.error_generations > 0) {
		lines.push("**Provider errors by class:**");
		for (const [cls, count] of Object.entries(agg.error_classes).filter(([, c]) => c > 0).sort((a, b) => b[1] - a[1]))
			lines.push(`- ${cls}: ${count}`);
		lines.push("");
	}
	if (Object.keys(agg.ttsr_rules).length) {
		lines.push("**Rules the harness had to inject mid-session** (it caught a bad generation and told the model to stop):");
		for (const [rule, count] of Object.entries(agg.ttsr_rules).sort((a, b) => b[1] - a[1]))
			lines.push(`- ${rule}: ${count}`);
		lines.push("");
	}
	if (agg.most_churned_files.length) {
		lines.push("**Most re-edited files** (the same file edited repeatedly across the corpus is a model that did not understand it the first time):");
		lines.push(`| Path | Edits | Sessions |`);
		lines.push(`|------|-------|----------|`);
		for (const f of agg.most_churned_files)
			lines.push(`| ${f.path} | ${f.edits} | ${f.sessions} |`);
		lines.push("");
	}

	if (agg.total_turns > 0) {
		lines.push("## Worst Turns");
		lines.push(`A turn is one human message up to the next. ${agg.total_turns} turns across ${agg.total_sessions} sessions.`);
		lines.push("");
		lines.push(`| Prompt | Round Trips | Tool Calls | Exploration-before-edit | Wall Clock | Cost |`);
		lines.push(`|--------|-------------|------------|--------------------------|------------|------|`);
		for (const t of agg.worst_turns_corpus) {
			lines.push(
				`| ${t.prompt.replace(/\|/g, "\\|")} | ${t.llm_round_trips} | ${t.tool_calls} | ${t.exploration_before_first_mutation} | ${t.wall_sec.toFixed(0)}s | $${t.cost.toFixed(2)} |`,
			);
		}
		lines.push("");
		lines.push(
			`p50: ${agg.turn_p50.round_trips} round trips, ${agg.turn_p50.tool_calls} tool calls, ${agg.turn_p50.exploration} exploration calls, ${agg.turn_p50.wall_sec.toFixed(0)}s | p90: ${agg.turn_p90.round_trips} round trips, ${agg.turn_p90.tool_calls} tool calls, ${agg.turn_p90.exploration} exploration calls, ${agg.turn_p90.wall_sec.toFixed(0)}s`,
		);
		lines.push("");
	}

	// Cost attribution. Advisor and subagent logs are separate sessions with
	// their own spend; omitting them undercounts badly, so they are folded
	// into the total and shown separately.
	lines.push("## Where the Money Went");
	lines.push(`| Bucket | Cost | Share |`);
	lines.push(`|--------|------|-------|`);
	const share = (v: number) => (agg.total_cost > 0 ? `${((v / agg.total_cost) * 100).toFixed(1)}%` : "0%");
	lines.push(`| Primary sessions | $${agg.total_cost_primary.toFixed(2)} | ${share(agg.total_cost_primary)} |`);
	lines.push(`| Advisor sidecars (${agg.advisor_logs} ${agg.advisor_logs === 1 ? "log" : "logs"}) | $${agg.total_cost_advisor.toFixed(2)} | ${share(agg.total_cost_advisor)} |`);
	lines.push(`| Subagent sidecars (${agg.subagent_logs} ${agg.subagent_logs === 1 ? "log" : "logs"}) | $${agg.total_cost_subagent.toFixed(2)} | ${share(agg.total_cost_subagent)} |`);
	lines.push(`| **Total** | **$${agg.total_cost.toFixed(2)}** | 100% |`);
	lines.push("");
	if (agg.subscription_cost > 0) {
		const unknownCost = agg.total_cost - agg.billed_cost - agg.subscription_cost;
		lines.push(`API-equivalent cost: $${agg.total_cost.toFixed(2)} (billed: $${agg.billed_cost.toFixed(2)}${unknownCost >= 0.01 ? `, unknown basis: $${unknownCost.toFixed(2)}` : ""}, subscription list-price equivalent: $${agg.subscription_cost.toFixed(2)}).`);
		lines.push("");
	}
	if (agg.cost_by_provider?.length) {
		lines.push("**Cost by provider:**");
		lines.push(`| Provider | Cost | Basis |`);
		lines.push(`|----------|------|-------|`);
		for (const p of agg.cost_by_provider) {
			const basis = p.auth === "subscription" ? "subscription (list-price equivalent, not billed)" : p.auth === "api_key" ? "billed" : "unknown";
			lines.push(`| ${p.provider} | $${p.cost.toFixed(2)} | ${basis} |`);
		}
		lines.push("");
	}
	lines.push(`Out-of-band model calls (titles, auto-thinking, advisor prompts) inside that total: $${agg.total_utility_cost.toFixed(2)}. ${agg.sessions_with_sidecars} of ${agg.total_sessions} sessions had at least one sidecar.`);
	lines.push("");
	lines.push(`**Cache efficiency:** ${(agg.cache_hit_ratio * 100).toFixed(1)}% overall hit ratio (cacheRead / (input + cacheRead)). A low ratio on a large prompt is the resumed-stale-session tax: context re-read from scratch instead of hitting cache, burning money and latency.`);
	lines.push("");
	if (agg.worst_cache_sessions.length) {
		lines.push("**Worst sessions by cache hit ratio** (>=50k input+cacheRead tokens):");
		lines.push(`| Project | Ratio | Tokens | Cost |`);
		lines.push(`|---------|-------|--------|------|`);
		for (const s of agg.worst_cache_sessions)
			lines.push(`| ${s.project} | ${(s.ratio * 100).toFixed(1)}% | ${fmtTokens(s.tokens)} | $${s.cost.toFixed(2)} |`);
		lines.push("");
	}

	lines.push("## Tools");
	lines.push(`| Tool | Calls |`);
	lines.push(`|------|-------|`);
	for (const [tool, count] of top8(agg.tool_counts)) lines.push(`| ${tool} | ${count} |`);
	lines.push("");
	if (Object.keys(agg.tool_error_categories).length) {
		lines.push("**Failures by tool** (from `toolResult.isError`, not text matching):");
		for (const [cat, count] of top8(agg.tool_error_categories)) lines.push(`- ${cat}: ${count}`);
		lines.push("");
	}
	if (agg.tool_error_rate_table.length) {
		lines.push("**Per-tool error rate** (>=5 calls, worst first; denominator is `toolResult` messages, not `toolCounts`; `browser` includes eval calls that drive the browser global):");
		lines.push(`| Tool | Errors / Calls | Rate |`);
		lines.push(`|------|-----------------|------|`);
		for (const r of agg.tool_error_rate_table.slice(0, 10))
			lines.push(`| ${r.tool} | ${r.errors} / ${r.calls} | ${(r.rate * 100).toFixed(1)}% |`);
		lines.push("");
	}
	if (Object.keys(agg.tool_not_found).length) {
		lines.push("**Invented tool names** (the model called a tool that does not exist; every call fails, kept out of the rate table above):");
		for (const [name, count] of Object.entries(agg.tool_not_found).sort((a, b) => b[1] - a[1]))
			lines.push(`- \`${name}\`: ${count} calls, 100% failed`);
		lines.push("");
	}
	if (agg.tool_time_share.length) {
		lines.push(`**Per-tool wall clock** (\`tool_execution_start\` paired with the matching \`toolResult\` by \`toolCallId\`${agg.tool_calls_with_intent > 0 ? `; ${agg.tool_calls_with_intent} calls also carry an \`intent\` field` : ""}):`);
		lines.push(`| Tool | Calls | p50 | p90 | Share of Tool Time |`);
		lines.push(`|------|-------|-----|-----|--------------------|`);
		for (const t of agg.tool_time_share.slice(0, 10)) {
			const d = agg.tool_duration_by_tool[t.tool]!;
			lines.push(`| ${t.tool} | ${d.calls} | ${d.p50_sec.toFixed(1)}s | ${d.p90_sec.toFixed(1)}s | ${(t.share * 100).toFixed(1)}% |`);
		}
		lines.push("");
	}

	if (Object.keys(agg.languages).length) {
		lines.push("## Languages and Projects");
		lines.push(`Languages: ${top8(agg.languages).map(([l, c]) => `${l} (${c})`).join(", ")}`);
		lines.push("");
		lines.push(`| Project | Sessions |`);
		lines.push(`|---------|----------|`);
		for (const [project, count] of top8(agg.projects)) lines.push(`| ${project} | ${count} |`);
		lines.push("");
	}

	// Provenance: what the scan actually looked at, so the numbers above can
	// be reconciled against the logs rather than trusted.
	lines.push("## Corpus");
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
	if (scan.cost_unavailable) {
		lines.push("");
		lines.push(
			`_${scan.cost_unavailable} of ${scan.included} sessions carry no recorded cost in the \`${scan.source}\` logs. They contribute $0 to the totals above because this report never estimates cost from token counts; treat the spend figures as a lower bound._`,
		);
	}
	if (scan.excluded_tooling) {
		lines.push("");
		lines.push(
			`_${scan.excluded_tooling} of ${scan.included} sessions are this tool's own development work (matched against the tooling exclude list). They count in every total above - cost, tokens, active time, tool rates - but are left out of friction, worst-turn and suggestion-evidence analysis, so this tool's own build sessions never get mistaken for the user's work._`,
		);
	}
	if (scan.reused_stale_sections) {
		lines.push("");
		lines.push(
			"_The narrative sections below were generated against an earlier corpus state and reused because this run was asked not to call a model (`--no-llm`). The numbers above are current._",
		);
	}
	lines.push("");
	lines.push(`Session set and per-session cost: \`${SESSION_SET_PATH}\``);
	lines.push("");

	lines.push("## Your Setup");
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
		lines.push("## Where You Worked");
		for (const a of areas) lines.push(`- **${clean(a.name)}** (${a.session_count} sessions): ${clean(a.description)}`);
		lines.push("");
	}

	const iStyle = sections.interaction_style as
		| { narrative?: string; key_pattern?: string; blocks?: Array<{ title: string; body: string; evidence_sessions?: string[] }> }
		| undefined;
	if (iStyle?.blocks?.length) {
		lines.push("## How You Work");
		for (const b of iStyle.blocks) lines.push(`- **${clean(b.title)}**: ${clean(b.body)}`);
		if (iStyle.key_pattern) lines.push(`\n> ${clean(iStyle.key_pattern)}`);
		lines.push("");
	} else if (iStyle?.narrative) {
		lines.push("## How You Work");
		lines.push(clean(iStyle.narrative));
		if (iStyle.key_pattern) lines.push(`\n> ${clean(iStyle.key_pattern)}`);
		lines.push("");
	}

	const whatWorks = sections.what_works as { impressive_workflows?: Array<{ title: string; description: string }> } | undefined;
	if (whatWorks?.impressive_workflows?.length) {
		lines.push("## Wins");
		for (const w of whatWorks.impressive_workflows) lines.push(`- **${clean(w.title)}**: ${clean(w.description)}`);
		lines.push("");
	}

	const frictionSec = sections.friction_analysis as
		| {
				intro?: string;
				resolved?: Array<{ category: string; note: string }>;
				ongoing?: Array<{ title?: string; category: string; description: string; examples: string[] }>;
				categories?: Array<{ title?: string; category: string; description: string; examples: string[] }>;
		  }
		| undefined;
	if (frictionSec) {
		lines.push("## Where Things Broke");
		if (frictionSec.intro) lines.push(clean(frictionSec.intro));
		if (frictionSec.resolved?.length) {
			lines.push("\n**Resolved:**");
			for (const r of frictionSec.resolved) lines.push(`- ${clean(r.category)}: ${clean(r.note)}`);
		}
		const ongoing = frictionSec.ongoing ?? frictionSec.categories ?? [];
		if (ongoing.length) {
			lines.push("\n**Ongoing:**");
			for (const o of ongoing) {
				lines.push(`- **${clean(itemTitle(o.title, o.category, o.description))}**: ${clean(o.description)}`);
				for (const ex of o.examples ?? []) lines.push(`  - ${clean(ex)}`);
			}
		}
		lines.push("");
	}

	const suggSec = sections.suggestions as
		| {
				config_additions?: Array<{ title?: string; addition: string; why: string; where: string }>;
				features_to_try?: Array<{ title?: string; feature: string; why_for_you: string; example: string }>;
				usage_patterns?: Array<{ title: string; detail: string; copyable_prompt: string }>;
				stop_doing?: Array<{ title?: string; what: string; why: string; alternative: string }>;
		  }
		| undefined;
	if (suggSec) {
		lines.push("## Next Steps");
		if (suggSec.config_additions?.length) {
			lines.push("**Config additions:**");
			for (const c of suggSec.config_additions) {
				const diff = c.where.includes("config.yml") ? diffConfigAddition(userCtx.config_yml_flat, c.addition) : null;
				const body = diff ? diff.map((d) => `${d.key}: ${d.from} -> ${d.to}`).join("; ") : c.addition;
				lines.push(`- \`${c.where}\`: ${body} (${clean(c.why)})`);
			}
		}
		if (suggSec.features_to_try?.length) {
			lines.push("\n**Features to try:**");
			for (const f of suggSec.features_to_try) lines.push(`- **${clean(itemTitle(f.title, f.feature, f.why_for_you))}**: ${clean(f.why_for_you)}\n  \`\`\`\n  ${f.example}\n  \`\`\``);
		}
		if (suggSec.usage_patterns?.length) {
			lines.push("\n**Usage patterns:**");
			for (const p of suggSec.usage_patterns) lines.push(`- **${clean(p.title)}**: ${clean(p.detail)}\n  \`\`\`\n  ${p.copyable_prompt}\n  \`\`\``);
		}
		if (suggSec.stop_doing?.length) {
			lines.push("\n**Stop doing:**");
			for (const s of suggSec.stop_doing) lines.push(`- **${clean(itemTitle(s.title, s.what, s.why))}**: ${clean(s.why)}. Instead: ${clean(s.alternative)}`);
		}
		lines.push("");
	}

	const horizonSec = sections.on_the_horizon as { opportunities?: Array<{ title: string; whats_possible: string; copyable_prompt: string }> } | undefined;
	if (horizonSec?.opportunities?.length) {
		lines.push("## Future Workflows");
		for (const o of horizonSec.opportunities) lines.push(`- **${clean(o.title)}**: ${clean(o.whats_possible)}\n  \`\`\`\n  ${o.copyable_prompt}\n  \`\`\``);
		lines.push("");
	}

	lines.push("## Model Spend");
	// Claude Code's cost-state carries no per-model message count, so the
	// column reports tokens where counts are unavailable rather than "0".
	const haveMessageCounts = Object.values(agg.model_usage).some((u) => u.message_count > 0);
	lines.push(`| Model | Cost | ${haveMessageCounts ? "Messages" : "Tokens"} | List $/Mtok in / out |`);
	lines.push(`|-------|------|----------|----------------------|`);
	for (const [model, usage] of Object.entries(agg.model_usage).sort((a, b) => b[1].cost - a[1].cost).slice(0, 8)) {
		const price = usage.list_price ? `$${usage.list_price.input_per_mtok} / $${usage.list_price.output_per_mtok}` : "unknown";
		lines.push(
			`| ${model.replace(/.*\//, "")} | $${usage.cost.toFixed(2)} | ${haveMessageCounts ? usage.message_count : fmtTokens(usage.input_tokens + usage.output_tokens)} | ${price} |`,
		);
	}
	if (agg.estimated_waste > 0) lines.push(`\n**Estimated waste from model mismatch:** $${agg.estimated_waste.toFixed(2)}`);
	lines.push("");

	return lines.join("\n");
}
