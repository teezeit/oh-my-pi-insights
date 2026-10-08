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
		memory_backend: "off",
		autolearn_enabled: false,
		...overrides,
	};
}

// B8: the features reference is built from live state, not a hardcoded Pi-shaped list.

test("buildFeaturesReference: no memory backend enabled (off, the default) says how to enable one", () => {
	const ref = buildFeaturesReference(ctx());
	assert.match(ref, /no memory backend is enabled/i);
	assert.match(ref, /memory\.backend/i);
	assert.match(ref, /local.*hindsight.*mnemopi/is);
	assert.doesNotMatch(ref, /\blearn tool\b/i);
});

test("buildFeaturesReference: local backend describes memory://root, not retain/recall", () => {
	const ref = buildFeaturesReference(ctx({ memory_backend: "local" }));
	assert.match(ref, /memory:\/\/root/i);
	assert.doesNotMatch(ref, /\bretain\b/i);
	assert.doesNotMatch(ref, /\blearn tool\b/i);
});

test("buildFeaturesReference: mnemopi backend describes retain/recall/reflect/memory_edit, not the learn tool", () => {
	const ref = buildFeaturesReference(
		ctx({ memory_backend: "mnemopi", installed_skills: ["landing-webapp-backend-change"] }),
	);
	assert.match(ref, /retain/i);
	assert.match(ref, /recall/i);
	assert.match(ref, /memory_edit/i);
	assert.doesNotMatch(ref, /\blearn tool\b/i);
});

test("buildFeaturesReference: learn/manage_skill are only mentioned when autolearn is on", () => {
	const autolearnOff = buildFeaturesReference(ctx({ memory_backend: "mnemopi" }));
	assert.doesNotMatch(autolearnOff, /\blearn tool\b/i);
	assert.doesNotMatch(autolearnOff, /manage_skill/i);

	const autolearnOn = buildFeaturesReference(ctx({ memory_backend: "mnemopi", autolearn_enabled: true }));
	assert.match(autolearnOn, /\blearn tool\b/i);
	assert.match(autolearnOn, /manage_skill/i);

	// Off backend: manage_skill does not need a backend, but the learn tool does.
	const offWithAutolearn = buildFeaturesReference(ctx({ autolearn_enabled: true }));
	assert.doesNotMatch(offWithAutolearn, /\blearn tool\b/i);
	assert.match(offWithAutolearn, /manage_skill/i);
});

// Suggestions naming an unavailable feature or an installed skill (name or
// close match) must be dropped before render.

test("filterSuggestions drops a learn-tool suggestion when autolearn is off", () => {
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

test("filterSuggestions drops a retain/recall suggestion when the backend is off or local", () => {
	const suggestion = {
		features_to_try: [
			{
				feature: "Memory (mnemopi: retain/recall)",
				one_liner: "record durable facts",
				why_for_you: "you repeat yourself across sessions",
				example: "retain that the deploy key lives in 1Password",
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
	for (const backend of ["off", "local"]) {
		const filtered = filterSuggestions(suggestion, ctx({ memory_backend: backend }));
		assert.deepEqual(
			filtered.features_to_try!.map((f) => f.feature),
			["Subagents (task tool)"],
		);
	}
});

test("filterSuggestions drops a suggestion naming an already-installed skill (close match)", () => {
	const userCtx = ctx({
		installed_managed_skills: ["orchestrating-webapp-ticket-wave-with-orca-omp-workers"],
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
	const userCtx = ctx({ installed_managed_skills: ["landing-webapp-backend-change"] });
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
