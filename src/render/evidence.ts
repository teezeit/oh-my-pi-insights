// SPDX-FileCopyrightText: 2026 Tobias Hoelzer (omp port)
// SPDX-License-Identifier: AGPL-3.0-only


// Pure helper: turn an item's evidence_sessions ids into file:// links to
// the session log, using the id -> session_path map the caller already
// built from SessionMeta. Ids with no known path are dropped rather than
// linked to nowhere; the field itself is optional and absent on sections
// written before this contract, so callers see an empty list, not an error.

export type EvidenceLink = { id: string; href: string };

export function buildEvidenceLinks(
	ids: unknown,
	sessionPaths: Record<string, string>,
): EvidenceLink[] {
	if (!Array.isArray(ids)) return [];
	const links: EvidenceLink[] = [];
	for (const id of ids) {
		if (typeof id !== "string") continue;
		const path = sessionPaths[id];
		if (path) links.push({ id, href: `file://${path}` });
	}
	return links;
}
