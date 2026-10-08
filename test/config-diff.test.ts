// SPDX-FileCopyrightText: 2026 Tobias Hoelzer (omp port)
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { test } from "node:test";
import { configDiff } from "../index.ts";

test("configDiff reports only changed keys, unchanged keys omitted (D18)", () => {
	const live = {
		default: "anthropic/claude-opus-5",
		plan: "anthropic/claude-opus-5",
		smol: "anthropic/claude-haiku-4-5",
	};
	const proposed = {
		default: "anthropic/claude-opus-5", // unchanged
		plan: "anthropic/claude-opus-5-5", // changed
	};

	const diff = configDiff(live, proposed);

	assert.deepEqual(diff, [{ key: "plan", from: "anthropic/claude-opus-5", to: "anthropic/claude-opus-5-5" }]);
});

test("a proposed key absent from live reports from: (unset)", () => {
	const diff = configDiff({}, { tiny: "anthropic/claude-haiku-4-5" });
	assert.deepEqual(diff, [{ key: "tiny", from: "(unset)", to: "anthropic/claude-haiku-4-5" }]);
});

test("no proposed keys yields an empty diff", () => {
	assert.deepEqual(configDiff({ default: "x" }, {}), []);
});
