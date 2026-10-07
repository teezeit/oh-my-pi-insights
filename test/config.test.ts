// SPDX-FileCopyrightText: 2026 Hari Srinivasan <harisrini21@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate as nextTick } from "node:timers/promises";
import { createLimiter, parseSimpleYaml, resolveLimit } from "../index.ts";

// parseSimpleYaml is hand-rolled because the port takes no new dependencies.
// The shapes below are the ones ~/.omp/agent/config.yml actually contains.

test("reads nested mappings and scalar sequences", () => {
	const cfg = parseSimpleYaml(`modelRoles:
  advisor: github-copilot/gpt-5.4-mini
  default: anthropic/claude-opus-5
  tiny: "@smol"
retry:
  modelFallback: true
  fallbackChains:
    default:
      - anthropic/claude-opus-5
      - github-copilot/gpt-5.6-terra
    tiny:
      - anthropic/claude-haiku-4-5
symbolPreset: unicode
`);

	assert.deepEqual(cfg.modelRoles, {
		advisor: "github-copilot/gpt-5.4-mini",
		default: "anthropic/claude-opus-5",
		tiny: "@smol",
	});
	assert.deepEqual((cfg.retry as Record<string, unknown>).fallbackChains, {
		default: ["anthropic/claude-opus-5", "github-copilot/gpt-5.6-terra"],
		tiny: ["anthropic/claude-haiku-4-5"],
	});
	// A sibling key after a nested block must land back at the root, not inside it.
	assert.equal(cfg.symbolPreset, "unicode");
});

test("dedents out of a sequence back to the correct parent", () => {
	const cfg = parseSimpleYaml(`a:
  chains:
    one:
      - x
      - y
  after: kept
b: root
`);
	const a = cfg.a as Record<string, unknown>;
	assert.deepEqual((a.chains as Record<string, unknown>).one, ["x", "y"]);
	assert.equal(a.after, "kept");
	assert.equal(cfg.b, "root");
});

test("strips quotes, trailing comments and blank or comment lines", () => {
	const cfg = parseSimpleYaml(`
# leading comment
theme: 'light'    # inline comment

quoted: "with spaces"
`);
	assert.equal(cfg.theme, "light");
	assert.equal(cfg.quoted, "with spaces");
});

test("a value containing a colon keeps everything after the first one", () => {
	// Model ids and URLs both hit this: splitting on the last colon would truncate.
	const cfg = parseSimpleYaml("plan: anthropic/claude-opus-5:auto\n");
	assert.equal(cfg.plan, "anthropic/claude-opus-5:auto");
});

test("resolveLimit prefers the flag, then the env var, then the default", () => {
	assert.equal(resolveLimit("--max-sessions 12", "max-sessions", "NOPE_UNSET", 99), 12);
	assert.equal(resolveLimit("--max-sessions=12", "max-sessions", "NOPE_UNSET", 99), 12);
	assert.equal(resolveLimit("", "max-sessions", "NOPE_UNSET", 99), 99);

	process.env.OMP_INSIGHTS_TEST_LIMIT = "7";
	try {
		assert.equal(resolveLimit("", "max-sessions", "OMP_INSIGHTS_TEST_LIMIT", 99), 7);
		// An explicit flag still wins over the environment.
		assert.equal(resolveLimit("--max-sessions 3", "max-sessions", "OMP_INSIGHTS_TEST_LIMIT", 99), 3);
		// Junk in the environment must not silently become a zero cap.
		process.env.OMP_INSIGHTS_TEST_LIMIT = "not-a-number";
		assert.equal(resolveLimit("", "max-sessions", "OMP_INSIGHTS_TEST_LIMIT", 99), 99);
		process.env.OMP_INSIGHTS_TEST_LIMIT = "0";
		assert.equal(resolveLimit("", "max-sessions", "OMP_INSIGHTS_TEST_LIMIT", 99), 99);
	} finally {
		delete process.env.OMP_INSIGHTS_TEST_LIMIT;
	}
});

// Why: every model call is a full `omp -p` process (~450 MB RSS). Nested
// fan-out (facet batch x transcript chunks) once spawned hundreds at once and
// exhausted RAM, so the limiter must cap in-flight work across nested callers.
test("createLimiter caps in-flight tasks, including nested fan-out", async () => {
	const limit = createLimiter(3);
	let inFlight = 0;
	let peak = 0;
	const task = () =>
		limit(async () => {
			inFlight++;
			peak = Math.max(peak, inFlight);
			await nextTick();
			inFlight--;
			return 1;
		});
	// 10 outer jobs, each fanning out to 5 chunk calls then one final call.
	const results = await Promise.all(
		Array.from({ length: 10 }, async () => {
			const chunks = await Promise.all(Array.from({ length: 5 }, task));
			return chunks.length + (await task());
		}),
	);
	assert.equal(peak, 3);
	assert.deepEqual(results, Array(10).fill(6));

	// A rejected task must release its slot, or the run deadlocks.
	await assert.rejects(limit(() => Promise.reject(new Error("boom"))));
	assert.equal(await limit(async () => "after"), "after");
});
