// SPDX-FileCopyrightText: 2026 Hari Srinivasan <harisrini21@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { test } from "node:test";
import { filterByEvidence } from "../index.ts";

// B10: stop_doing and suggestion items must carry >= 2 distinct evidence
// session ids; items with fewer are dropped before render.

test("drops a stop_doing item citing a single session, keeps one citing two", () => {
	const filtered = filterByEvidence({
		stop_doing: [
			{ what: "Stop X", why: "evidence", alternative: "do Y", evidence_sessions: ["a1b2c3d4"] },
			{ what: "Stop Z", why: "evidence", alternative: "do W", evidence_sessions: ["a1b2c3d4", "e5f6a7b8"] },
		],
	});
	assert.deepEqual(
		filtered.stop_doing!.map((s) => s.what),
		["Stop Z"],
	);
});

test("duplicate ids in one item count once, not twice", () => {
	const filtered = filterByEvidence({
		stop_doing: [
			{ what: "Stop X", why: "evidence", alternative: "do Y", evidence_sessions: ["a1b2c3d4", "a1b2c3d4"] },
		],
	});
	assert.equal(filtered.stop_doing!.length, 0);
});

test("an item with no evidence_sessions is dropped", () => {
	const filtered = filterByEvidence({
		features_to_try: [
			{ feature: "xd:// devices", one_liner: "x", why_for_you: "y", example: "z", evidence_sessions: [] },
		],
	});
	assert.equal(filtered.features_to_try!.length, 0);
});

test("filters config_additions, features_to_try and usage_patterns the same way", () => {
	const filtered = filterByEvidence({
		config_additions: [
			{ addition: "a", why: "w", where: "AGENTS.md", evidence_sessions: ["s1"] },
		],
		features_to_try: [
			{ feature: "f", one_liner: "o", why_for_you: "w", example: "e", evidence_sessions: ["s1", "s2"] },
		],
		usage_patterns: [
			{ title: "t", suggestion: "s", detail: "d", copyable_prompt: "p", evidence_sessions: ["s1", "s2", "s3"] },
		],
	});
	assert.equal(filtered.config_additions!.length, 0);
	assert.equal(filtered.features_to_try!.length, 1);
	assert.equal(filtered.usage_patterns!.length, 1);
});

test("an empty or missing section stays empty/undefined", () => {
	const filtered = filterByEvidence({});
	assert.equal(filtered.stop_doing, undefined);
	assert.equal(filtered.config_additions, undefined);
});
