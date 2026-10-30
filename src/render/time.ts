// SPDX-FileCopyrightText: 2026 Tobias Hoelzer (omp port)
// SPDX-License-Identifier: AGPL-3.0-only


// Issue #18 "Where did the time go": renders the six-bucket wall-clock split
// (model/tools/agents/ci/you/idle), the top command families, subagent
// parallel work, time levers and slowest requests - as the main report's
// section, a standalone HTML page, a Markdown section and an at-a-glance
// widget. Pure rendering over a pre-computed TimeAggregate; no extraction or
// aggregation logic here (see src/time.ts, src/time-aggregate.ts).

import { esc, PAGE_STYLE } from "./html.ts";
import { top8 } from "../aggregate.ts";
import type { TimeAggregate, TimeBucket, TimeLever } from "../types.ts";

const BUCKET_LABEL: Record<TimeBucket, string> = {
	model: "Model",
	tools: "Tools",
	agents: "Agents",
	ci: "CI/CD",
	you: "You",
	elsewhere: "You (busy elsewhere)",
	idle: "Idle",
};

/** Short annotation shown beside a bucket's label and duration. */
const BUCKET_NOTE: Partial<Record<TimeBucket, string>> = {
	elsewhere: "waited on you while you worked in another session; not counted as a speed lever",
	idle: "excluded from active time",
};

// Active buckets in the order they are shown; idle is always rendered last
// and separately, since it is excluded from active_sec.
const ACTIVE_BUCKETS: TimeBucket[] = ["model", "tools", "agents", "ci", "you", "elsewhere"];

/** "2h 10m" / "45m" / "30s"; never a bare fraction, never NaN (callers must
 * not pass NaN/undefined - see the zero-session guard in every entry point). */
function fmtDuration(sec: number): string {
	const s = Math.max(0, Math.round(sec));
	if (s < 60) return `${s}s`;
	const totalMin = Math.round(s / 60);
	if (totalMin < 60) return `${totalMin}m`;
	const h = Math.floor(totalMin / 60);
	const m = totalMin % 60;
	return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function pct(share: number): string {
	return `${Math.round((share || 0) * 100)}%`;
}

const SEP = "\u00A0\u00B7\u00A0";

/** ISO timestamp or calendar date -> local "YYYY-MM-DD". Falsy/unparseable
 * input passes through unchanged (empty window, already-clean fixtures). */
function toLocalDate(s: string): string {
	if (!s) return s;
	const d = new Date(s);
	if (Number.isNaN(d.getTime())) return s;
	const yyyy = d.getFullYear();
	const mm = String(d.getMonth() + 1).padStart(2, "0");
	const dd = String(d.getDate()).padStart(2, "0");
	return `${yyyy}-${mm}-${dd}`;
}

/** "n=N sessions, start..end"; the window string every chart/table carries
 * so a reader can tell what the numbers behind it are. */
function sampleLine(agg: TimeAggregate): string {
	const n = `n=${agg.sessions} session${agg.sessions === 1 ? "" : "s"}`;
	if (agg.sessions === 0) return `${n}, no sessions in range`;
	return `${n}, ${toLocalDate(agg.date_range.start)}..${toLocalDate(agg.date_range.end)}`;
}

function sectionTitle(title: string, n: string): string {
	return `<h3>${esc(title)} <span style="text-transform:none;font-weight:400;color:var(--muted)">${esc(n)}</span></h3>`;
}

function bucketRow(agg: TimeAggregate, bucket: TimeBucket): string {
	const sec = agg.buckets[bucket] ?? 0;
	const share = agg.shares[bucket] ?? 0;
	const label = esc(BUCKET_LABEL[bucket]);
	const noteText = BUCKET_NOTE[bucket];
	const note = noteText ? `<div class="bar-note">${esc(noteText)}</div>` : "";
	return `<div class="bar-row">
  <div class="bar-label">${label}</div>
  <div class="bar-track"><div class="bar-fill" style="width:${pct(share)}"></div></div>
  <div class="bar-count">${pct(share)} / ${esc(fmtDuration(sec))}</div>
</div>
${note}`;
}

function leverCard(l: TimeLever): string {
	const shareChip = l.share !== undefined ? `<span class="meta-chip">${pct(l.share)} of active time</span>` : "";
	const evidence = l.evidence_sessions.length
		? `<div class="evidence">${l.evidence_sessions.map((id) => `<span class="evidence-cmd">${esc(id)}</span>`).join(" ")}</div>`
		: "";
	return `<div class="advice-card">
  <h3 class="advice-title">${esc(l.title)}</h3>
  <p class="advice-reason">${esc(l.detail)}</p>
  ${shareChip ? `<div class="meta-row">${shareChip}</div>` : ""}
  ${evidence}
</div>`;
}

function noDataSection(agg: TimeAggregate): string {
	return `<section class="rpt-section" id="time">
<h2>Where the Time Goes</h2>
<p class="muted">No data (${esc(sampleLine(agg))}).</p>
</section>`;
}

// Local overrides for the #time section only: PAGE_STYLE ships 140px/40px
// fixed columns for bar-label/bar-count, which truncates "You (busy
// elsewhere)" and wraps "13% / 10h 50m" onto four lines at the viewport
// widths this section is actually read at. Widen those columns, move the
// bucket note onto its own line, and give wide tables a horizontal-scroll
// container of their own instead of pushing the page wider than the
// viewport.
const TIME_SECTION_STYLE = `
  #time .bar-label { width: 180px; white-space: normal; overflow: visible; text-overflow: clip; }
  #time .bar-note { margin: 2px 0 8px 192px; font-size: 11px; color: var(--muted); max-width: 440px; }
  #time .bar-count { width: auto; min-width: 108px; white-space: nowrap; text-align: right; }
  #time .table-scroll { overflow-x: auto; }
  #time .cost-table { min-width: 480px; }
  #time .cost-table td { word-break: break-word; }
  #time .cost-table .evidence-cmd { word-break: break-all; white-space: normal; }
  @media (max-width: 480px) {
    #time .bar-row { flex-wrap: wrap; row-gap: 4px; }
    #time .bar-label { width: 100%; }
    #time .bar-note { margin-left: 0; max-width: none; }
    #time .bar-track { flex: 1 1 auto; }
    #time .bar-count { min-width: 92px; }
  }
`;

/** The main report's time section, and the body of the standalone page. */
export function renderTimeSection(agg: TimeAggregate): string {
	if (agg.sessions === 0) return noDataSection(agg);

	const bucketChart = [...ACTIVE_BUCKETS.map((b) => bucketRow(agg, b)), bucketRow(agg, "idle")].join("\n");

	const topCommands = top8(agg.busy_by_command);
	const commandsTable = topCommands.length
		? `<div class="table-scroll"><table class="cost-table">
  <thead><tr><th>Command</th><th>Busy time</th></tr></thead>
  <tbody>
    ${topCommands.map(([cmd, sec]) => `<tr><td><span class="evidence-cmd">${esc(cmd)}</span></td><td>${esc(fmtDuration(sec))}</td></tr>`).join("\n    ")}
  </tbody>
</table></div>`
		: `<p class="muted">No command data.</p>`;

	const levers = agg.levers.slice(0, 3);
	const leversHtml = levers.length
		? `<div class="card-grid ${levers.length > 1 ? "cols2" : ""}">
    ${levers.map(leverCard).join("\n    ")}
  </div>`
		: `<p class="muted">No levers surfaced.</p>`;

	const slowest = [...agg.slowest_requests].sort((a, b) => b.active_sec - a.active_sec).slice(0, 5);
	const slowestTable = slowest.length
		? `<div class="table-scroll"><table class="cost-table">
  <thead><tr><th>Prompt</th><th>Project</th><th>Active</th><th>Wall time</th><th>Dominant</th><th>Session</th></tr></thead>
  <tbody>
    ${slowest
			.map(
				(r) =>
					`<tr><td>${esc(r.prompt)}</td><td>${esc(r.project)}</td><td>${esc(fmtDuration(r.active_sec))}</td><td>${esc(fmtDuration(r.wall_sec))}</td><td>${esc(BUCKET_LABEL[r.dominant_bucket])}</td><td><span class="evidence-cmd">${esc(r.session_id)}</span></td></tr>`,
			)
			.join("\n    ")}
  </tbody>
</table></div>`
		: `<p class="muted">No requests recorded.</p>`;

	return `<section class="rpt-section" id="time">
<style>${TIME_SECTION_STYLE}</style>
<h2>Where the Time Goes</h2>
<p class="muted">${esc(sampleLine(agg))}</p>
<p class="muted">Totals below are <strong>summed session time</strong>, not unique elapsed calendar time - parallel sessions overlap and are each counted in full. Bucket assignment (${esc(BUCKET_LABEL.ci)} &gt; Agents &gt; Tools &gt; Model &gt; You) is inferred from message activity, not proof of what you were doing; idle time is capped at 15 minutes per gap before it stops counting as "You".</p>

<div class="chart-box">
${bucketChart}
</div>

<p class="muted">Subagent/advisor work ran <strong>${esc(fmtDuration(agg.subagent_busy_sec))}</strong> in parallel - not part of active time.</p>

${sectionTitle("Top Command Families", sampleLine(agg))}
${commandsTable}

${sectionTitle("Where to Focus", sampleLine(agg))}
${leversHtml}

${sectionTitle("Slowest Requests", sampleLine(agg))}
${slowestTable}
</section>`;
}

/** Self-contained standalone page (/insights time), reusing the main
 * report's exact stylesheet so it looks like one product. */
export function generateTimeHTML(agg: TimeAggregate, opts: { explain?: string; title?: string; generatedAt?: Date } = {}): string {
	const title = opts.title ?? "Where the time goes";
	const windowStr = agg.sessions > 0 ? `${toLocalDate(agg.date_range.start)} - ${toLocalDate(agg.date_range.end)}` : "no sessions in range";
	const generated = (opts.generatedAt ?? new Date()).toLocaleDateString();
	const explainBlock = opts.explain
		? `<section class="rpt-section" id="explain">
<h2>Explanation</h2>
<p>${esc(opts.explain)}</p>
</section>`
		: "";

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<style>
${PAGE_STYLE}
</style>
</head>
<body>
<div class="container">

<header>
  <h1>${esc(title)}</h1>
  <div class="subtitle">
    ${esc(windowStr)}${SEP}${agg.sessions} sessions${SEP}Generated ${esc(generated)}
  </div>
</header>

${renderTimeSection(agg)}
${explainBlock}

</div>
</body>
</html>`;
}

/** "## Where the Time Goes" Markdown section: a row per bucket, top command
 * families and the top levers, for the --md export. */
export function renderTimeMarkdown(agg: TimeAggregate): string {
	const lines: string[] = [];
	lines.push("## Where the Time Goes");
	lines.push(`> ${sampleLine(agg)}`);
	lines.push("");

	if (agg.sessions === 0) {
		lines.push("_No data._");
		return lines.join("\n");
	}

	lines.push("| Bucket | Share | Time |");
	lines.push("|--------|-------|------|");
	for (const b of [...ACTIVE_BUCKETS, "idle" as TimeBucket]) {
		const sec = agg.buckets[b] ?? 0;
		const share = agg.shares[b] ?? 0;
		const note = BUCKET_NOTE[b];
		const label = note ? `${BUCKET_LABEL[b]} (${note})` : BUCKET_LABEL[b];
		lines.push(`| ${label} | ${pct(share)} | ${fmtDuration(sec)} |`);
	}
	lines.push("");
	lines.push(`Subagent/advisor work ran ${fmtDuration(agg.subagent_busy_sec)} in parallel - not part of active time.`);

	const topCommands = top8(agg.busy_by_command).slice(0, 5);
	if (topCommands.length) {
		lines.push("");
		lines.push("**Top command families:**");
		for (const [cmd, sec] of topCommands) lines.push(`- \`${cmd}\`: ${fmtDuration(sec)}`);
	}

	if (agg.levers.length) {
		lines.push("");
		lines.push("**Where to focus:**");
		for (const l of agg.levers.slice(0, 3)) lines.push(`- **${l.title}**: ${l.detail}`);
	}

	return lines.join("\n");
}

/** <= 10 short lines for ctx.ui.setWidget: header, one line per bucket, top lever. */
export function timeWidgetLines(agg: TimeAggregate): string[] {
	if (agg.sessions === 0) return ["Where the time goes", "No data yet"];
	const lines: string[] = ["Where the time goes"];
	for (const b of [...ACTIVE_BUCKETS, "idle" as TimeBucket]) {
		const sec = agg.buckets[b] ?? 0;
		const share = agg.shares[b] ?? 0;
		lines.push(`${BUCKET_LABEL[b]} ${pct(share)} ${fmtDuration(sec)}`);
	}
	if (agg.levers[0]) lines.push(`Top lever: ${agg.levers[0].title}`);
	return lines;
}
