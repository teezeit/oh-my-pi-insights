// SPDX-FileCopyrightText: 2026 Tobias Hoelzer (omp port)
// SPDX-License-Identifier: AGPL-3.0-only


// Pure helper: friction categories new/persisting/resolved between this run
// and the previous one, keyed by the LLM's own `category` string (the only
// stable id a friction_analysis entry carries across runs).

export type ReportDiffStatus = "new" | "persisting" | "resolved";
export type ReportDiffEntry = { category: string; status: ReportDiffStatus };

type FrictionSection = {
	ongoing?: Array<{ category: string }>;
	categories?: Array<{ category: string }>;
};

function frictionCategories(sections: Record<string, unknown>): string[] {
	const f = sections.friction_analysis as FrictionSection | undefined;
	return (f?.ongoing ?? f?.categories ?? []).map((c) => c.category);
}

export function diffReports(
	prev: Record<string, unknown>,
	curr: Record<string, unknown>,
): ReportDiffEntry[] {
	const prevCats = frictionCategories(prev);
	const currCats = frictionCategories(curr);
	const prevSet = new Set(prevCats);
	const currSet = new Set(currCats);
	const entries: ReportDiffEntry[] = [];
	for (const c of currCats) entries.push({ category: c, status: prevSet.has(c) ? "persisting" : "new" });
	for (const c of prevCats) if (!currSet.has(c)) entries.push({ category: c, status: "resolved" });
	return entries;
}
