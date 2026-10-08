// SPDX-FileCopyrightText: 2026 Hari Srinivasan <harisrini21@gmail.com>
// SPDX-FileCopyrightText: 2026 Tobias Hoelzer (omp port)
// SPDX-License-Identifier: AGPL-3.0-only


// B9: detects changes to the harness itself (memory backend, model roles,
// installed skills/hooks, AGENTS.md) between runs, so "what changed" isn't
// limited to the mid-session model-switch signal in src/temporal.ts. That
// file owns the facet-derived week-over-week diff only; this is a separate,
// snapshot-derived signal, wired in by index.ts after the fact
// (TemporalData.harness_changes is optional for exactly this reason).
//
// Why a persisted snapshot instead of config.yml.bak-*: those backup files
// are written by hand or by an agent editing config.yml, not by omp itself,
// so they are not a reliable change log — a user who never triggers a
// backup leaves no trail at all. Every /insights run instead writes its own
// snapshot of the live state; the next run diffs against it. The very first
// run (no snapshot yet) reports no changes rather than guessing.

import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { listDirNames, parseSimpleYaml, yamlMap } from "./context.ts";
import type { HarnessChange } from "./types.ts";

export type HarnessSnapshot = {
	timestamp: string;
	/** sha256 of config.yml's raw text; "" if the file could not be read. */
	config_hash: string;
	memory_backend: string;
	model_roles: Record<string, string>;
	/** Sorted names from both skills/ and managed-skills/. */
	skills: string[];
	/** Sorted "event/name", e.g. "pre/eval". */
	hooks: string[];
	/** sha256 of AGENTS.md's raw text; null if the file does not exist. */
	agents_md_hash: string | null;
};

const SEVEN_DAYS_MS = 7 * 86400000;
const HARNESS_SNAPSHOT_FILENAME = "harness-snapshot.json";

function sameRecord(a: Record<string, string>, b: Record<string, string>): boolean {
	const ak = Object.keys(a).sort();
	const bk = Object.keys(b).sort();
	if (ak.length !== bk.length) return false;
	return ak.every((k, i) => k === bk[i] && a[k] === b[k]);
}

function describeModelRoleDiff(prev: Record<string, string>, cur: Record<string, string>): string {
	const roles = [...new Set([...Object.keys(prev), ...Object.keys(cur)])]
		.filter((k) => prev[k] !== cur[k])
		.map((k) => `${k}: ${prev[k] ?? "unset"} -> ${cur[k] ?? "unset"}`);
	return `model roles changed (${roles.join(", ")})`;
}

/**
 * Pure diff between the previous persisted snapshot (null on the first run)
 * and the current one. `windowEnd` is the report's date_range.end; too_recent
 * is based on the PREVIOUS snapshot's timestamp, not the change itself —
 * a snapshot diff only brackets a change between two run times, it never
 * dates it precisely, so "how long has it been" is measured from the last
 * point we know the harness was still in its old state.
 */
export function detectHarnessChanges(
	previous: HarnessSnapshot | null,
	current: HarnessSnapshot,
	windowEnd: string,
): HarnessChange[] {
	if (!previous) return [];

	const when = current.timestamp;
	const tooRecent = new Date(windowEnd).getTime() - new Date(previous.timestamp).getTime() < SEVEN_DAYS_MS;
	const changes: HarnessChange[] = [];

	if (previous.memory_backend !== current.memory_backend) {
		changes.push({
			type: "memory_backend",
			when,
			detail: `memory backend changed from "${previous.memory_backend || "unset"}" to "${current.memory_backend || "unset"}"`,
			too_recent: tooRecent,
		});
	}
	if (!sameRecord(previous.model_roles, current.model_roles)) {
		changes.push({
			type: "model_roles_changed",
			when,
			detail: describeModelRoleDiff(previous.model_roles, current.model_roles),
			too_recent: tooRecent,
		});
	}
	for (const skill of current.skills) {
		if (!previous.skills.includes(skill)) {
			changes.push({ type: "skill_added", when, detail: `skill "${skill}" installed`, too_recent: tooRecent });
		}
	}
	for (const skill of previous.skills) {
		if (!current.skills.includes(skill)) {
			changes.push({ type: "skill_removed", when, detail: `skill "${skill}" removed`, too_recent: tooRecent });
		}
	}
	for (const hook of current.hooks) {
		if (!previous.hooks.includes(hook)) {
			changes.push({ type: "hook_added", when, detail: `hook "${hook}" added`, too_recent: tooRecent });
		}
	}
	for (const hook of previous.hooks) {
		if (!current.hooks.includes(hook)) {
			changes.push({ type: "hook_removed", when, detail: `hook "${hook}" removed`, too_recent: tooRecent });
		}
	}
	if (previous.agents_md_hash !== current.agents_md_hash) {
		changes.push({ type: "agents_md_updated", when, detail: "AGENTS.md updated", too_recent: tooRecent });
	}
	// Catch-all: config.yml changed in some field not individually tracked
	// above (e.g. retry.fallbackChains, theme, bash.enabled).
	if (
		previous.config_hash !== current.config_hash &&
		previous.memory_backend === current.memory_backend &&
		sameRecord(previous.model_roles, current.model_roles)
	) {
		changes.push({
			type: "config_changed",
			when,
			detail: "config.yml changed (fields outside memory backend and model roles)",
			too_recent: tooRecent,
		});
	}

	changes.sort((a, b) => a.when.localeCompare(b.when));
	return changes;
}

async function readMemoryBackend(cfg: ReturnType<typeof parseSimpleYaml>): Promise<string> {
	const backend = yamlMap(cfg, "memory")?.backend;
	return typeof backend === "string" && backend ? backend : "learn";
}

/** Reads the live harness state from an omp agent dir (defaults to the real one; tests pass a temp dir). */
export async function gatherHarnessSnapshot(agentDir: string): Promise<HarnessSnapshot> {
	let configText = "";
	try {
		configText = await readFile(join(agentDir, "config.yml"), "utf-8");
	} catch {}
	const config_hash = configText ? createHash("sha256").update(configText).digest("hex") : "";
	const cfg = parseSimpleYaml(configText);
	const memory_backend = await readMemoryBackend(cfg);

	const model_roles: Record<string, string> = {};
	const roles = yamlMap(cfg, "modelRoles");
	if (roles) {
		for (const [role, model] of Object.entries(roles)) {
			if (typeof model === "string") model_roles[role] = model;
		}
	}

	const skills = [
		...(await listDirNames(join(agentDir, "skills"), "dirs")),
		...(await listDirNames(join(agentDir, "managed-skills"), "dirs")),
	].sort();

	const hooks: string[] = [];
	try {
		const events = await readdir(join(agentDir, "hooks"), { withFileTypes: true });
		for (const event of events) {
			if (!event.isDirectory()) continue;
			for (const h of await listDirNames(join(agentDir, "hooks", event.name), "files")) {
				hooks.push(`${event.name}/${h}`);
			}
		}
	} catch {}
	hooks.sort();

	let agents_md_hash: string | null = null;
	try {
		const text = await readFile(join(agentDir, "AGENTS.md"), "utf-8");
		agents_md_hash = createHash("sha256").update(text).digest("hex");
	} catch {}

	return {
		timestamp: new Date().toISOString(),
		config_hash,
		memory_backend,
		model_roles,
		skills,
		hooks,
		agents_md_hash,
	};
}

/** null if no snapshot has been saved yet (the very first run). */
export async function loadHarnessSnapshot(dataDir: string): Promise<HarnessSnapshot | null> {
	try {
		return JSON.parse(await readFile(join(dataDir, HARNESS_SNAPSHOT_FILENAME), "utf-8")) as HarnessSnapshot;
	} catch {
		return null;
	}
}

export async function saveHarnessSnapshot(dataDir: string, snapshot: HarnessSnapshot): Promise<void> {
	await writeFile(join(dataDir, HARNESS_SNAPSHOT_FILENAME), JSON.stringify(snapshot, null, 2), "utf-8");
}
