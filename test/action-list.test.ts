// SPDX-FileCopyrightText: 2026 Tobias Hoelzer (omp port)
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { buildActionList, generateHTML, computeTemporalData, aggregateData } from "../index.ts";

const FIXTURE = join(import.meta.dirname, "fixtures", "d-sections.json");

test("buildActionList merges config_additions and stop_doing in fixed priority order, capped at 5 (D17)", async () => {
	const sections = JSON.parse(await readFile(FIXTURE, "utf-8"));
	const items = buildActionList(sections);

	assert.equal(items.length, 5);
	assert.deepEqual(
		items.map((i) => i.source),
		["config_additions", "config_additions", "config_additions", "stop_doing", "stop_doing"],
	);
	// usage_patterns candidate exists in the fixture but is pushed out by the cap.
	assert.ok(!items.some((i) => i.source === "usage_patterns"));
});

test("an empty suggestions section yields an empty action list, not a crash", () => {
	assert.deepEqual(buildActionList({}), []);
});

test("the action list renders before the first <details> section and before the first section in the HTML (D17)", async () => {
	const sections = JSON.parse(await readFile(FIXTURE, "utf-8"));
	const agg = aggregateData([], new Map());
	const temporal = computeTemporalData([], new Map());
	const html = generateHTML(agg, sections, {}, temporal);

	const actionIdx = html.indexOf('id="action-list"');
	const firstSectionIdx = html.indexOf('<details class="rpt-section"');
	assert.ok(actionIdx > -1, "action list not rendered");
	assert.ok(actionIdx < firstSectionIdx, "action list must render before the first report section");
});
