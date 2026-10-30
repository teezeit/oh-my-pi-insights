// SPDX-FileCopyrightText: 2026 Tobias Hoelzer (omp port)
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { test } from "node:test";
import { aggregateData, normalizeFrictionCounts, type SessionFacets } from "../index.ts";
import { meta } from "./helpers.ts";

// Issue #11: word-order/synonym variants of the same friction category must
// merge into one key instead of becoming separate chart rows.
test("normalizeFrictionCounts merges word-order variants into one key", () => {
	const result = normalizeFrictionCounts({
		communication_unclear: 1,
		unclear_communication: 2,
	});

	assert.equal(Object.keys(result).length, 1);
	assert.equal(Object.values(result)[0], 3);
});

// Issue #12: a resolution/success word in the key means the model wrote an
// outcome, not a friction type - it must be dropped entirely, not counted.
test("normalizeFrictionCounts drops resolution/success keys", () => {
	const result = normalizeFrictionCounts({
		technical_issue_resolved: 1,
		wrong_approach: 1,
	});

	assert.deepEqual(result, { wrong_approach: 1 });
});

test("normalizeFrictionCounts maps a Title Case variant onto its canonical taxonomy key", () => {
	const result = normalizeFrictionCounts({ "Wrong Approach": 1 });

	assert.deepEqual(result, { wrong_approach: 1 });
});

test("normalizeFrictionCounts drops non-positive counts", () => {
	const result = normalizeFrictionCounts({ wrong_approach: 0, buggy_code: -1 });

	assert.deepEqual(result, {});
});

// Follow-up: a canonical taxonomy key must come back exactly as itself, not
// run through the word-order fallback ("agent_direction_wrong").
test("normalizeFrictionCounts keeps a canonical taxonomy key (agent_wrong_direction) as itself, not a sorted-token mash-up", () => {
	const result = normalizeFrictionCounts({ agent_wrong_direction: 44 });

	assert.deepEqual(result, { agent_wrong_direction: 44 });
});

test("normalizeFrictionCounts keeps a canonical taxonomy key (user_rephrased) as itself", () => {
	const result = normalizeFrictionCounts({ user_rephrased: 38 });

	assert.deepEqual(result, { user_rephrased: 38 });
});

// Follow-up: non-canonical variants must merge onto a natural spelling the
// model actually wrote ("tool_failure"), never a sorted-token mash-up
// ("failure_tool"/"failures_tool").
test("normalizeFrictionCounts merges a plural/singular variant pair into a natural-order key, not a sorted-token one", () => {
	const result = normalizeFrictionCounts({ tool_failures: 2, tool_failure: 1 });

	assert.deepEqual(result, { tool_failure: 3 });
	assert.ok(!("failure_tool" in result), "must not emit the sorted-token form");
	assert.ok(!("failures_tool" in result), "must not emit the sorted-token form");
});

test("normalizeFrictionCounts merges communication_unclear/unclear_communication into a natural-order key", () => {
	const result = normalizeFrictionCounts({ communication_unclear: 1, unclear_communication: 2 });

	assert.deepEqual(result, { communication_unclear: 3 });
});

// Follow-up: "unresolved" is not "resolved" - only a whole drop-token match
// counts, never a substring match.
test("normalizeFrictionCounts keeps investigation_unresolved (unresolved is not resolved)", () => {
	const result = normalizeFrictionCounts({ investigation_unresolved: 1 });

	assert.deepEqual(result, { investigation_unresolved: 1 });
});

function facets(overrides: Partial<SessionFacets>): SessionFacets {
	return {
		session_id: "s",
		underlying_goal: "",
		goal_categories: {},
		outcome: "fully_achieved",
		user_satisfaction_counts: {},
		assistant_helpfulness: "",
		session_type: "single_task",
		friction_counts: {},
		friction_detail: "",
		primary_success: "none",
		brief_summary: "x",
		...overrides,
	};
}

test("aggregateData over facets with variant friction keys yields a single agg.friction row", () => {
	const metas = [
		meta({ session_id: "a" }),
		meta({ session_id: "b" }),
		meta({ session_id: "c" }),
	];
	const facetsMap = new Map([
		["a", facets({ session_id: "a", friction_counts: { communication_unclear: 1 } })],
		["b", facets({ session_id: "b", friction_counts: { unclear_communication: 2 } })],
		["c", facets({ session_id: "c", friction_counts: { technical_issue_resolved: 5 } })],
	]);

	const agg = aggregateData(metas, facetsMap);

	const frictionKeys = Object.keys(agg.friction);
	assert.equal(frictionKeys.length, 1, `expected one friction key, got ${JSON.stringify(agg.friction)}`);
	assert.ok(!("technical_issue_resolved" in agg.friction), "resolution key must not appear as friction");
});

// Follow-up: two sessions, each writing a single spelling of the same
// category, must still merge in the corpus-wide chart even though
// normalizeFrictionCounts only ever sees one session's dict at a time.
test("aggregateData regroups cross-session natural-key variants that each session wrote alone", () => {
	const metas = [meta({ session_id: "a" }), meta({ session_id: "b" })];
	const facetsMap = new Map([
		["a", facets({ session_id: "a", friction_counts: { tool_failures: 2 } })],
		["b", facets({ session_id: "b", friction_counts: { tool_failure: 1 } })],
	]);

	const agg = aggregateData(metas, facetsMap);

	assert.deepEqual(Object.keys(agg.friction), ["tool_failure"]);
});
