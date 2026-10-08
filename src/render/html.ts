// SPDX-FileCopyrightText: 2026 Hari Srinivasan <harisrini21@gmail.com>
// SPDX-FileCopyrightText: 2026 Tobias Hoelzer (omp port)
// SPDX-License-Identifier: AGPL-3.0-only


// The self-contained HTML report: charts, stat cards and every LLM section
// rendered into one file with an embedded copy-to-clipboard script.

import { top8 } from "../aggregate.ts";
import { displayLabel } from "../stats.ts";
import { fmtCost, fmtHours, fmtTokens } from "./md.ts";
import { buildActionList, type ActionItem } from "./actions.ts";
import { buildEvidenceLinks } from "./evidence.ts";
import { diffReports, type ReportDiffEntry } from "./reportDiff.ts";
import { diffConfigAddition } from "./configDiff.ts";
import { type CopyKind, configAdditionTitle, copyKindForWhere, copyLabel, copyTooltip, isFillerText, itemTitle, stripEmoji } from "./text.ts";
import type { AggregatedData, TemporalData, UserContext } from "../types.ts";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { AGENT_DIR } from "../cache.ts";

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

/** Every rendered string funnels through here: HTML-escaped and stripped
 * of emoji/pictograph codepoints, so a model emitting a decorative icon
 * in a title or description can't reintroduce what the redesign removed
 * from the surrounding chrome. */
export function esc(s: unknown): string {
	return stripEmoji(String(s ?? ""))
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
	opts: { order?: string[]; limit?: number; pillClass?: string; idPrefix?: string } = {},
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
			const label = esc(displayLabel(key));
			const id = opts.idPrefix ? ` id="${opts.idPrefix}${categorySlug(key)}"` : "";
			return `<div class="bar-row"${id}>
  <div class="bar-label"${opts.pillClass ? ` title="${label}"` : ""}>${opts.pillClass ? `<span class="category-pill ${opts.pillClass}">${label}</span>` : label}</div>
  <div class="bar-track"><div class="bar-fill" style="width:${pct.toFixed(1)}%"></div></div>
  <div class="bar-count">${Math.round(val)}</div>
</div>`;
		})
		.join("\n");
}

/** Shared key for a category across the chart (snake_case keys) and the
 * cards (display labels): "agent_too_slow" and "Agent Too Slow" both map
 * to "agent-too-slow", so a card pill can link to its chart row. */
export function categorySlug(key: string): string {
	return displayLabel(key).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
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
		"2-10s": 0,
		"10-30s": 0,
		"30s-1m": 0,
		"1-2m": 0,
		"2-5m": 0,
		"5-15m": 0,
		">15m": 0,
	};
	for (const t of times) {
		if (t < 10) buckets["2-10s"]!++;
		else if (t < 30) buckets["10-30s"]!++;
		else if (t < 60) buckets["30s-1m"]!++;
		else if (t < 120) buckets["1-2m"]!++;
		else if (t < 300) buckets["2-5m"]!++;
		else if (t < 900) buckets["5-15m"]!++;
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

/**
 * `n` is the sample behind the number, e.g. "n=196 sessions"; never omitted.
 * `title` is the full hover evidence string (definition, n, window); every
 * caller must supply one so every card is traceable, not just the ones with
 * a matching Fact id.
 */
export function statCard(label: string, value: string, sub: string, n: string, title: string): string {
	return `<div class="stat-card" title="${esc(title)}">
  <div class="stat-value">${esc(value)}</div>
  <div class="stat-label">${esc(label)}</div>
  ${sub ? `<div class="stat-sub">${esc(sub)}</div>` : ""}
  <div class="stat-sub">${esc(n)}</div>
</div>`;
}

function chartTitle(title: string, n: string): string {
	return `<h3>${esc(title)} <span style="text-transform:none;font-weight:400;color:var(--muted)">${esc(n)}</span></h3>`;
}

// Why: an outgoing-arrow icon, not a plain file glyph, so it reads as "opens elsewhere".
const OPEN_ICON = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>`;

// Why: a document glyph in front of the name marks it as a file, not a button or a tag.
const FILE_ICON = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>`;

/** Evidence row's link to the session log on disk, full path as the hover title. */
function fileIconLink(href: string, path: string): string {
	return `<a class="file-icon-link" href="${esc(href)}" target="_blank" title="Open session log: ${esc(path)}" aria-label="Open session log">log ${OPEN_ICON}</a>`;
}

/** Absolute on-disk path for a suggestion's `where`, or null when it cannot be
 * pinned down. `~/` and absolute paths resolve directly; a bare file name
 * (e.g. "AGENTS.md") resolves against the omp agent dir only if it exists
 * there. Why: a link to a guessed path that does not exist is worse than none. */
export function resolveTargetPath(where: string, agentDir: string = AGENT_DIR, home: string = homedir()): string | null {
	const w = where.trim();
	const p = w.startsWith("~/") ? join(home, w.slice(2)) : isAbsolute(w) ? w : !w.includes("/") ? join(agentDir, w) : null;
	return p && existsSync(p) ? p : null;
}

function targetChip(where: string): string {
	const path = resolveTargetPath(where);
	return path
		? `<a class="file-target file-target-link" href="file://${esc(path)}" target="_blank" title="Open ${esc(path)}">${FILE_ICON}<span>${esc(where)}</span>${OPEN_ICON}</a>`
		: `<span class="file-target" title="File name only: which ${esc(where)} depends on the project, so it is not linked">${FILE_ICON}<span>${esc(where)}</span></span>`;
}

/** Evidence line: an `omp -r <id>` replay command, a copy button, then a
 * file icon linking to the session log (only when its path is known; an
 * id with no known path is dropped, not linked to a dead href). */
function evidenceHtmlFor(ids: unknown, sessionPaths: Record<string, string>): string {
	const links = buildEvidenceLinks(ids, sessionPaths);
	if (!links.length) return "";
	// Why: one session per row; inline comma-separated rows wrapped mid-command and read as noise.
	return `<div class="evidence"><span class="meta-label">EVIDENCE</span>${links
		.map((l) => {
			const cmd = `omp -r ${l.id}`;
			return `<div class="evidence-link"><code class="evidence-cmd">${esc(cmd)}</code> <button class="copy-btn tiny" onclick="copyFromBox(this)" title="${esc(copyTooltip(cmd))}">${copyLabel("command")}</button> ${fileIconLink(l.href, l.path)}</div>`;
		})
		.join("")}</div>`;
}

/** Shared card for every advice item (Top Actions, config additions,
 * features to try, usage patterns, stop-doing, ongoing friction): a
 * semibold title, an optional muted reason line, an optional accent
 * "Instead"/"Do" line, the full copyable text in a collapsible mono
 * block, and a labeled meta row. A 3px left border colors the item by
 * type. Filler placeholder text ("See X for details.") is dropped rather
 * than rendered. */
function adviceCard(opts: {
	borderColor: string;
	title: string;
	reason?: string;
	instead?: { label: string; text: string };
	copyable?: { text: string; kind: CopyKind };
	where?: string;
	evidenceSessions?: unknown;
	sessionPaths: Record<string, string>;
}): string {
	const reason = opts.reason && !isFillerText(opts.reason) ? `<p class="advice-reason">${esc(opts.reason)}</p>` : "";
	const instead = opts.instead && !isFillerText(opts.instead.text)
		? `<p class="advice-instead"><strong>${esc(opts.instead.label)}:</strong> ${esc(opts.instead.text)}</p>`
		: "";
	let copyBlock = "";
	if (opts.copyable) {
		const { text, kind } = opts.copyable;
		// Why: copyable text is always shown; a "Show text" toggle added a click for no gain.
		copyBlock = `<div class="copy-box">${esc(text)}</div><button class="copy-btn" onclick="copyFromBox(this)" title="${esc(copyTooltip(text))}">${copyLabel(kind)}</button>`;
	}
	const meta = opts.where
		? `<div class="meta-row"><span class="meta-label">APPLIES TO</span> ${targetChip(opts.where)}</div>`
		: "";
	return `<div class="advice-card" style="border-left-color:${opts.borderColor}">
      <h3 class="advice-title">${esc(opts.title)}</h3>
      ${reason}
      ${instead}
      ${copyBlock}
      ${meta}
      ${evidenceHtmlFor(opts.evidenceSessions, opts.sessionPaths)}
    </div>`;
}

export function generateHTML(
	agg: AggregatedData,
	sections: Record<string, unknown>,
	synthesis: Record<string, string>,
	temporal: TemporalData,
	opts: { prevSections?: Record<string, unknown>; sessionPaths?: Record<string, string>; userCtx?: UserContext } = {},
): string {
	const sessionPaths = opts.sessionPaths ?? {};
	const liveConfig = opts.userCtx?.config_yml_flat ?? {};
	// Friction-type pill for a card; links to its row in the Friction Types chart when that row is shown.
	// Why: same top-10 cut as the chart below, so no pill links to a row that is not rendered.
	const FRICTION_CHART_LIMIT = 10;
	const chartedFriction = new Set(Object.entries(agg.friction).sort((a, b) => b[1] - a[1]).slice(0, FRICTION_CHART_LIMIT).map(([k]) => categorySlug(k)));
	const frictionPill = (category: string): string => {
		const slug = categorySlug(category);
		return chartedFriction.has(slug)
			? `<a class="category-pill friction" href="#friction-type-${slug}" title="See this friction type in By the Numbers">${esc(category)}</a>`
			: `<span class="category-pill friction">${esc(category)}</span>`;
	};
	const evidenceHtml = (ids: unknown): string => evidenceHtmlFor(ids, sessionPaths);
	/** D18: a config.yml-targeted addition that parses as YAML renders as an
	 * old -> new key diff instead of the raw addition text. */
	const configAdditionHtml = (c: { addition: string; where: string }): string => {
		if (c.where.includes("config.yml")) {
			const diff = diffConfigAddition(liveConfig, c.addition);
			if (diff) {
				return `<div class="config-diff">${diff
					.map((d) => `<div class="config-diff-row"><code>${esc(d.key)}</code>: <span class="config-diff-old">${esc(d.from)}</span> \u2192 <span class="config-diff-new">${esc(d.to)}</span></div>`)
					.join("\n")}</div>`;
			}
		}
		return "";
	};
	const reportDiff: ReportDiffEntry[] = opts.prevSections ? diffReports(opts.prevSections, sections) : [];
	const diffStatus = (category: string): ReportDiffEntry["status"] | undefined =>
		reportDiff.find((d) => d.category === category)?.status;
	const diffBadge = (category: string): string => {
		const status = diffStatus(category);
		if (!status || status === "persisting") return "";
		return ` <span class="badge ${status === "new" ? "red" : "green"}">${status}</span>`;
	};
	const resolvedSinceLastRun = reportDiff.filter((d) => d.status === "resolved");

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
		| {
				narrative?: string;
				key_pattern?: string;
				blocks?: Array<{ title: string; body: string; evidence_sessions?: string[] }>;
		  }
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
				categories?: Array<{ title?: string; category: string; description: string; examples: string[]; severity?: string; evidence_sessions?: string[] }>;
				resolved?: Array<{ category: string; note: string }>;
				ongoing?: Array<{ title?: string; category: string; description: string; examples: string[]; severity?: string; evidence_sessions?: string[] }>;
		  }
		| undefined;
	const suggSec = sections.suggestions as
		| {
				config_additions?: Array<{ title?: string; addition: string; why: string; where: string; evidence_sessions?: string[] }>;
				features_to_try?: Array<{ title?: string; feature: string; one_liner: string; why_for_you: string; example: string; evidence_sessions?: string[] }>;
				usage_patterns?: Array<{ title: string; suggestion: string; detail: string; copyable_prompt: string; evidence_sessions?: string[] }>;
				stop_doing?: Array<{ title?: string; what: string; why: string; alternative: string; evidence_sessions?: string[] }>;
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

	const modelEffSec = sections.model_efficiency as
		| { summary?: string; overspend_pattern?: string; underspend_pattern?: string; quota_pressure?: string; recommendation?: string; potential_savings_note?: string }
		| undefined;

	const topTools = top8(agg.tool_counts);
	const topGoals = top8(agg.goal_categories);
	const nSessions = `n=${agg.total_sessions} sessions`;
	const toolCalls = Object.values(agg.tool_calls_by_tool).reduce((a, b) => a + b, 0);
	const windowStr = `${agg.date_range.start}..${agg.date_range.end}`;
	const cardTitle = (definition: string, n: string) => `${definition} (${n}, ${windowStr})`;

	const configAdditions = suggSec?.config_additions ?? [];
	const featuresToTry = suggSec?.features_to_try ?? [];
	const usagePatterns = suggSec?.usage_patterns ?? [];

	const actionItems: ActionItem[] = buildActionList(sections);
	const actionListHtml = actionItems.length
		? `<div class="card" id="action-list">
  <h3 style="margin-bottom:12px">Top Actions</h3>
  <ol class="action-list">
  ${actionItems
			.map((item) => {
				const borderColor = item.source === "stop_doing" ? "var(--red)" : item.source === "usage_patterns" ? "var(--accent)" : "var(--green)";
				return `<li class="action-item">${adviceCard({
					borderColor,
					title: item.title,
					reason: item.reason,
					instead: item.instead,
					copyable: item.copyable,
					where: item.where,
					evidenceSessions: item.evidence_sessions,
					sessionPaths,
				})}</li>`;
			})
			.join("\n  ")}
  </ol>
</div>`
		: "";

	// Since-last-report delta, folded into the Summary card instead of a
	// standalone section: temporal diff headlines, the one major transition
	// and harness-level changes, one bullet each (capped at 6), only shown when any
	// of the three actually produced something.
	const sinceLastReportLines: string[] = [];
	// Why: one change per bullet; joined with separators the deltas ran together into one dense line.
	if (temporal.diff_headlines.length) sinceLastReportLines.push(...temporal.diff_headlines);
	if (temporal.major_transition) sinceLastReportLines.push(`Major shift (${temporal.major_transition.when}): ${temporal.major_transition.what}. Impact: ${temporal.major_transition.impact}`);
	for (const c of temporal.harness_changes ?? []) sinceLastReportLines.push(`Setup: ${c.detail}`);
	const sinceLastReportHtml = sinceLastReportLines.length
		? `<div class="at-a-glance-part since-last-report">
      <h3>Since Last Report${temporal.delta ? ` <span style="text-transform:none;font-weight:400">(${temporal.delta.basis === "model_switch" ? "around the model switch" : "last week vs this week"})</span>` : ""}</h3>
      <ul class="since-list">${sinceLastReportLines.slice(0, 6).map((l) => `<li>${esc(l)}</li>`).join("")}</ul>
    </div>`
		: "";

	const costByProvider = agg.cost_by_provider ?? [];
	const providerAuthLabel = (auth: string): string =>
		auth === "subscription" ? "subscription (list-price equivalent, not billed)" : auth === "api_key" ? "billed" : "unknown";
	const costByProviderHtml = costByProvider.length
		? `<div class="card" style="margin-bottom:20px">
    <h3 style="margin-bottom:10px">Cost by Provider</h3>
    <table class="cost-table">
      <thead><tr><th>Provider</th><th>Cost</th><th>Basis</th></tr></thead>
      <tbody>
        ${costByProvider.map((p) => `<tr><td>${esc(p.provider)}</td><td>${esc(fmtCost(p.cost))}</td><td>${esc(providerAuthLabel(p.auth))}</td></tr>`).join("\n        ")}
      </tbody>
    </table>
  </div>`
		: "";
	const costLabel = agg.subscription_cost > 0 ? "API-equivalent Cost" : "Total Cost";
	// Why: unknown-basis cost (e.g. an API key in an env var omp never stored) may well be billed; hiding it behind "billed: $0" understates real spend.
	const unknownCost = agg.total_cost - agg.billed_cost - agg.subscription_cost;
	const costSub = agg.subscription_cost > 0
		? `billed: ${fmtCost(agg.billed_cost)}${unknownCost >= 0.01 ? ` · unknown basis: ${fmtCost(unknownCost)}` : ""}`
		: "";
	const costTitle = agg.subscription_cost > 0
		? cardTitle("sum of recorded cost (primary + advisor + subagent); omp's list-price equivalent for every call, including ones paid via a subscription rather than billed per-token", nSessions)
		: cardTitle("sum of recorded cost (primary + advisor + subagent)", nSessions);

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>omp Insights - ${esc(agg.date_range.start)} to ${esc(agg.date_range.end)}</title>
<style>
  :root {
    --bg: #faf8f4; --bg2: #ffffff; --bg3: #f3f1ec;
    --border: #e4e7eb; --border2: #d3d8de;
    --text: #1f2933; --dim: #3e4c59; --muted: #616e7c;
    --accent: #2f6f9e; --accent2: #0f6e8c;
    --green: #2f7a4f; --yellow: #a9790a; --red: #b84b43;
    --purple: #5d5fa0; --teal: #0f6e8c;
    --radius: 10px; --radius-sm: 6px;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 15px; font-weight: 400; line-height: 1.6; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  strong { font-weight: 600; }

  .container { max-width: 1040px; margin: 0 auto; padding: 40px 24px 80px; }
  header { text-align: center; padding: 40px 0 32px; border-bottom: 1px solid var(--border); margin-bottom: 40px; }
  header h1 { font-size: 28px; font-weight: 600; color: var(--text); letter-spacing: -0.3px; }
  header .subtitle { color: var(--muted); margin-top: 8px; font-size: 13px; }

  nav { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; margin-bottom: 40px; }
  nav a { background: var(--bg3); border: 1px solid var(--border); padding: 6px 14px; border-radius: 20px; color: var(--dim); font-size: 13px; transition: all 0.15s; }
  nav a:hover { color: var(--text); border-color: var(--border2); text-decoration: none; background: var(--bg2); }

  .rpt-section { margin-bottom: 48px; display: block; }
  h2 { font-size: 20px; font-weight: 600; color: var(--text); margin-bottom: 24px; padding-bottom: 12px; border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 10px; }
  /* Category pills: the same pill marks a friction type in the chart and on
     the friction cards, so a card visibly belongs to a chart row. */
  .category-pill { display: inline-block; padding: 1px 9px; border-radius: 999px; font-size: 12px; font-weight: 500; line-height: 1.6; white-space: nowrap; text-transform: none; letter-spacing: 0; }
  .category-pill.friction { background: #fdf3e1; color: #8a5a12; border: 1px solid #f0d9ae; }
  a.category-pill { text-decoration: none; }
  a.category-pill:hover { border-color: #d9a94f; }
  .bar-row:target .category-pill { box-shadow: 0 0 0 2px #f0d9ae; }
  /* Why: a pill label must shrink with an ellipsis inside its rounded border, not get clipped mid-pill. */
  .bar-label .category-pill { max-width: 100%; overflow: hidden; text-overflow: ellipsis; vertical-align: middle; }
  .bar-row:has(.category-pill) .bar-label { width: 190px; }
  h3 { font-size: 15px; font-weight: 600; color: var(--text); margin-bottom: 10px; }

  .evidence { margin-top: 8px; font-size: 11px; color: var(--muted); display: flex; flex-direction: column; gap: 4px; }
  .evidence-link { display: flex; align-items: center; gap: 6px; }
  .evidence-cmd { background: var(--bg3); border: 1px solid var(--border); border-radius: 4px; padding: 1px 6px; font-family: 'SF Mono', 'Fira Code', monospace; color: var(--accent2); font-size: 11px; }
  .file-icon-link { color: var(--accent); display: inline-flex; align-items: center; gap: 3px; font-size: 11px; text-decoration: none; }
  .file-icon-link:hover { color: var(--accent2); text-decoration: underline; }
  .config-diff { font-family: 'SF Mono', 'Fira Code', monospace; font-size: 13px; }
  .config-diff-row { margin-top: 4px; color: var(--text); }
  .config-diff-row code { color: var(--accent2); }
  .config-diff-old { color: var(--red); text-decoration: line-through; }
  .config-diff-new { color: var(--green); }

  .card { background: var(--bg2); border: 1px solid var(--border); border-radius: var(--radius); padding: 20px 24px; }
  .card + .card { margin-top: 12px; }
  .card-grid { display: grid; gap: 12px; }
  .card-grid.cols2 { grid-template-columns: repeat(2, 1fr); }
  .card-grid.cols3 { grid-template-columns: repeat(3, 1fr); }

  .stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; margin-bottom: 24px; }
  .stat-card { background: var(--bg2); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px 18px; text-align: center; }
  .stat-value { font-size: 24px; font-weight: 600; color: var(--accent); }
  .stat-label { font-size: 12px; color: var(--muted); margin-top: 4px; text-transform: uppercase; letter-spacing: 0.5px; }
  .stat-sub { font-size: 12px; color: var(--muted); margin-top: 2px; }

  .bar-row { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; font-size: 14px; }
  .bar-row.compact { margin-bottom: 2px; }
  .bar-label { width: 140px; flex-shrink: 0; color: var(--dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .bar-track { flex: 1; height: 10px; background: var(--bg3); border: 1px solid var(--border); border-radius: 5px; overflow: hidden; }
  .bar-fill { height: 100%; background: var(--accent); border-radius: 5px; transition: width 0.4s ease; }
  .bar-count { width: 40px; text-align: right; color: var(--muted); flex-shrink: 0; }

  .charts-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 20px; }
  .chart-box { background: var(--bg2); border: 1px solid var(--border); border-radius: var(--radius); padding: 18px 20px; }
  .chart-box h3 { font-size: 13px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 14px; }

  .at-a-glance { background: var(--bg2); border: 1px solid var(--border2); border-radius: var(--radius); overflow: hidden; }
  .at-a-glance-part { padding: 20px 24px; border-bottom: 1px solid var(--border); }
  .at-a-glance-part:last-child { border-bottom: none; }
  .at-a-glance-part h3 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.8px; color: var(--accent); margin-bottom: 10px; }
  .at-a-glance-part p { color: var(--text); line-height: 1.6; }
  .at-a-glance-part.since-last-report { background: var(--bg3); }
  .at-a-glance-part.since-last-report h3 { color: var(--accent2); }
  .since-list { margin: 0; padding-left: 18px; color: var(--text); line-height: 1.6; }
  .since-list li + li { margin-top: 4px; }

  .area-card { background: var(--bg2); border: 1px solid var(--border); border-radius: var(--radius); padding: 18px 20px; }
  .area-card h3 { color: var(--text); font-size: 15px; }
  .area-card .count { color: var(--muted); font-size: 12px; margin-left: 8px; }
  .area-card p { color: var(--muted); margin-top: 8px; font-size: 14px; }

  .workflow-card { background: var(--bg2); border: 1px solid var(--border); border-radius: var(--radius); padding: 18px 20px; }
  .workflow-card h3 { color: var(--text); font-size: 15px; }
  .workflow-card p { color: var(--muted); margin-top: 8px; font-size: 14px; }

  .style-block-card { background: var(--bg2); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px 18px; }
  .style-block-card h3 { color: var(--text); font-size: 15px; }
  .style-block-card p { color: var(--muted); margin-top: 6px; font-size: 14px; }

  .friction-card { background: var(--bg2); border: 1px solid var(--border); border-radius: var(--radius); padding: 18px 20px; }
  .friction-card h3 { color: var(--text); font-size: 15px; }
  .friction-card p { color: var(--muted); margin-top: 8px; font-size: 14px; }
  .friction-card .examples { margin-top: 10px; }
  .friction-card .example { font-size: 13px; color: var(--muted); padding: 4px 0 4px 14px; border-left: 2px solid var(--border2); margin-top: 6px; }

  /* Advice cards: the one layout shared by Top Actions, config
     additions, features to try, usage patterns, stop-doing and ongoing
     friction, colored by type with a thin left border. */
  .advice-card { background: var(--bg2); border: 1px solid var(--border); border-left: 3px solid var(--accent); border-radius: var(--radius); padding: 16px 20px; }
  .advice-title { font-size: 15px; font-weight: 600; color: var(--text); margin-bottom: 0; }
  .advice-reason { color: var(--muted); font-size: 13px; margin-top: 6px; }
  .advice-instead { color: var(--accent); font-size: 13px; margin-top: 6px; }
  .advice-instead strong { color: var(--text); }

  .action-list { list-style: decimal; padding-left: 22px; }
  .action-item { margin-bottom: 14px; }
  .action-item::marker { color: var(--muted); }
  .action-item:last-child { margin-bottom: 0; }
  .action-item .advice-card { padding: 14px 18px; }

  .meta-row { margin-top: 10px; font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; display: flex; align-items: center; gap: 6px; }
  .meta-chip { text-transform: none; letter-spacing: 0; background: var(--bg3); border: 1px solid var(--border); border-radius: 4px; padding: 1px 6px; font-family: 'SF Mono', 'Fira Code', monospace; color: var(--text); font-size: 12px; }
  .file-target { display: inline-flex; align-items: center; gap: 5px; text-transform: none; letter-spacing: 0; font-family: 'SF Mono', 'Fira Code', monospace; font-size: 12px; color: var(--dim); }
  .file-target svg { color: var(--muted); flex-shrink: 0; }
  a.file-target-link { color: var(--accent); text-decoration: none; }
  a.file-target-link svg { color: currentColor; }
  a.file-target-link:hover span { text-decoration: underline; }

  .cost-table { width: 100%; border-collapse: collapse; font-size: 13px; }
  .cost-table th, .cost-table td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--border); }
  .cost-table th { color: var(--muted); font-weight: 600; text-transform: uppercase; font-size: 11px; letter-spacing: 0.4px; }

  .copy-box { background: var(--bg3); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 12px 14px; font-family: 'SF Mono', 'Fira Code', monospace; font-size: 12px; color: var(--teal); white-space: pre-wrap; overflow-wrap: anywhere; margin-top: 10px; }
  /* Why: buttons are the only interactive controls in a card; an accent tint separates them from the grey chips and code blocks around them. */
  .copy-btn { display: inline-flex; align-items: center; gap: 6px; background: #e8f0fa; border: 1px solid #b9cde6; color: #1f4f8a; font-family: inherit; font-weight: 500; font-size: 12px; padding: 5px 12px; border-radius: var(--radius-sm); cursor: pointer; margin-top: 8px; transition: all 0.15s; }
  .copy-btn:hover { background: #d6e5f6; border-color: #8fb0d8; color: #163d6d; }
  .copy-btn.tiny { padding: 2px 8px; margin-top: 0; font-size: 11px; }
  .copy-all-btn { background: var(--accent); color: #fff; font-weight: 600; border: none; padding: 8px 18px; border-radius: var(--radius-sm); cursor: pointer; font-size: 13px; margin-top: 16px; transition: opacity 0.15s; }
  .copy-all-btn:hover { opacity: 0.85; }

  .horizon-card { background: var(--bg2); border: 1px solid var(--border); border-radius: var(--radius); padding: 20px 24px; }
  .horizon-card h3 { color: var(--text); font-size: 15px; }
  .horizon-card p { color: var(--muted); margin-top: 8px; font-size: 14px; }
  .horizon-card .how { color: var(--muted); font-size: 13px; margin-top: 8px; }

  .muted { color: var(--muted); font-size: 14px; }
  .badge { display: inline-block; font-size: 11px; padding: 2px 8px; border-radius: 4px; font-weight: 600; }
  .badge.green { background: rgba(47,122,79,0.12); color: var(--green); }
  .badge.yellow { background: rgba(169,121,10,0.12); color: var(--yellow); }
  .badge.red { background: rgba(184,75,67,0.12); color: var(--red); }

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
  <h1>omp Insights</h1>
  <div class="subtitle">
    ${esc(agg.date_range.start)} - ${esc(agg.date_range.end)}
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

${actionListHtml}

<!-- ── At a Glance ── -->
<section class="rpt-section" id="at-a-glance">
<h2>Summary</h2>
  <div class="at-a-glance">
    ${sinceLastReportHtml}
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
<section class="rpt-section" id="stats">
<h2>By the Numbers</h2>
  <div class="stat-grid">
    ${statCard("Sessions", String(agg.total_sessions), `${agg.days_active} active days`, nSessions, cardTitle("substantive sessions in the report", nSessions))}
    ${statCard("Messages", String(agg.total_messages), `${(agg.total_messages / Math.max(agg.total_sessions, 1)).toFixed(1)} per session`, nSessions, cardTitle("human messages across all sessions", nSessions))}
    ${statCard("Active Time", fmtHours(agg.total_duration_hours), `${(agg.total_duration_hours / Math.max(Object.keys(agg.active_hours_by_day).length, 1)).toFixed(1)}h/day, parallel sessions counted once`, `n=${Object.keys(agg.active_hours_by_day).length} active days`, cardTitle("union of session intervals per day; parallel sessions counted once", `n=${Object.keys(agg.active_hours_by_day).length} active days`))}
    ${statCard("Tokens In", fmtTokens(agg.total_input_tokens), "", nSessions, cardTitle("total input tokens recorded across all model calls", nSessions))}
    ${statCard("Tokens Out", fmtTokens(agg.total_output_tokens), "", nSessions, cardTitle("total output tokens recorded across all model calls", nSessions))}
    ${statCard(costLabel, fmtCost(agg.total_cost), costSub, nSessions, costTitle)}
    ${statCard("Lines Added", fmtTokens(agg.total_lines_added), "", nSessions, cardTitle("lines added across all file edits", nSessions))}
    ${statCard("Lines Removed", fmtTokens(agg.total_lines_removed), "", nSessions, cardTitle("lines removed across all file edits", nSessions))}
    ${statCard("Git Commits", String(agg.git_commits), `${agg.git_pushes} pushes`, nSessions, cardTitle("git commit tool calls across sessions", nSessions))}
    ${statCard("Files Modified", fmtTokens(agg.total_files_modified), "", nSessions, cardTitle("distinct file-edit operations across sessions", nSessions))}
    ${statCard("Tool Errors", String(agg.total_tool_errors), "", `n=${toolCalls} tool calls`, cardTitle("tool results with isError", `n=${toolCalls} tool calls`))}
    ${statCard("Interruptions", String(agg.total_interruptions), `aborted ${agg.interruptions_aborted} / steered ${agg.interruptions_steered}`, `n=${agg.total_messages} human messages`, cardTitle("mid-session aborts + steering messages", `n=${agg.total_messages} human messages`))}
    ${agg.sessions_using_subagent ? statCard("Subagent Sessions", String(agg.sessions_using_subagent), "", nSessions, cardTitle("sessions that spawned at least one subagent", nSessions)) : ""}
    ${agg.sessions_using_mcp ? statCard("MCP Sessions", String(agg.sessions_using_mcp), "", nSessions, cardTitle("sessions that used an MCP tool", nSessions)) : ""}
    ${agg.concurrent_sessions.overlap_events ? statCard("Parallel Sessions", String(agg.concurrent_sessions.overlap_events), "overlap events", nSessions, cardTitle("overlap events between interleaved sessions", nSessions)) : ""}
  </div>

  ${costByProviderHtml}

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
      ${chartTitle("Friction Types", `n=${agg.sample_sizes.friction_sessions} sessions with friction, decay-weighted`)}
      ${barChart(agg.friction, { limit: FRICTION_CHART_LIMIT, pillClass: "friction", idPrefix: "friction-type-" })}
    </div>
    <div class="chart-box">
      ${chartTitle("Tool Errors", `n=${agg.total_tool_errors} errors`)}
      ${barChart(agg.tool_error_categories)}
    </div>
  </div>

  <div id="numbers">
  <h3 style="margin-top:28px">Languages, time of day, response times</h3>
  <div class="charts-grid" style="margin-top:12px">
    <div class="chart-box">
      ${chartTitle("Languages", `n=${Object.values(agg.languages).reduce((a, b) => a + b, 0)} file touches`)}
      ${barChart(agg.languages, { limit: 10 })}
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
  </div>
</section>

<!-- ── Project Areas ── -->
<section class="rpt-section" id="projects">
<h2>Where You Worked</h2>
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
<section class="rpt-section" id="style">
<h2>How You Work</h2>
  <div class="card">
    ${
			iStyle?.blocks?.length
				? `<div class="card-grid ${iStyle.blocks.length > 1 ? "cols2" : ""}">
      ${iStyle.blocks
				.map(
					(b) => `<div class="style-block-card">
        <h3>${esc(b.title)}</h3>
        <p>${esc(b.body)}</p>
        ${evidenceHtml(b.evidence_sessions)}
      </div>`,
				)
				.join("\n")}
    </div>`
				: iStyle?.narrative
					? `<div style="line-height:1.6">${renderMarkdown(esc(iStyle.narrative))}</div>`
					: "<p class='muted'>No data</p>"
		}
    ${iStyle?.key_pattern ? `<div style="margin-top:16px;padding:14px 16px;background:var(--bg3);border-radius:var(--radius-sm);border:1px solid var(--border2);color:var(--accent2);font-size:14px;font-style:italic">"${esc(iStyle.key_pattern)}"</div>` : ""}
  </div>
</section>

<!-- ── What's Working ── -->
<section class="rpt-section" id="what-works">
<h2>Wins</h2>
  ${whatWorks?.intro ? `<p style="color:var(--muted);margin-bottom:16px">${esc(whatWorks.intro)}</p>` : ""}
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
<section class="rpt-section" id="friction">
<h2>Where Things Broke</h2>
  ${frictionSec?.intro ? `<p style="color:var(--muted);margin-bottom:16px">${esc(frictionSec.intro)}</p>` : ""}
  ${(frictionSec?.resolved?.length || resolvedSinceLastRun.length) ? `<div style="margin-bottom:20px">
    <h3 style="color:var(--green);font-size:13px;margin-bottom:10px">Resolved</h3>
    ${(frictionSec?.resolved ?? []).map(r => `<div style="padding:6px 14px;color:var(--muted);font-size:13px;border-left:2px solid var(--green);margin-bottom:6px">${frictionPill(r.category)} ${esc(r.note)}</div>`).join("\n")}
    ${resolvedSinceLastRun.filter(d => !(frictionSec?.resolved ?? []).some(r => r.category === d.category)).map(d => `<div style="padding:6px 14px;color:var(--muted);font-size:13px;border-left:2px solid var(--green);margin-bottom:6px">${frictionPill(d.category)} not in this run's friction list anymore</div>`).join("\n")}
  </div>` : ""}
  <div class="card-grid ${((frictionSec?.ongoing ?? frictionSec?.categories)?.length ?? 0) > 1 ? "cols2" : ""}">
    ${((frictionSec?.ongoing ?? frictionSec?.categories) ?? [])
			.map((cat) => {
				const title = itemTitle(cat.title, cat.category, cat.description);
				const examples = (cat.examples ?? []).map((ex) => `<div class="example">${esc(ex)}</div>`).join("");
				return `<div class="friction-card" style="border-left:3px solid var(--yellow)">
      <h3>${esc(title)}${cat.severity ? ` <span class="badge ${cat.severity === "high" ? "red" : cat.severity === "medium" ? "yellow" : "green"}">${cat.severity}</span>` : ""}${diffBadge(cat.category)}</h3>
      ${isFillerText(cat.description) ? "" : `<p>${esc(cat.description)}</p>`}
      <div class="examples">${examples}</div>
      <div class="meta-row"><span class="meta-label">FRICTION TYPE</span> ${frictionPill(cat.category)}</div>
      ${evidenceHtml(cat.evidence_sessions)}
    </div>`;
			})
			.join("\n")}
  </div>
</section>

<!-- ── Suggestions ── -->
<section class="rpt-section" id="suggestions">
<h2>Next Steps</h2>

  ${
		configAdditions.length
			? `<h3 style="margin-bottom:12px">Config Additions</h3>
  <p style="color:var(--muted);font-size:13px;margin-bottom:16px">Select the ones you want, then copy them all at once.</p>
  <div id="config-list">
    ${configAdditions
			.map((c, i) => {
				const title = configAdditionTitle(c);
				const diffHtml = configAdditionHtml(c);
				const kind = copyKindForWhere(c.where);
				const copyBlock = `<div class="copy-box">${esc(c.addition)}</div><button class="copy-btn" onclick="copyFromBox(this)" title="${esc(copyTooltip(c.addition))}">${copyLabel(kind)}</button>`;
				return `<div class="advice-card" id="cfg-${i}" style="margin-bottom:10px;border-left-color:var(--accent)">
      <div style="display:flex;align-items:flex-start;gap:10px">
        <input type="checkbox" id="cfg-check-${i}" class="cfg-check" checked data-addition="${esc(c.addition)}" data-where="${esc(c.where)}" aria-label="Include in the copied block" style="margin-top:3px;accent-color:var(--accent);width:15px;height:15px;flex-shrink:0;cursor:pointer">
        <div style="flex:1">
          <label for="cfg-check-${i}" style="cursor:pointer"><h3 class="advice-title">${esc(title)}</h3></label>
          ${diffHtml}
          ${isFillerText(c.why) ? "" : `<p class="advice-reason">${esc(c.why)}</p>`}
          ${copyBlock}
          <div class="meta-row"><span class="meta-label">APPLIES TO</span> ${targetChip(c.where)}</div>
          ${evidenceHtml(c.evidence_sessions)}
        </div>
      </div>
    </div>`;
			})
			.join("\n")}
  </div>
  <button class="copy-all-btn" onclick="copyAllConfig()" title="Collect the checked additions into one block below, ready to copy">Copy Selected as AGENTS.md Block</button>
  <div id="copy-all-output" style="display:none;margin-top:10px">
    <div class="copy-box" id="copy-all-text"></div>
    <button class="copy-btn" onclick="copyText('copy-all-text')" title="Copy the selected config additions as one AGENTS.md block">Copy block</button>
  </div>`
			: ""
	}

  ${
		featuresToTry.length
			? `<h3 style="margin:24px 0 12px">Features to Try</h3>
  <div class="card-grid ${featuresToTry.length > 1 ? "cols2" : ""}">
    ${featuresToTry
			.map((f) => adviceCard({
				borderColor: "var(--accent)",
				title: itemTitle(f.title, f.feature, f.one_liner),
				reason: f.why_for_you,
				copyable: { text: f.example, kind: "prompt" },
				evidenceSessions: f.evidence_sessions,
				sessionPaths,
			}))
			.join("\n")}
  </div>`
			: ""
	}

  ${
		usagePatterns.length
			? `<h3 style="margin:24px 0 12px">Usage Patterns</h3>
  <div style="display:flex;flex-direction:column;gap:12px">
    ${usagePatterns
			.map((p) => adviceCard({
				borderColor: "var(--accent)",
				title: p.title,
				reason: p.suggestion,
				copyable: { text: p.copyable_prompt, kind: "prompt" },
				evidenceSessions: p.evidence_sessions,
				sessionPaths,
			}))
			.join("\n")}
  </div>`
			: ""
	}

  ${(suggSec?.stop_doing?.length) ? `<h3 style="margin:24px 0 12px;color:var(--red)">Consider Stopping</h3>
  <div style="display:flex;flex-direction:column;gap:12px">
    ${suggSec.stop_doing.map(s => adviceCard({
			borderColor: "var(--red)",
			title: itemTitle(s.title, s.what, s.why),
			reason: s.why,
			instead: { label: "Instead", text: s.alternative },
			evidenceSessions: s.evidence_sessions,
			sessionPaths,
		})).join("\n")}
  </div>` : ""}
</section>

<!-- ── On the Horizon ── -->
<section class="rpt-section" id="horizon">
<h2>Future Workflows</h2>
  ${horizonSec?.intro ? `<p style="color:var(--muted);margin-bottom:16px">${esc(horizonSec.intro)}</p>` : ""}
  <div style="display:flex;flex-direction:column;gap:12px">
    ${(horizonSec?.opportunities ?? [])
			.map(
				(o) => `<div class="horizon-card">
      <h3>${esc(o.title)}</h3>
      <p>${esc(o.whats_possible)}</p>
      <p class="how">${esc(o.how_to_try)}</p>
      <div class="copy-box">${esc(o.copyable_prompt)}</div>
      <button class="copy-btn" onclick="copyFromBox(this)" title="${esc(copyTooltip(o.copyable_prompt))}">${copyLabel("prompt")}</button>
    </div>`,
			)
			.join("\n")}
  </div>
</section>

<!-- ── Model Efficiency ── -->
<section class="rpt-section" id="model-efficiency">
<h2>Model Spend</h2>
  ${modelEffSec?.summary ? `<p style="color:var(--muted);margin-bottom:16px">${esc(modelEffSec.summary)}</p>` : ""}

  <div class="stat-grid">
    ${statCard("Estimated Waste", fmtCost(agg.estimated_waste), "from model mismatch", `n=${agg.sessions_with_facets} sessions with facets`, cardTitle("heuristic model-mismatch waste over flagged sessions", `n=${agg.sessions_with_facets} sessions with facets`))}
    ${statCard("Efficiency Flags", String(agg.model_efficiency.length), `${agg.model_efficiency.filter(e => e.flag === "overspend").length} overspend, ${agg.model_efficiency.filter(e => e.flag === "underspend").length} underspend, ${agg.model_efficiency.filter(e => e.flag === "quota_pressure").length} quota pressure`, `n=${agg.sessions_with_facets} sessions with facets`, cardTitle("sessions flagged overspend/underspend/quota_pressure", `n=${agg.sessions_with_facets} sessions with facets`))}
    ${statCard("Models Used", String(Object.keys(agg.model_usage).length), "", nSessions, cardTitle("distinct models recorded in model_usage", nSessions))}
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
    <p style="color:var(--muted);margin-top:8px">${esc(modelEffSec.overspend_pattern)}</p>
  </div>` : ""}

  ${modelEffSec?.underspend_pattern ? `<div class="card" style="margin-top:12px;border-left:3px solid var(--red)">
    <h3 style="color:var(--red);font-size:14px">Underspend Pattern</h3>
    <p style="color:var(--muted);margin-top:8px">${esc(modelEffSec.underspend_pattern)}</p>
  </div>` : ""}

  ${modelEffSec?.quota_pressure ? `<div class="card" style="margin-top:12px;border-left:3px solid var(--accent)">
    <h3 style="color:var(--accent);font-size:14px">Subscription Quota Pressure</h3>
    <p style="color:var(--muted);margin-top:8px">${esc(modelEffSec.quota_pressure)}</p>
  </div>` : ""}

  ${modelEffSec?.recommendation ? `<div class="card" style="margin-top:12px;border-left:3px solid var(--green)">
    <h3 style="color:var(--green);font-size:14px">Recommendation</h3>
    <p style="color:var(--muted);margin-top:8px">${esc(modelEffSec.recommendation)}</p>
    ${modelEffSec.potential_savings_note ? `<p style="color:var(--muted);margin-top:6px;font-size:12px;font-style:italic">${esc(modelEffSec.potential_savings_note)}</p>` : ""}
  </div>` : ""}

  ${agg.model_efficiency.length ? `<h3 style="margin-top:24px">Flagged Sessions</h3>
  <div style="display:flex;flex-direction:column;gap:8px;margin-top:12px">
    ${agg.model_efficiency.slice(0, 10).map(e => `<div class="card" style="padding:14px 18px">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div>
          <span class="badge ${e.flag === "overspend" ? "yellow" : "red"}">${esc(e.flag)}</span>
          <span style="color:var(--muted);font-size:13px;margin-left:8px">${esc(e.date)} · ${esc(e.model)}</span>
        </div>
        <span style="color:var(--accent);font-weight:600;font-size:14px">${fmtCost(e.cost)}</span>
      </div>
      <p style="color:var(--muted);font-size:13px;margin-top:6px">${esc(e.reason)}</p>
      <p style="color:var(--muted);font-size:12px;margin-top:4px">${esc(e.goal)}</p>
    </div>`).join("\n")}
  </div>
  ` : ""}
</section>


</div>
<script>
function copyText(id) {
  const el = document.getElementById(id);
  if (!el) return;
  navigator.clipboard.writeText(el.textContent).then(() => {
    const btn = el.nextElementSibling;
    if (btn) { const label = btn.textContent; btn.textContent = 'Copied'; setTimeout(() => { btn.textContent = label; }, 2000); }
  });
}
function copyFromBox(btn) {
  const box = btn.previousElementSibling;
  if (!box) return;
  navigator.clipboard.writeText(box.textContent).then(() => {
    const label = btn.textContent;
    btn.textContent = 'Copied';
    setTimeout(() => { btn.textContent = label; }, 2000);
  });
}
function copyAllConfig() {
  const checks = document.querySelectorAll('.cfg-check:checked');
  const lines = ['# omp AGENTS.md additions (generated by /insights)', ''];
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
