// SPDX-FileCopyrightText: 2026 Tobias Hoelzer (omp port)
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { test } from "node:test";
import { dedupeIncidents, dedupeRecommendations, enforceBudget } from "../index.ts";
import { DEFAULT_WORD_BUDGETS, truncateAtSentence, truncateAtWord } from "../src/postprocess.ts";

// C12: the same incident (same evidence session id) written up in multiple
// sections collapses to one full write-up, in precedence order
// (friction_analysis.ongoing > suggestions.stop_doing > config_additions >
// features_to_try > usage_patterns); other occurrences become a reference.

test("dedupeIncidents keeps the friction write-up and replaces matching items elsewhere", () => {
	const sections = {
		friction_analysis: {
			ongoing: [
				{
					category: "Worktree reap",
					description: "the runner reaped a worktree mid-task, losing uncommitted edits.",
					examples: ["lost edits in session s1"],
					evidence_sessions: ["s1", "s2"],
				},
			],
		},
		suggestions: {
			stop_doing: [
				{ what: "Leaving worktrees idle", why: "the runner reaped one mid-task and lost edits.", alternative: "Commit before stepping away.", evidence_sessions: ["s1"] },
			],
			config_additions: [
				{ addition: "Add a pre-idle commit hook", why: "Same worktree-reap incident cost uncommitted work.", where: "AGENTS.md", evidence_sessions: ["s2", "s3"] },
			],
			features_to_try: [
				{ feature: "orca worktree keep-alive", one_liner: "x", why_for_you: "Prevents the reap that hit session s1.", example: "x", evidence_sessions: ["s4", "s5"] },
			],
		},
	};

	const result = dedupeIncidents(sections) as typeof sections;

	// Owning section (highest precedence: friction_analysis) keeps its full text.
	assert.equal(result.friction_analysis.ongoing[0]!.description, "the runner reaped a worktree mid-task, losing uncommitted edits.");
	assert.deepEqual(result.friction_analysis.ongoing[0]!.examples, ["lost edits in session s1"]);

	// stop_doing shares s1 with friction_analysis.ongoing: collapsed to a reference.
	assert.equal(result.suggestions.stop_doing[0]!.why, "See Friction for details.");
	// config_additions shares s2 with friction_analysis.ongoing: also collapsed, even
	// though it does not share s1.
	assert.equal(result.suggestions.config_additions[0]!.why, "See Friction for details.");
	// features_to_try cites s4/s5, which no higher-precedence item claimed: untouched.
	assert.equal(result.suggestions.features_to_try[0]!.why_for_you, "Prevents the reap that hit session s1.");
});

test("dedupeIncidents leaves two distinct incidents (no shared evidence id) both intact", () => {
	const sections = {
		friction_analysis: {
			ongoing: [
				{ category: "Worktree reap", description: "Incident A.", examples: [], evidence_sessions: ["s1", "s2"] },
				{ category: "Flaky CI", description: "Incident B.", examples: [], evidence_sessions: ["s3", "s4"] },
			],
		},
	};

	const result = dedupeIncidents(sections) as typeof sections;

	assert.equal(result.friction_analysis.ongoing[0]!.description, "Incident A.");
	assert.equal(result.friction_analysis.ongoing[1]!.description, "Incident B.");
});

// Recommendation dedupe: a code-assigned key (normalized title, plus `where`
// for config_additions), independent of evidence_sessions overlap.

test("dedupeRecommendations drops a config_addition restated as a feature_to_try", () => {
	const filtered = dedupeRecommendations({
		config_additions: [
			{ addition: "Use the ticket-kickoff skill", why: "w1", where: "AGENTS.md", evidence_sessions: ["s1", "s2"] },
		],
		features_to_try: [
			{ feature: "Use the ticket-kickoff skill", one_liner: "o", why_for_you: "w2", example: "e", evidence_sessions: ["s9", "s10"] },
		],
	});
	assert.equal(filtered.config_additions!.length, 1);
	assert.equal(filtered.features_to_try!.length, 0);
});

test("dedupeRecommendations keeps distinct recommendations", () => {
	const filtered = dedupeRecommendations({
		stop_doing: [
			{ what: "Stop retrying stale sessions", why: "w", alternative: "a", evidence_sessions: ["s1", "s2"] },
			{ what: "Stop calling the invented browser tool", why: "w", alternative: "a", evidence_sessions: ["s3", "s4"] },
		],
	});
	assert.equal(filtered.stop_doing!.length, 2);
});

// C13: field word budgets, one retry then truncate at a sentence boundary.

test("enforceBudget truncates an over-budget field at a sentence boundary after one retry", async () => {
	const longSentence = (n: string) => `This sentence about ${n} keeps right on going and going with a great deal of extra padding words placed here in order to reach well past the forty word limit quite easily indeed today.`;
	const overBudgetText = [longSentence("one"), longSentence("two"), longSentence("three")].join(" ");
	assert.ok(overBudgetText.split(/\s+/).length > 100, "fixture must start over 100 words");
	assert.ok(longSentence("one").split(/\s+/).length <= 40, "a single sentence must fit the budget on its own");

	const sections = {
		friction_analysis: {
			ongoing: [{ category: "c", description: overBudgetText, examples: [], evidence_sessions: [] }],
		},
	};

	let retryCalls = 0;
	const retry = async (text: string) => {
		retryCalls++;
		return text; // stub model call: still over budget both times it could be read.
	};

	const result = (await enforceBudget(
		sections,
		[{ section: "friction_analysis", arrayField: "ongoing", field: "description", maxWords: 40 }],
		retry,
	)) as typeof sections;

	assert.equal(retryCalls, 1, "retried exactly once, no loop");
	const description = result.friction_analysis.ongoing[0]!.description;
	assert.ok(description.split(/\s+/).length <= 40, `still over budget: ${description}`);
	// Truncated at a sentence boundary: only the first sentence survives a 40-word cap.
	assert.equal(description, longSentence("one"));
});

// title budget: maxWords=10, truncated at a word boundary with no ellipsis
// (a short label does not need one, and appending "..." would blow the
// 10-word cap back over the limit it exists to enforce).
test("enforceBudget truncates an 18-word title to 10 words with no ellipsis", async () => {
	const eighteenWordTitle = "Stop Retrying The Same Failing Tool Call Over And Over Without Asking First For Clarification From The User";
	assert.equal(eighteenWordTitle.split(/\s+/).length, 18, "fixture must start at 18 words");

	const sections = {
		suggestions: {
			stop_doing: [{ what: "w", why: "y", alternative: "a", title: eighteenWordTitle, evidence_sessions: [] }],
		},
	};

	const result = (await enforceBudget(
		sections,
		[{ section: "suggestions", arrayField: "stop_doing", field: "title", maxWords: 10, noEllipsis: true }],
	)) as typeof sections;

	const title = result.suggestions.stop_doing[0]!.title;
	assert.equal(title.split(/\s+/).length, 10);
	assert.equal(title, "Stop Retrying The Same Failing Tool Call Over And Over");
	assert.doesNotMatch(title, /\u2026|\.\.\.$/);
});

test("truncateAtWord cuts at a word boundary with no ellipsis", () => {
	assert.equal(truncateAtWord("one two three four five", 3), "one two three");
});

test("DEFAULT_WORD_BUDGETS includes a maxWords:10 title budget for each of the five item types", () => {
	const titleBudgets = DEFAULT_WORD_BUDGETS.filter((b) => b.field === "title");
	assert.equal(titleBudgets.length, 5);
	for (const budget of titleBudgets) {
		assert.equal(budget.maxWords, 10);
		assert.equal(budget.noEllipsis, true);
	}
});

test("enforceBudget leaves fields already within budget untouched and never calls retry", async () => {
	const sections = { what_works: { impressive_workflows: [{ title: "t", description: "Short and fine." }] } };
	let retryCalls = 0;
	await enforceBudget(
		sections,
		[{ section: "what_works", arrayField: "impressive_workflows", field: "description", maxWords: 40 }],
		async (text) => {
			retryCalls++;
			return text;
		},
	);
	assert.equal(retryCalls, 0);
});

// C2: interaction_style's blocks each get a 60-word body budget, truncating
// an over-long block to the longest whole-sentence prefix that fits.

test("enforceBudget truncates an over-budget interaction_style block body", async () => {
	const word = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");
	const longSentence = `${word(30)}.`;
	const overBudget = `${longSentence} ${word(30)}.`; // 60 words total, two sentences

	const sections = {
		interaction_style: {
			blocks: [{ title: "Delegation", body: overBudget, evidence_sessions: [] }],
			key_pattern: "fine",
		},
	};

	const result = (await enforceBudget(
		sections,
		[{ section: "interaction_style", arrayField: "blocks", field: "body", maxWords: 30 }],
	)) as typeof sections;

	assert.equal(result.interaction_style.blocks[0]!.body, longSentence);
});

test("truncateAtSentence keeps the start of a sentence containing decimals instead of dropping text before them", () => {
	const text = "The three slowest jobs in the batch all start from an empty template (a bare link or the default worker header) and run 120 to 140 steps at $10.25 to $12.75 each, with up to 30 lookups before the first write.";
	const out = truncateAtSentence(text, 40);
	assert.ok(out.startsWith("The three slowest jobs"), out);
	assert.ok(out.includes("$10.25"), out);
	// Whole sentences still win when they fit; a period inside a number is not a boundary.
	assert.equal(truncateAtSentence("It cost $1.50 today. Then more text follows here.", 4), "It cost $1.50 today.");
});
