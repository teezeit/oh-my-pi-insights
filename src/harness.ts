// SPDX-FileCopyrightText: 2026 Hari Srinivasan <harisrini21@gmail.com>
// SPDX-FileCopyrightText: 2026 Tobias Hoelzer (omp port)
// SPDX-License-Identifier: AGPL-3.0-only


// B9: detects changes to the harness itself (memory backend, installed
// skills/hooks, AGENTS.md) inside the report window, so "what changed" isn't
// limited to the mid-session model-switch signal in src/temporal.ts. That
// file owns the facet-derived week-over-week diff only; this is a separate,
// config/filesystem-derived signal, wired in by index.ts after the fact
// (TemporalData.harness_changes is optional for exactly this reason).

import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { AGENT_DIR } from "./cache.ts";
import { parseSimpleYaml, yamlMap } from "./context.ts";
import type { HarnessChange } from "./types.ts";

export type ConfigSnapshot = { when: string; memory_backend: string };
export type DirAddition = { name: string; added_at: string };

export type HarnessState = {
	/** Sorted oldest -> newest; the live config.yml is the last entry. */
	config_snapshots: ConfigSnapshot[];
	skill_additions: DirAddition[];
	hook_additions: DirAddition[];
	agents_md_mtime: string | null;
};

const SEVEN_DAYS_MS = 7 * 86400000;

/**
 * Pure diff over an already-gathered harness state (see gatherHarnessState
 * for the filesystem side). A change is reported when its date falls inside
 * [windowStart, windowEnd]; it is additionally flagged too_recent when fewer
 * than 7 days of corpus data exist after it, mirroring the "not enough data
 * yet" caveat src/temporal.ts applies to facet-derived trends.
 */
export function detectHarnessChanges(
	state: HarnessState,
	windowStart: string,
	windowEnd: string,
): HarnessChange[] {
	const startMs = new Date(windowStart).getTime();
	const endMs = new Date(windowEnd).getTime();
	const inWindow = (iso: string) => {
		const t = new Date(iso).getTime();
		return t >= startMs && t <= endMs;
	};
	const tooRecent = (iso: string) => endMs - new Date(iso).getTime() < SEVEN_DAYS_MS;

	const changes: HarnessChange[] = [];

	for (let i = 1; i < state.config_snapshots.length; i++) {
		const prev = state.config_snapshots[i - 1]!;
		const cur = state.config_snapshots[i]!;
		if (cur.memory_backend === prev.memory_backend || !inWindow(cur.when)) continue;
		changes.push({
			type: "memory_backend",
			when: cur.when,
			detail: `memory backend changed from "${prev.memory_backend || "unset"}" to "${cur.memory_backend || "unset"}"`,
			too_recent: tooRecent(cur.when),
		});
	}
	for (const s of state.skill_additions) {
		if (!inWindow(s.added_at)) continue;
		changes.push({
			type: "skill_added",
			when: s.added_at,
			detail: `skill "${s.name}" installed`,
			too_recent: tooRecent(s.added_at),
		});
	}
	for (const h of state.hook_additions) {
		if (!inWindow(h.added_at)) continue;
		changes.push({
			type: "hook_added",
			when: h.added_at,
			detail: `hook "${h.name}" added`,
			too_recent: tooRecent(h.added_at),
		});
	}
	if (state.agents_md_mtime && inWindow(state.agents_md_mtime)) {
		changes.push({
			type: "agents_md_updated",
			when: state.agents_md_mtime,
			detail: "AGENTS.md updated",
			too_recent: tooRecent(state.agents_md_mtime),
		});
	}

	changes.sort((a, b) => a.when.localeCompare(b.when));
	return changes;
}

// omp writes timestamped backups as config.yml.bak-YYYYMMDD or
// config.yml.bak-YYYYMMDD-HHMMSS (plus a bare config.yml.bak with no
// timestamp); the suffix is the change date when present.
const BAK_TIMESTAMP = /\.bak(?:-(\d{8})(?:-(\d{6}))?)?$/;

async function readMemoryBackend(path: string): Promise<string> {
	try {
		const cfg = parseSimpleYaml(await readFile(path, "utf-8"));
		const backend = yamlMap(cfg, "memory")?.backend;
		return typeof backend === "string" && backend ? backend : "learn";
	} catch {
		return "learn";
	}
}

async function dirAdditions(dir: string): Promise<DirAddition[]> {
	let entries: Dirent[];
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const out: DirAddition[] = [];
	for (const e of entries) {
		if (e.name.startsWith(".")) continue;
		const st = await stat(join(dir, e.name)).catch(() => null);
		if (!st) continue;
		// birthtime is unreliable on some filesystems (reads as epoch 0); fall
		// back to mtime, which is always set.
		const at = st.birthtimeMs > 0 ? st.birthtime : st.mtime;
		out.push({ name: e.name.replace(/\.[^.]+$/, ""), added_at: at.toISOString() });
	}
	return out;
}

/** Reads the real on-disk harness state from ~/.omp/agent. */
export async function gatherHarnessState(): Promise<HarnessState> {
	const config_snapshots: ConfigSnapshot[] = [];
	try {
		const entries = await readdir(AGENT_DIR, { withFileTypes: true });
		for (const e of entries) {
			if (e.isDirectory() || !e.name.startsWith("config.yml.bak")) continue;
			const path = join(AGENT_DIR, e.name);
			const st = await stat(path).catch(() => null);
			const m = e.name.match(BAK_TIMESTAMP);
			const d = m?.[1];
			const when = d
				? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${(m![2] ?? "000000").slice(0, 2)}:${(m![2] ?? "000000").slice(2, 4)}:${(m![2] ?? "000000").slice(4, 6)}.000Z`
				: (st?.mtime ?? new Date(0)).toISOString();
			config_snapshots.push({ when, memory_backend: await readMemoryBackend(path) });
		}
	} catch {}
	config_snapshots.sort((a, b) => a.when.localeCompare(b.when));

	const liveConfigPath = join(AGENT_DIR, "config.yml");
	const liveStat = await stat(liveConfigPath).catch(() => null);
	config_snapshots.push({
		when: (liveStat?.mtime ?? new Date()).toISOString(),
		memory_backend: await readMemoryBackend(liveConfigPath),
	});

	const skill_additions = [
		...(await dirAdditions(join(AGENT_DIR, "skills"))),
		...(await dirAdditions(join(AGENT_DIR, "managed-skills"))),
	];

	const hook_additions: DirAddition[] = [];
	try {
		const events = await readdir(join(AGENT_DIR, "hooks"), { withFileTypes: true });
		for (const event of events) {
			if (!event.isDirectory()) continue;
			for (const h of await dirAdditions(join(AGENT_DIR, "hooks", event.name))) {
				hook_additions.push({ name: `${event.name}/${h.name}`, added_at: h.added_at });
			}
		}
	} catch {}

	let agents_md_mtime: string | null = null;
	try {
		agents_md_mtime = (await stat(join(AGENT_DIR, "AGENTS.md"))).mtime.toISOString();
	} catch {}

	return { config_snapshots, skill_additions, hook_additions, agents_md_mtime };
}
