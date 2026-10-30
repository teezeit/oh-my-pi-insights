// SPDX-FileCopyrightText: 2026 Hari Srinivasan <harisrini21@gmail.com>
// SPDX-FileCopyrightText: 2026 Tobias Hoelzer (omp port)
// SPDX-License-Identifier: AGPL-3.0-only


// The omp SessionSource: a filesystem walk of ~/.omp/agent/sessions,
// replacing the Pi SessionManager import. Advisor and per-subagent sidecar
// logs live in a directory beside their parent's log.

import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { SESSIONS_DIR } from "../cache.ts";
import { buildSessionMeta, extractSidecarUsage, extractTextFromContent, isHumanMessage, isMetaSession } from "../stats.ts";
import type {
	AnyEntry,
	AnyMessage,
	ContentBlock,
	SessionMeta,
	SessionRef,
	SessionScan,
	SessionSource,
	SidecarKind,
	SidecarRef,
} from "../types.ts";

export async function readJsonl(path: string): Promise<AnyEntry[]> {
	const raw = await readFile(path, "utf-8");
	const out: AnyEntry[] = [];
	for (const line of raw.split("\n")) {
		// Why the brace check: a live session's tail can be a partial write, and
		// the first record is padded - both are cheaper to skip than to parse.
		if (!line.startsWith("{")) continue;
		try {
			out.push(JSON.parse(line) as AnyEntry);
		} catch {
			/* truncated or mid-write line */
		}
	}
	return out;
}

/** The subset of node's Dirent this scanner needs. */
export type DirEntry = { name: string; isDirectory(): boolean };

/** Collect every *.jsonl under a session's sidecar directory, recursively. */
export async function collectSidecars(
	dir: string,
	prefix: string,
	out: SidecarRef[],
): Promise<void> {
	let entries: DirEntry[] = [];
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			await collectSidecars(path, `${prefix}${entry.name}/`, out);
			continue;
		}
		// *.bash.log / *.read.log / *.eval.log are tool-output spill, not
		// transcripts. Only .jsonl files carry messages and cost.
		if (!entry.name.endsWith(".jsonl")) continue;
		const info = await stat(path).catch(() => null);
		if (!info) continue;
		out.push({
			kind: entry.name === "__advisor.jsonl" ? "advisor" : "subagent",
			name: `${prefix}${entry.name.replace(/\.jsonl$/, "")}`,
			path,
			size: info.size,
			mtime_ms: info.mtimeMs,
		});
	}
}

/**
 * omp forks a session by writing a new log whose header carries
 * `parentSession` and which embeds a full copy of the parent's history up to
 * the fork point: same record ids, same usage/cost, same tool calls. Summing
 * a fork's log in full double-counts every record it shares with its
 * ancestor chain, so a fork's build must drop any record whose id already
 * appears in an ancestor's log - by id, never by position, since the new
 * (unique) records are appended after the copied prefix, not at a fixed
 * offset.
 *
 * A sidecar's own `session` record also carries `parentSession`, but as the
 * parent's absolute log path rather than a bare session id (subagent/advisor
 * nesting, not a fork); only a path-free value marks a real fork.
 */
export async function resolveForkExcludedIds(
	sessionsDir: string,
	entries: AnyEntry[],
): Promise<Set<string> | null> {
	const excluded = new Set<string>();
	const visited = new Set<string>();
	let header = entries.find((e) => e.type === "session");
	let parentId = typeof header?.parentSession === "string" ? header.parentSession : undefined;

	while (parentId && !parentId.includes("/") && !visited.has(parentId)) {
		visited.add(parentId);
		const parentPath = await findSessionPath(sessionsDir, parentId);
		if (!parentPath) break;

		let parentEntries: AnyEntry[];
		try {
			parentEntries = await readJsonl(parentPath);
		} catch {
			break;
		}
		for (const e of parentEntries) {
			if (typeof e.id === "string") excluded.add(e.id);
		}

		header = parentEntries.find((e) => e.type === "session");
		parentId = typeof header?.parentSession === "string" ? header.parentSession : undefined;
	}

	return excluded.size > 0 ? excluded : null;
}

/**
 * Sidecar counterpart to `resolveForkExcludedIds`: omp copies the parent's
 * subagent/advisor sidecar logs byte for byte into the fork's sidecar
 * directory (same relative path, same record ids), so a fork's sidecar
 * folding double-counts every sidecar the parent already paid for. Walks
 * the same ancestor chain, but collects each ancestor's own sidecars and
 * returns, per relative sidecar name, the set of record ids already
 * counted there. Dedupe is by record id (not by byte-identical file)
 * because a fork can keep appending to a copied sidecar after the fork
 * point, same as the primary log.
 */
export async function resolveForkSidecarExcludedIds(
	sessionsDir: string,
	entries: AnyEntry[],
): Promise<Map<string, Set<string>> | null> {
	const excluded = new Map<string, Set<string>>();
	const visited = new Set<string>();
	let header = entries.find((e) => e.type === "session");
	let parentId = typeof header?.parentSession === "string" ? header.parentSession : undefined;

	while (parentId && !parentId.includes("/") && !visited.has(parentId)) {
		visited.add(parentId);
		const parentPath = await findSessionPath(sessionsDir, parentId);
		if (!parentPath) break;

		const parentSidecarDir = parentPath.slice(0, -".jsonl".length);
		const parentSidecars: SidecarRef[] = [];
		await collectSidecars(parentSidecarDir, "", parentSidecars);
		for (const sidecar of parentSidecars) {
			let sidecarEntries: AnyEntry[];
			try {
				sidecarEntries = await readJsonl(sidecar.path);
			} catch {
				continue;
			}
			let ids = excluded.get(sidecar.name);
			if (!ids) excluded.set(sidecar.name, (ids = new Set()));
			for (const e of sidecarEntries) if (typeof e.id === "string") ids.add(e.id);
		}

		let parentEntries: AnyEntry[];
		try {
			parentEntries = await readJsonl(parentPath);
		} catch {
			break;
		}

		header = parentEntries.find((e) => e.type === "session");
		parentId = typeof header?.parentSession === "string" ? header.parentSession : undefined;
	}

	return excluded.size > 0 ? excluded : null;
}

/**
 * Locate a top-level session log by id. The id is encoded in the filename
 * (`<ISO-ts>_<session-id>.jsonl`), so this never has to read file content;
 * only direct children of each project dir are candidates, matching
 * `listSessions` (sidecars live one directory level deeper and are never a
 * fork's parent).
 */
async function findSessionPath(sessionsDir: string, sessionId: string): Promise<string | null> {
	let projects: DirEntry[] = [];
	try {
		projects = await readdir(sessionsDir, { withFileTypes: true });
	} catch {
		return null;
	}
	for (const project of projects) {
		if (!project.isDirectory()) continue;
		const projectDir = join(sessionsDir, project.name);
		let entries: DirEntry[] = [];
		try {
			entries = await readdir(projectDir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (entry.isDirectory() || !entry.name.endsWith(".jsonl")) continue;
			const base = entry.name.slice(0, -".jsonl".length);
			const sep = base.indexOf("_");
			const id = sep >= 0 ? base.slice(sep + 1) : base;
			if (id === sessionId) return join(projectDir, entry.name);
		}
	}
	return null;
}

/**
 * ~/.omp/agent/sessions/<slugified-cwd>/<ISO-ts>_<session-id>.jsonl, with an
 * optional sibling directory of the same basename holding __advisor.jsonl,
 * subagent logs and tool-output spill.
 *
 * Filesystem-only by design: no omp internals, so the scan keeps working
 * across harness versions.
 */
// Why a factory: the sessions directory is injectable so the scanner can be
// exercised against a fixture tree instead of the user's real corpus.
export function createOmpSessionSource(sessionsDir: string = SESSIONS_DIR): SessionSource {
	return {
		name: "omp",
		root: sessionsDir,
		readEntries: readJsonl,
		isMetaSession,
		async buildMeta(ref, entries, sidecars) {
			const excludeIds = await resolveForkExcludedIds(sessionsDir, entries);
			const filtered = excludeIds
				? entries.filter((e) => !(typeof e.id === "string" && excludeIds.has(e.id)))
				: entries;

			const sidecarExcludedIds = await resolveForkSidecarExcludedIds(sessionsDir, entries);
			const foldedSidecars = sidecarExcludedIds
				? await Promise.all(
						sidecars.map(async (sidecar, i) => {
							const excludedIds = sidecarExcludedIds.get(ref.sidecars[i]?.name ?? "");
							if (!excludedIds || ref.sidecars[i] === undefined) return sidecar;
							const sidecarEntries = await readJsonl(ref.sidecars[i].path);
							const keptEntries = sidecarEntries.filter(
								(e) => !(typeof e.id === "string" && excludedIds.has(e.id)),
							);
							return { kind: sidecar.kind, usage: extractSidecarUsage(keptEntries) };
						}),
					)
				: sidecars;

			return buildSessionMeta(ref, filtered, foldedSidecars);
		},
		readSidecar: extractSidecarUsage,
		formatTranscript,
		async listSessions(): Promise<SessionScan> {
			const sessions: SessionRef[] = [];
			let projects: DirEntry[] = [];
			try {
				projects = await readdir(sessionsDir, { withFileTypes: true });
			} catch {
				return { sessions, duplicate_logs: 0 };
			}

			for (const project of projects) {
				if (!project.isDirectory()) continue;
				const projectDir = join(sessionsDir, project.name);
				let entries: DirEntry[] = [];
				try {
					entries = await readdir(projectDir, { withFileTypes: true });
				} catch {
					continue;
				}
				const sidecarDirs = new Set(
					entries.filter((e) => e.isDirectory()).map((e) => e.name),
				);

				for (const entry of entries) {
					if (entry.isDirectory() || !entry.name.endsWith(".jsonl")) continue;
					const base = entry.name.replace(/\.jsonl$/, "");
					const path = join(projectDir, entry.name);
					const info = await stat(path).catch(() => null);
					if (!info) continue;

					const sidecars: SidecarRef[] = [];
					if (sidecarDirs.has(base))
						await collectSidecars(join(projectDir, base), "", sidecars);

					// <ISO-ts>_<session-id>: the id is authoritative from the session
					// record, but the filename gives it before parsing so the meta
					// cache can be consulted without reading the log.
					const sep = base.indexOf("_");
					sessions.push({
						id: sep >= 0 ? base.slice(sep + 1) : base,
						path,
						project_path: "",
						size: info.size,
						created: info.birthtime.getTime() ? info.birthtime : info.mtime,
						modified: info.mtime,
						sidecars,
						signature: [
							`${info.size}:${info.mtimeMs}`,
							...sidecars.map((s) => `${s.name}=${s.size}:${s.mtime_ms}`),
						].join("|"),
					});
				}
			}

			// The same session can exist twice on disk under two slugified-cwd
			// directories (a copied or relocated log keeps its session record id).
			// Counting it twice would double-count its spend, so the largest copy
			// wins - it is the most complete one.
			const byId = new Map<string, SessionRef>();
			for (const ref of sessions) {
				const seen = byId.get(ref.id);
				if (!seen || ref.size > seen.size) byId.set(ref.id, ref);
			}
			return {
				sessions: [...byId.values()],
				duplicate_logs: sessions.length - byId.size,
			};
		},
	};
}

export const ompSessionSource = createOmpSessionSource();


export function formatTranscript(entries: AnyEntry[], meta: SessionMeta): string {
	const lines: string[] = [
		`Session: ${meta.session_id.slice(0, 8)}`,
		`Date: ${meta.start_time}`,
		`Project: ${meta.project_path}`,
		`Duration: ${meta.duration_minutes} min`,
		"",
	];

	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const msg = entry.message as AnyMessage | undefined;
		if (!msg) continue;

		if (msg.role === "user" && isHumanMessage(msg)) {
			const text = extractTextFromContent(msg.content).slice(0, 500);
			if (text.trim()) lines.push(`[User]: ${text}`);
		} else if (msg.role === "assistant") {
			const content = msg.content;
			if (Array.isArray(content)) {
				for (const block of content as ContentBlock[]) {
					if (block.type === "text" && block.text) {
						lines.push(`[Assistant]: ${(block.text as string).slice(0, 300)}`);
					} else if (block.type === "toolCall" && block.name) {
						lines.push(`[Tool: ${block.name as string}]`);
					}
				}
			}
		}
	}

	return lines.join("\n");
}
