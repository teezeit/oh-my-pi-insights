// SPDX-FileCopyrightText: 2026 Tobias Hoelzer (omp port)
// SPDX-License-Identifier: AGPL-3.0-only


// Pure helper: a "live config.yml roles -> proposed roles" key diff, so a
// report could show only what actually changed instead of a full YAML
// snippet the reader has to diff by eye. Not wired into generateHTML/
// generateMarkdown yet: no section prompt emits a `proposed` roles map
// today, and this port takes no new prompt changes per the D sub-issue
// scope. Kept as a tested, ready-to-call helper for whoever adds that field.

export type ConfigDiffEntry = { key: string; from: string; to: string };

/** Only keys present in `proposed` are considered; unchanged keys are omitted. */
export function configDiff(
	live: Record<string, string>,
	proposed: Record<string, string>,
): ConfigDiffEntry[] {
	const entries: ConfigDiffEntry[] = [];
	for (const [key, to] of Object.entries(proposed)) {
		const from = live[key];
		if (from !== to) entries.push({ key, from: from ?? "(unset)", to });
	}
	return entries;
}
