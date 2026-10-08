// SPDX-FileCopyrightText: 2026 Hari Srinivasan <harisrini21@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

import { buildSessionMeta, type SessionMeta } from "../index.ts";

/** A zeroed SessionMeta built through the real builder, with overrides on top. */
export function meta(overrides: Partial<SessionMeta>): SessionMeta {
	const base = buildSessionMeta(
		{
			id: "00000000-0000-7000-0000-000000000000",
			path: "/sessions/proj/log.jsonl",
			project_path: "/Users/me/projects/peach",
			size: 1,
			created: new Date("2026-09-01T09:00:00.000Z"),
			modified: new Date("2026-09-01T09:30:00.000Z"),
			sidecars: [],
			signature: "1:1",
		},
		[],
		[],
	);
	return { ...base, project_path: "/Users/me/projects/peach", ...overrides };
}
