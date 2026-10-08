// SPDX-FileCopyrightText: 2026 Hari Srinivasan <harisrini21@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildFeaturesReference, filterSuggestions, type UserContext } from "../index.ts";

function ctx(overrides: Partial<UserContext> = {}): UserContext {
	return {
		existing_agents_md_rules: [],
		installed_skills: [],
		installed_managed_skills: [],
		installed_extensions: [],
		installed_hooks: [],
		mcp_servers: [],
		model_roles: {},
		fallback_chains: {},
		default_model: "",
		config_yml_flat: {},
		memory_backend: "learn",
		...overrides,
	};
}

// B8: the features reference is built from live state, not a hardcoded Pi-shaped list.

test("buildFeaturesReference describes the learn tool when memory.backend is unset", () => {
	const ref = buildFeaturesReference(ctx());
	assert.match(ref, /learn tool/i);
	assert.doesNotMatch(ref, /retain\/recall/i);
});

test("buildFeaturesReference describes retain/recall when memory.backend is mnemopi", () => {
	const ref = buildFeaturesReference(
		ctx({ memory_backend: "mnemopi", installed_skills: ["landing-peach-backend-change"] }),
	);
	assert.match(ref, /retain/i);
	assert.match(ref, /recall/i);
	assert.doesNotMatch(ref, /\blearn tool\b/i);
});

// Suggestions naming an unavailable feature or an installed skill (name or
// close match) must be dropped before render.

test("filterSuggestions drops a learn-tool suggestion when the backend is mnemopi", () => {
	const userCtx = ctx({ memory_backend: "mnemopi" });
	const suggestions = {
		features_to_try: [
			{
				feature: "Memory (learn tool)",
				one_liner: "record durable facts",
				why_for_you: "you repeat yourself across sessions",
				example: "learn that the deploy key lives in 1Password",
				evidence_sessions: ["s1", "s2"],
			},
			{
				feature: "Subagents (task tool)",
				one_liner: "parallel research",
				why_for_you: "you map unfamiliar code a lot",
				example: "task(...)",
				evidence_sessions: ["s1", "s2"],
			},
		],
	};
	const filtered = filterSuggestions(suggestions, userCtx);
	assert.deepEqual(
		filtered.features_to_try!.map((f) => f.feature),
		["Subagents (task tool)"],
	);
});

test("filterSuggestions drops a suggestion naming an already-installed skill (close match)", () => {
	const userCtx = ctx({
		installed_managed_skills: ["orchestrating-peach-ticket-wave-with-orca-omp-workers"],
	});
	const suggestions = {
		usage_patterns: [
			{
				title: "Ticket kickoff skill",
				suggestion: "Create a ticket-kickoff skill",
				detail: "A skill that starts a ticket wave",
				copyable_prompt: "make a ticket-kickoff skill",
				evidence_sessions: ["s1", "s2"],
			},
			{
				title: "Batch your reviews",
				suggestion: "Review PRs in one sitting",
				detail: "Switching contexts per PR costs you ramp-up time",
				copyable_prompt: "review all open PRs now",
				evidence_sessions: ["s1", "s2"],
			},
		],
	};
	const filtered = filterSuggestions(suggestions, userCtx);
	assert.deepEqual(
		filtered.usage_patterns!.map((p) => p.title),
		["Batch your reviews"],
	);
});

test("filterSuggestions keeps unrelated skill suggestions", () => {
	const userCtx = ctx({ installed_managed_skills: ["landing-peach-backend-change"] });
	const suggestions = {
		stop_doing: [
			{
				what: "Manually diffing PR comments",
				why: "slow",
				alternative: "use the reviewer skill",
				evidence_sessions: ["s1", "s2"],
			},
		],
	};
	const filtered = filterSuggestions(suggestions, userCtx);
	assert.equal(filtered.stop_doing!.length, 1);
});
