// SPDX-FileCopyrightText: 2026 Hari Srinivasan <harisrini21@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildFeaturesReference, filterSuggestions, type UserContext } from "../index.ts";
import { aggregateData, buildFacts, buildSectionPrompts, buildSharedDataBlock, computeTemporalData, type AggregatedData } from "../index.ts";

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

// C2: interaction_style's prompt must spell out the blocks contract (3-4
// blocks of {title, body <= 60 words, evidence_sessions?} plus a one-sentence
// key_pattern), not the old single narrative field.

test("buildSectionPrompts: interaction_style prompt specifies the C2 blocks contract", () => {
	const agg = aggregateData([], new Map());
	const temporal = computeTemporalData([], new Map());
	const prompts = buildSectionPrompts("DATA", temporal, ctx(), agg);

	assert.match(prompts.interaction_style, /"blocks"/);
	assert.match(prompts.interaction_style, /"title"/);
	assert.match(prompts.interaction_style, /"body"/);
	assert.match(prompts.interaction_style, /evidence_sessions/);
	assert.match(prompts.interaction_style, /"key_pattern"/);
	assert.match(prompts.interaction_style, /3-4/);
	assert.match(prompts.interaction_style, /60 words/);
	assert.doesNotMatch(prompts.interaction_style, /"narrative"/);
	assert.doesNotMatch(prompts.interaction_style, /\*\*bold\*\*/);
});

// title field (<= 10 words, no trailing period) on each of the five item
// types that get it: suggestions' config_additions/features_to_try/
// usage_patterns/stop_doing, and friction_analysis.ongoing.
test("buildSectionPrompts: suggestions and friction_analysis prompts carry a title field for every suggestion item type", () => {
	const agg = aggregateData([], new Map());
	const temporal = computeTemporalData([], new Map());
	const prompts = buildSectionPrompts("DATA", temporal, ctx(), agg);

	const suggestionsTitleCount = (prompts.suggestions.match(/"title"/g) || []).length;
	assert.ok(suggestionsTitleCount >= 4, `expected a title field for config_additions, features_to_try, usage_patterns and stop_doing, got ${suggestionsTitleCount}`);
	assert.match(prompts.suggestions, /no emoji/i);
	assert.match(prompts.friction_analysis, /"title"/);
	assert.match(prompts.friction_analysis, /no emoji/i);
});

// model_efficiency: C1 (cost_by_provider/billed_cost/subscription_cost).
// Subscription-auth providers must never see a dollar-savings allowance;
// api_key-auth providers must.

function aggWithProviders(
	providers: Array<{ provider: string; cost: number; auth: "subscription" | "api_key" | "unknown" }>,
	billed_cost: number,
	subscription_cost: number,
): AggregatedData {
	const base = aggregateData([], new Map());
	return { ...base, cost_by_provider: providers, billed_cost, subscription_cost };
}

test("model_efficiency prompt forbids dollar savings for an all-subscription agg", () => {
	const agg = aggWithProviders([{ provider: "anthropic", cost: 12.5, auth: "subscription" }], 0, 12.5);
	const temporal = computeTemporalData([], new Map());
	const prompts = buildSectionPrompts("DATA", temporal, ctx(), agg);

	assert.match(prompts.model_efficiency, /NEVER quote a dollar savings figure/);
	assert.doesNotMatch(prompts.model_efficiency, /dollar savings claims are allowed/);
});

test("model_efficiency prompt allows dollar savings for an api_key agg", () => {
	const agg = aggWithProviders([{ provider: "openai", cost: 8.25, auth: "api_key" }], 8.25, 0);
	const temporal = computeTemporalData([], new Map());
	const prompts = buildSectionPrompts("DATA", temporal, ctx(), agg);

	assert.match(prompts.model_efficiency, /dollar savings claims are allowed/);
	assert.doesNotMatch(prompts.model_efficiency, /NEVER quote a dollar savings figure/);
});

test("shared data block says API-equivalent cost, not spend, when subscription_cost > 0", () => {
	const agg = aggWithProviders([{ provider: "anthropic", cost: 5, auth: "subscription" }], 0, 5);
	const temporal = computeTemporalData([], new Map());
	const facts = buildFacts(agg, temporal);
	const data = buildSharedDataBlock(agg, temporal, ctx(), facts);

	assert.match(data, /API-equivalent cost/);
	assert.match(data, /"billed_cost_usd": "0\.00"/);
	assert.match(data, /"subscription_cost_usd": "5\.00"/);
});
