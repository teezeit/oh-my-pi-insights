// SPDX-FileCopyrightText: 2026 Hari Srinivasan <harisrini21@gmail.com>
// SPDX-FileCopyrightText: 2026 Tobias Hoelzer (omp port)
// SPDX-License-Identifier: AGPL-3.0-only


// On-disk cache: session-meta, facets and generated sections, plus the
// data-directory layout every other module reads from.

import { mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SessionFacets, SessionMeta } from "./types.ts";

export const AGENT_DIR = join(homedir(), ".omp", "agent");
export const SESSIONS_DIR = join(AGENT_DIR, "sessions");
export const DATA_DIR = join(AGENT_DIR, "usage-data");
export const FACETS_DIR = join(DATA_DIR, "facets");
export const META_DIR = join(DATA_DIR, "session-meta");
export const SECTIONS_DIR = join(DATA_DIR, "sections");
export const REPORT_PATH = join(DATA_DIR, "report.html");
export const REPORT_MD_PATH = join(DATA_DIR, "report.md");
export const SESSION_SET_PATH = join(DATA_DIR, "session-set.json");

export async function ensureDirs(): Promise<void> {
	await mkdir(META_DIR, { recursive: true });
	await mkdir(FACETS_DIR, { recursive: true });
	await mkdir(SECTIONS_DIR, { recursive: true });
}

// Cache entries predating the friction-signal / per-turn / per-tool-wall-clock
// / cache-ratio fields (schema v1) carry none of them. Backfilling those
// fields to 0/{} on load silently hid real signal for the entire
// pre-existing corpus: every session whose log had not changed since it was
// last cached kept reporting zero aborts, zero errors, zero turns, forever,
// because the cache hit and the backfill made the miss invisible. A schema
// version is the correct fix; bump it whenever SessionMeta gains a field
// that must not read as a false zero.
export const META_SCHEMA_VERSION = 4;

export async function loadCachedMeta(
	sourceName: string,
	sessionId: string,
	signature: string,
): Promise<SessionMeta | null> {
	try {
		const raw = await readFile(join(META_DIR, `${sourceName}-${sessionId}.json`), "utf-8");
		const parsed = JSON.parse(raw) as SessionMeta & { _schema_version?: number };
		if (parsed._schema_version !== META_SCHEMA_VERSION) return null;
		// A log that has grown since the entry was written must be re-read, or
		// the report's totals stop matching the logs they claim to summarise.
		if (parsed.log_signature !== signature) return null;
		return parsed;
	} catch {
		return null;
	}
}

export async function saveMeta(sourceName: string, meta: SessionMeta): Promise<void> {
	const withVersion = { ...meta, _schema_version: META_SCHEMA_VERSION };
	await writeFile(
		join(META_DIR, `${sourceName}-${meta.session_id}.json`),
		JSON.stringify(withVersion, null, 2),
		{ encoding: "utf-8", mode: 0o600 },
	);
}

export type CachedSections = {
	sections: Record<string, unknown>;
	synthesis: Record<string, string>;
};

/**
 * The eight section prompts and the synthesis are a pure function of the
 * shared data block, so they are cached on a hash of it. Without this a
 * re-run with every facet cached still spent a minute and real money
 * regenerating identical prose.
 */
export async function loadCachedSections(key: string): Promise<CachedSections | null> {
	try {
		const raw = await readFile(join(SECTIONS_DIR, `${key}.json`), "utf-8");
		const parsed = JSON.parse(raw) as CachedSections;
		return parsed.sections ? parsed : null;
	} catch {
		return null;
	}
}

export async function saveSections(key: string, value: CachedSections): Promise<void> {
	await writeFile(join(SECTIONS_DIR, `${key}.json`), JSON.stringify(value, null, 2), {
		encoding: "utf-8",
		mode: 0o600,
	});
}

/**
 * Every distinct corpus state mints a new entry, and the corpus changes
 * whenever omp runs, so this directory would grow without bound.
 */
export async function pruneSections(sourceName: string, keep = 5): Promise<void> {
	try {
		const files = (await readdir(SECTIONS_DIR)).filter((f) =>
			f.startsWith(`${sourceName}-`),
		);
		const stamped = await Promise.all(
			files
				.filter((f) => f.endsWith(".json"))
				.map(async (f) => ({ f, m: (await stat(join(SECTIONS_DIR, f))).mtimeMs })),
		);
		stamped.sort((a, b) => b.m - a.m);
		for (const { f } of stamped.slice(keep)) {
			await unlink(join(SECTIONS_DIR, f)).catch(() => {});
		}
	} catch {
		/* cache pruning is best effort */
	}
}

/**
 * Newest cached generation regardless of key. Only for --no-llm, where the
 * caller has asked for no spend: reusing prose written against a slightly
 * older corpus beats rendering none, provided the report says so.
 */
export async function loadLatestSections(sourceName: string): Promise<CachedSections | null> {
	try {
		const files = (await readdir(SECTIONS_DIR)).filter((f) =>
			f.startsWith(`${sourceName}-`),
		);
		const stamped = await Promise.all(
			files
				.filter((f) => f.endsWith(".json"))
				.map(async (f) => ({ f, m: (await stat(join(SECTIONS_DIR, f))).mtimeMs })),
		);
		const newest = stamped.sort((a, b) => b.m - a.m)[0];
		return newest ? await loadCachedSections(newest.f.replace(/\.json$/, "")) : null;
	} catch {
		return null;
	}
}

export async function loadCachedFacets(
	sessionId: string,
): Promise<SessionFacets | null> {
	try {
		const raw = await readFile(join(FACETS_DIR, `${sessionId}.json`), "utf-8");
		const parsed = JSON.parse(raw) as SessionFacets;
		// Basic schema check
		if (!parsed.session_id || !parsed.brief_summary || !parsed.outcome)
			return null;
		return parsed;
	} catch {
		return null;
	}
}

export async function saveFacets(facets: SessionFacets): Promise<void> {
	await writeFile(
		join(FACETS_DIR, `${facets.session_id}.json`),
		JSON.stringify(facets, null, 2),
		{ encoding: "utf-8", mode: 0o600 },
	);
}

export async function deleteCachedFacets(sessionId: string): Promise<void> {
	try {
		await unlink(join(FACETS_DIR, `${sessionId}.json`));
	} catch {
		/* ok */
	}
}
