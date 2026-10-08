// SPDX-FileCopyrightText: 2026 Hari Srinivasan <harisrini21@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { test } from "node:test";
import { detectHarnessChanges, type HarnessState } from "../index.ts";

// B9: the harness itself changes mid-corpus (memory backend swapped, a hook
// added) and the report must say so, not just detect model switches.

function state(overrides: Partial<HarnessState> = {}): HarnessState {
	return {
		config_snapshots: [],
		skill_additions: [],
		hook_additions: [],
		agents_md_mtime: null,
		...overrides,
	};
}

test("detects a memory backend change inside the window and flags it too_recent", () => {
	const windowStart = "2026-08-19";
	const windowEnd = "2026-10-07";
	const changeDate = "2026-10-04T00:00:00.000Z"; // 3 days before windowEnd

	const changes = detectHarnessChanges(
		state({
			config_snapshots: [
				{ when: "2026-08-19T00:00:00.000Z", memory_backend: "learn" },
				{ when: changeDate, memory_backend: "mnemopi" },
			],
		}),
		windowStart,
		windowEnd,
	);

	assert.equal(changes.length, 1);
	assert.equal(changes[0]!.type, "memory_backend");
	assert.equal(changes[0]!.too_recent, true);
	assert.match(changes[0]!.detail, /learn.*mnemopi/);
});

test("detects a hook addition inside the window and flags it too_recent", () => {
	const windowStart = "2026-08-19";
	const windowEnd = "2026-10-07";
	const addedAt = "2026-10-04T00:00:00.000Z"; // 3 days before windowEnd

	const changes = detectHarnessChanges(
		state({ hook_additions: [{ name: "pre/format.ts", added_at: addedAt }] }),
		windowStart,
		windowEnd,
	);

	assert.equal(changes.length, 1);
	assert.equal(changes[0]!.type, "hook_added");
	assert.equal(changes[0]!.too_recent, true);
});

test("a change more than 7 days before window end is not too_recent", () => {
	const changes = detectHarnessChanges(
		state({
			config_snapshots: [
				{ when: "2026-08-19T00:00:00.000Z", memory_backend: "learn" },
				{ when: "2026-09-01T00:00:00.000Z", memory_backend: "mnemopi" },
			],
		}),
		"2026-08-19",
		"2026-10-07",
	);

	assert.equal(changes.length, 1);
	assert.equal(changes[0]!.too_recent, false);
});

test("ignores changes outside the report window", () => {
	const changes = detectHarnessChanges(
		state({
			skill_additions: [{ name: "old-skill", added_at: "2026-01-01T00:00:00.000Z" }],
		}),
		"2026-08-19",
		"2026-10-07",
	);
	assert.equal(changes.length, 0);
});

test("no change when the backend is stable across snapshots", () => {
	const changes = detectHarnessChanges(
		state({
			config_snapshots: [
				{ when: "2026-08-19T00:00:00.000Z", memory_backend: "learn" },
				{ when: "2026-09-01T00:00:00.000Z", memory_backend: "learn" },
			],
		}),
		"2026-08-19",
		"2026-10-07",
	);
	assert.equal(changes.length, 0);
});
