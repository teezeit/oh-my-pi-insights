// SPDX-FileCopyrightText: 2026 Tobias Hoelzer (omp port)
// SPDX-License-Identifier: AGPL-3.0-only


// Pure helper: the top-of-report action list. Merges three suggestion
// pools into one fixed-priority, capped list so the reader sees the
// highest-leverage changes before anything else, instead of reading eight
// sections to assemble their own.

import { type CopyKind, configAdditionTitle, copyKindForWhere, itemTitle } from "./text.ts";

export type ActionItem = {
	source: "config_additions" | "stop_doing" | "usage_patterns";
	title: string;
	reason: string;
	instead?: { label: string; text: string };
	copyable?: { text: string; kind: CopyKind };
	where?: string;
	evidence_sessions?: string[];
};

type SuggestionsSection = {
	config_additions?: Array<{ title?: string; addition: string; why: string; where: string; evidence_sessions?: string[] }>;
	stop_doing?: Array<{ title?: string; what: string; why: string; alternative: string; evidence_sessions?: string[] }>;
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
		items.push({
			source: "config_additions",
			title: configAdditionTitle(c),
			reason: c.why,
			copyable: { text: c.addition, kind: copyKindForWhere(c.where) },
			where: c.where,
			evidence_sessions: c.evidence_sessions,
		});
	for (const s of sugg?.stop_doing ?? [])
		items.push({
			source: "stop_doing",
			title: itemTitle(s.title, s.what, s.why),
			reason: s.why,
			instead: { label: "Instead", text: s.alternative },
			evidence_sessions: s.evidence_sessions,
		});
	for (const p of sugg?.usage_patterns ?? [])
		items.push({
			source: "usage_patterns",
			title: p.title,
			reason: p.suggestion,
			copyable: { text: p.copyable_prompt, kind: "prompt" },
			evidence_sessions: p.evidence_sessions,
		});
	return items.slice(0, ACTION_LIST_CAP);
}
