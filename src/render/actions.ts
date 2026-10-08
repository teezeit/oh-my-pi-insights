// SPDX-FileCopyrightText: 2026 Tobias Hoelzer (omp port)
// SPDX-License-Identifier: AGPL-3.0-only


// Pure helper: the top-of-report action list. Merges three suggestion
// pools into one fixed-priority, capped list so the reader sees the
// highest-leverage changes before anything else, instead of reading eight
// sections to assemble their own.

export type ActionItem = {
	source: "config_additions" | "stop_doing" | "usage_patterns";
	label: string;
	detail: string;
	where?: string;
	evidence_sessions?: string[];
};

type SuggestionsSection = {
	config_additions?: Array<{ addition: string; why: string; where: string; evidence_sessions?: string[] }>;
	stop_doing?: Array<{ what: string; why: string; alternative: string; evidence_sessions?: string[] }>;
	usage_patterns?: Array<{ title: string; suggestion: string; detail: string; copyable_prompt: string; evidence_sessions?: string[] }>;
};

const ACTION_LIST_CAP = 5;

/**
 * Priority: config_additions > stop_doing > usage_patterns. A concrete
 * config/AGENTS.md rule is the cheapest action to take; stopping a habit is
 * the next cheapest; adopting a new usage pattern takes the most behavior
 * change. Capped at 5 so this stays a scan, not another section.
 */
export function buildActionList(sections: Record<string, unknown>): ActionItem[] {
	const sugg = sections.suggestions as SuggestionsSection | undefined;
	const items: ActionItem[] = [];
	for (const c of sugg?.config_additions ?? [])
		items.push({ source: "config_additions", label: c.addition, detail: c.why, where: c.where, evidence_sessions: c.evidence_sessions });
	for (const s of sugg?.stop_doing ?? [])
		items.push({ source: "stop_doing", label: `Stop: ${s.what}`, detail: s.why, evidence_sessions: s.evidence_sessions });
	for (const p of sugg?.usage_patterns ?? [])
		items.push({ source: "usage_patterns", label: p.title, detail: p.suggestion, evidence_sessions: p.evidence_sessions });
	return items.slice(0, ACTION_LIST_CAP);
}
