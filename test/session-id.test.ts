// SPDX-FileCopyrightText: 2026 Tobias Hoelzer (omp port)
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { buildClaudeMeta } from "../src/sources/claude.ts";
import { FACETS_DIR, isSafeSessionId, META_DIR } from "../src/cache.ts";
import { buildSessionMeta, resolveSafeSessionId } from "../src/stats.ts";

// A session id comes verbatim from the log's own `session` record, a field
// a crafted log fully controls. It is later interpolated straight into a
// cache filename (facets/<id>.json, session-meta/<source>-<id>.json), so an
// id like "../../evil" is a path-traversal primitive unless rejected first.

const SAFE_REF_ID = "00000000-0000-7000-8000-000000000001";
const UNSAFE_REF_ID = "../../ref-evil";

function sessionRecord(id: string) {
	return {
		type: "session",
		version: 3,
		id,
		timestamp: "2026-09-07T10:00:00.000Z",
		cwd: "/proj/a",
	};
}

function ref(id: string) {
	return {
		id,
		path: "/sessions/proj/log.jsonl",
		project_path: "",
		size: 1,
		created: new Date("2026-09-07T10:00:00.000Z"),
		modified: new Date("2026-09-07T10:30:00.000Z"),
		sidecars: [],
		signature: "1:1",
	};
}

test("isSafeSessionId accepts a normal uuid", () => {
	assert.equal(isSafeSessionId(SAFE_REF_ID), true);
});

test("isSafeSessionId rejects path traversal and bare dots", () => {
	assert.equal(isSafeSessionId("../../evil"), false);
	assert.equal(isSafeSessionId("."), false);
	assert.equal(isSafeSessionId(".."), false);
	assert.equal(isSafeSessionId(""), false);
});

test("resolveSafeSessionId falls back to the ref id when the record id is unsafe", () => {
	assert.equal(resolveSafeSessionId("../../evil", SAFE_REF_ID), SAFE_REF_ID);
});

test("resolveSafeSessionId keeps a safe record id as-is", () => {
	assert.equal(resolveSafeSessionId(SAFE_REF_ID, "some-other-id"), SAFE_REF_ID);
});

test("resolveSafeSessionId throws when neither candidate is safe", () => {
	assert.throws(() => resolveSafeSessionId("../../evil", UNSAFE_REF_ID));
});

test("buildSessionMeta falls back to the filename-derived ref id when the session record's id is unsafe", () => {
	const meta = buildSessionMeta(ref(SAFE_REF_ID), [sessionRecord("../../evil")], []);
	assert.equal(meta.session_id, SAFE_REF_ID);
});

test("buildSessionMeta keeps a normal uuid session id", () => {
	const meta = buildSessionMeta(ref(SAFE_REF_ID), [sessionRecord(SAFE_REF_ID)], []);
	assert.equal(meta.session_id, SAFE_REF_ID);
});

test("buildSessionMeta throws (scan loop skips and counts it) when both the record id and the ref id are unsafe", () => {
	assert.throws(() => buildSessionMeta(ref(UNSAFE_REF_ID), [sessionRecord("../../evil")], []));
});

test("buildClaudeMeta falls back to the filename-derived ref id when the record's sessionId is unsafe", () => {
	const meta = buildClaudeMeta(ref(SAFE_REF_ID), [{ type: "user", sessionId: "../../evil", cwd: "/proj/a" }]);
	assert.equal(meta.session_id, SAFE_REF_ID);
});

test("buildClaudeMeta keeps a normal uuid sessionId", () => {
	const meta = buildClaudeMeta(ref(SAFE_REF_ID), [{ type: "user", sessionId: SAFE_REF_ID, cwd: "/proj/a" }]);
	assert.equal(meta.session_id, SAFE_REF_ID);
});

test("buildClaudeMeta throws when both the record id and the ref id are unsafe", () => {
	assert.throws(() =>
		buildClaudeMeta(ref(UNSAFE_REF_ID), [{ type: "user", sessionId: "../../evil", cwd: "/proj/a" }]),
	);
});

test("the cache path for a safe session id stays inside the cache dir", () => {
	const facetsPath = join(FACETS_DIR, `${SAFE_REF_ID}.json`);
	const metaPath = join(META_DIR, `claude-${SAFE_REF_ID}.json`);
	assert.ok(facetsPath.startsWith(FACETS_DIR));
	assert.ok(metaPath.startsWith(META_DIR));
});
