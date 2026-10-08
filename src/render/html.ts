// SPDX-FileCopyrightText: 2026 Hari Srinivasan <harisrini21@gmail.com>
// SPDX-FileCopyrightText: 2026 Tobias Hoelzer (omp port)
// SPDX-License-Identifier: AGPL-3.0-only


// The self-contained HTML report: charts, stat cards and every LLM section
// rendered into one file with an embedded copy-to-clipboard script.

import { top8 } from "../aggregate.ts";
import { displayLabel } from "../stats.ts";
import { fmtCost, fmtHours, fmtTokens } from "./md.ts";
import type { AggregatedData, TemporalData, UserContext } from "../types.ts";

export const SATISFACTION_ORDER = [
	"frustrated",
	"dissatisfied",
	"likely_satisfied",
	"satisfied",
	"happy",
	"unsure",
	"neutral",
	"delighted",
];
export const OUTCOME_ORDER = [
	"not_achieved",
	"partially_achieved",
	"mostly_achieved",
	"fully_achieved",
	"unclear_from_transcript",
];

export function esc(s: unknown): string {
	return String(s ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

export function renderMarkdown(text: string): string {
	return text
		.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
		.replace(/\n\n/g, "</p><p>")
		.replace(/\n/g, "<br>")
		.replace(/^- /gm, "• ");
}

export function wrapP(text: string): string {
	return `<p>${renderMarkdown(esc(text))}</p>`;
}

export function barChart(
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

export function timeOfDayChart(hours: number[]): string {
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

export function responseTimeChart(times: number[]): string {
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

/** `n` is the sample behind the number, e.g. "n=196 sessions"; never omitted. */
export function statCard(label: string, value: string, sub: string, n: string): string {
	return `<div class="stat-card">
  <div class="stat-value">${esc(value)}</div>
  <div class="stat-label">${esc(label)}</div>
  ${sub ? `<div class="stat-sub">${esc(sub)}</div>` : ""}
  <div class="stat-sub">${esc(n)}</div>
</div>`;
}

function chartTitle(title: string, n: string): string {
	return `<h3>${esc(title)} <span style="text-transform:none;font-weight:400;color:var(--muted)">${esc(n)}</span></h3>`;
}

export function generateHTML(
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
	const nSessions = `n=${agg.total_sessions} sessions`;
	const toolCalls = Object.values(agg.tool_calls_by_tool).reduce((a, b) => a + b, 0);

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

${(temporal.diff_headlines.length || temporal.major_transition || temporal.harness_changes?.length) ? `
<div style="background:linear-gradient(135deg,#1a2332,#1e2a3a);border:1px solid var(--border2);border-radius:var(--radius);padding:24px 28px;margin-bottom:32px">
  <h3 style="color:var(--accent2);font-size:13px;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:14px">\u{1F4C8} What Changed${temporal.delta ? ` (${temporal.delta.basis === "model_switch" ? "around the model switch" : "last week vs this week"})` : ""}</h3>
  <div style="display:flex;flex-wrap:wrap;gap:10px">
    ${temporal.diff_headlines.map(h => `<div style="background:var(--bg3);border:1px solid var(--border);border-radius:var(--radius-sm);padding:8px 14px;font-size:14px;color:var(--text)">${esc(h)}</div>`).join("\n    ")}
  </div>
  ${temporal.major_transition ? `<div style="margin-top:14px;padding:10px 14px;background:var(--bg);border-radius:var(--radius-sm);border-left:3px solid var(--purple);font-size:13px;color:var(--dim)"><strong style="color:var(--purple)">Major shift (${esc(temporal.major_transition.when)}):</strong> ${esc(temporal.major_transition.what)}. Impact: ${esc(temporal.major_transition.impact)}</div>` : ""}
  ${temporal.harness_changes?.length ? `<div style="margin-top:14px;display:flex;flex-direction:column;gap:6px">
    ${temporal.harness_changes.map(c => `<div style="padding:8px 14px;background:var(--bg);border-radius:var(--radius-sm);border-left:3px solid var(--accent2);font-size:13px;color:var(--dim)"><strong style="color:var(--accent2)">Harness change (${esc(c.when.slice(0, 10))}):</strong> ${esc(c.detail)}${c.too_recent ? ` <em>(too recent to assess impact)</em>` : ""}</div>`).join("\n    ")}
  </div>` : ""}
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
    ${statCard("Sessions", String(agg.total_sessions), `${agg.days_active} active days`, nSessions)}
    ${statCard("Messages", String(agg.total_messages), `${(agg.total_messages / Math.max(agg.total_sessions, 1)).toFixed(1)} per session`, nSessions)}
    ${statCard("Active Time", fmtHours(agg.total_duration_hours), `${(agg.total_duration_hours / Math.max(Object.keys(agg.active_hours_by_day).length, 1)).toFixed(1)}h/day, parallel sessions counted once`, `n=${Object.keys(agg.active_hours_by_day).length} active days`)}
    ${statCard("Tokens In", fmtTokens(agg.total_input_tokens), "", nSessions)}
    ${statCard("Tokens Out", fmtTokens(agg.total_output_tokens), "", nSessions)}
    ${statCard("Total Cost", fmtCost(agg.total_cost), "", nSessions)}
    ${statCard("Lines Added", fmtTokens(agg.total_lines_added), "", nSessions)}
    ${statCard("Lines Removed", fmtTokens(agg.total_lines_removed), "", nSessions)}
    ${statCard("Git Commits", String(agg.git_commits), `${agg.git_pushes} pushes`, nSessions)}
    ${statCard("Files Modified", fmtTokens(agg.total_files_modified), "", nSessions)}
    ${statCard("Tool Errors", String(agg.total_tool_errors), "", `n=${toolCalls} tool calls`)}
    ${statCard("Interruptions", String(agg.total_interruptions), `aborted ${agg.interruptions_aborted} / steered ${agg.interruptions_steered}`, `n=${agg.total_messages} human messages`)}
    ${agg.sessions_using_subagent ? statCard("Subagent Sessions", String(agg.sessions_using_subagent), "", nSessions) : ""}
    ${agg.sessions_using_mcp ? statCard("MCP Sessions", String(agg.sessions_using_mcp), "", nSessions) : ""}
    ${agg.concurrent_sessions.overlap_events ? statCard("Parallel Sessions", String(agg.concurrent_sessions.overlap_events), "overlap events", nSessions) : ""}
  </div>

  <div class="charts-grid">
    <div class="chart-box">
      ${chartTitle("Goal Categories", `n=${agg.sessions_with_facets} sessions, decay-weighted`)}
      ${barChart(agg.goal_categories, { limit: 10 })}
    </div>
    <div class="chart-box">
      ${chartTitle("Outcomes", `n=${Object.values(agg.outcome_counts).reduce((a, b) => a + b, 0)} sessions, decay-weighted`)}
      ${barChart(agg.outcomes, { order: OUTCOME_ORDER })}
    </div>
    <div class="chart-box">
      ${chartTitle("Satisfaction", `n=${agg.sample_sizes.satisfaction_signals} signals, decay-weighted`)}
      ${barChart(agg.satisfaction, { order: SATISFACTION_ORDER })}
    </div>
    <div class="chart-box">
      ${chartTitle("Top Tools", `n=${Object.values(agg.tool_counts).reduce((a, b) => a + b, 0)} calls`)}
      ${barChart(agg.tool_counts, { limit: 10 })}
    </div>
    <div class="chart-box">
      ${chartTitle("Languages", `n=${Object.values(agg.languages).reduce((a, b) => a + b, 0)} file touches`)}
      ${barChart(agg.languages, { limit: 10 })}
    </div>
    <div class="chart-box">
      ${chartTitle("Friction Types", `n=${agg.sample_sizes.friction_sessions} sessions with friction, decay-weighted`)}
      ${barChart(agg.friction, { limit: 10 })}
    </div>
    <div class="chart-box">
      ${chartTitle("Tool Errors", `n=${agg.total_tool_errors} errors`)}
      ${barChart(agg.tool_error_categories)}
    </div>
    <div class="chart-box">
      ${chartTitle("Response Times", `n=${agg.user_response_times.length} responses`)}
      ${responseTimeChart(agg.user_response_times)}
    </div>
    <div class="chart-box">
      ${chartTitle("Time of Day", `n=${agg.message_hours.length} messages`)}
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
    ${statCard("Estimated Waste", fmtCost(agg.estimated_waste), "from model mismatch", `n=${agg.sessions_with_facets} sessions with facets`)}
    ${statCard("Efficiency Flags", String(agg.model_efficiency.length), `${agg.model_efficiency.filter(e => e.flag === "overspend").length} overspend, ${agg.model_efficiency.filter(e => e.flag === "underspend").length} underspend, ${agg.model_efficiency.filter(e => e.flag === "quota_pressure").length} quota pressure`, `n=${agg.sessions_with_facets} sessions with facets`)}
    ${statCard("Models Used", String(Object.keys(agg.model_usage).length), "", nSessions)}
  </div>

  <div class="charts-grid">
    <div class="chart-box">
      ${chartTitle("Cost by Model", nSessions)}
      ${barChart(Object.fromEntries(Object.entries(agg.model_usage).map(([k, v]) => [k, Math.round(v.cost * 100)])), { limit: 8 })}
      <p class="muted" style="margin-top:8px;font-size:11px">Values in cents</p>
    </div>
    <div class="chart-box">
      ${chartTitle("Messages by Model", `n=${Object.values(agg.model_usage).reduce((a, u) => a + u.message_count, 0)} model messages`)}
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
export function copyText(id) {
  const el = document.getElementById(id);
  if (!el) return;
  navigator.clipboard.writeText(el.textContent).then(() => {
    const btn = el.nextElementSibling;
    if (btn) { btn.textContent = '✅ Copied'; setTimeout(() => { btn.textContent = '📋 Copy'; }, 2000); }
  });
}
export function copyFromBox(btn) {
  const box = btn.previousElementSibling;
  if (!box) return;
  navigator.clipboard.writeText(box.textContent).then(() => {
    btn.textContent = '✅ Copied';
    setTimeout(() => { btn.textContent = '📋 Copy'; }, 2000);
  });
}
export function copyAllConfig() {
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
