// SPDX-FileCopyrightText: 2026 Tobias Hoelzer (omp port)
// SPDX-License-Identifier: AGPL-3.0-only


// Live config.yml vs a suggested config.yml change, as a key diff instead
// of a raw YAML snippet the reader has to diff by eye.

import { flattenYaml, parseSimpleYaml, type YamlNode } from "../context.ts";

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

/**
 * A config_additions item's `addition` is free English text by prompt
 * design ("a specific rule NOT already in their AGENTS.md"), not guaranteed
 * YAML. When it happens to be YAML-shaped (one or more `key: value` lines,
 * the model citing the literal config.yml change it wants), this diffs it
 * against the live flattened config and returns the changed keys; when it
 * parses to no scalar keys (the common prose case) or the parsed values
 * already match live (nothing would actually change), it returns null so
 * the caller falls back to rendering the raw addition text.
 */
export function diffConfigAddition(
	live: Record<string, string>,
	addition: string,
): ConfigDiffEntry[] | null {
	let parsed: YamlNode;
	try {
		parsed = parseSimpleYaml(addition);
	} catch {
		return null;
	}
	const proposed = flattenYaml(parsed);
	if (!Object.keys(proposed).length) return null;
	const diff = configDiff(live, proposed);
	return diff.length ? diff : null;
}
