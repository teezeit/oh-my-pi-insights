// SPDX-FileCopyrightText: 2026 Tobias Hoelzer (omp port)
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { diffReports } from "../index.ts";

test("diffReports marks friction categories new, persisting and resolved vs the previous run (D20)", async () => {
	const prev = JSON.parse(await readFile(join(import.meta.dirname, "fixtures", "d-sections-prev.json"), "utf-8"));
	const curr = JSON.parse(await readFile(join(import.meta.dirname, "fixtures", "d-sections.json"), "utf-8"));

	const diff = diffReports(prev, curr);
	const byCategory = Object.fromEntries(diff.map((d) => [d.category, d.status]));

	// In both prev and curr.
	assert.equal(byCategory.stale_context_reload, "persisting");
	// Only in curr.
	assert.equal(byCategory.invented_tool_names, "new");
	// Only in prev.
	assert.equal(byCategory.slow_lint_on_save, "resolved");
});

test("two identical reports mark every category persisting, none new or resolved", () => {
	const s = { friction_analysis: { ongoing: [{ category: "a" }] } };
	assert.deepEqual(diffReports(s, s), [{ category: "a", status: "persisting" }]);
});
