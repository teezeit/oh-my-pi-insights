// SPDX-FileCopyrightText: 2026 Hari Srinivasan <harisrini21@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
	detectHarnessChanges,
	gatherHarnessSnapshot,
	loadHarnessSnapshot,
	saveHarnessSnapshot,
	type HarnessSnapshot,
} from "../index.ts";

// Follow-up: config.yml.bak-* files are written by hand or by an agent, not
// by omp itself, so they are not a reliable change log. Instead a snapshot
// of the live harness state is persisted after each run and diffed against
// the next run's snapshot.

function snapshot(overrides: Partial<HarnessSnapshot> = {}): HarnessSnapshot {
	return {
		timestamp: "2026-09-01T00:00:00.000Z",
		config_hash: "hash-a",
		memory_backend: "learn",
		model_roles: { default: "anthropic/claude-opus-5" },
		skills: ["orca-cli"],
		hooks: ["pre/eval"],
		agents_md_hash: "agents-hash-a",
		...overrides,
	};
}

test("first run with no previous snapshot reports no changes", () => {
	assert.deepEqual(detectHarnessChanges(null, snapshot(), "2026-10-07"), []);
});

test("identical snapshots report no changes", () => {
	assert.deepEqual(detectHarnessChanges(snapshot(), snapshot(), "2026-10-07"), []);
});

test("detects a memory backend change, too_recent based on the PREVIOUS snapshot's timestamp", () => {
	const previous = snapshot({ timestamp: "2026-10-04T00:00:00.000Z", memory_backend: "learn" }); // 3 days before windowEnd
	const current = snapshot({ timestamp: "2026-10-07T00:00:00.000Z", memory_backend: "mnemopi" });
	const changes = detectHarnessChanges(previous, current, "2026-10-07");

	assert.equal(changes.length, 1);
	assert.equal(changes[0]!.type, "memory_backend");
	assert.equal(changes[0]!.too_recent, true);
	assert.match(changes[0]!.detail, /learn.*mnemopi/);
});

test("not too_recent when the previous snapshot is more than 7 days before window end", () => {
	const previous = snapshot({ timestamp: "2026-08-19T00:00:00.000Z", memory_backend: "learn" });
	const current = snapshot({ timestamp: "2026-10-07T00:00:00.000Z", memory_backend: "mnemopi" });
	const changes = detectHarnessChanges(previous, current, "2026-10-07");

	assert.equal(changes.length, 1);
	assert.equal(changes[0]!.too_recent, false);
});

test("detects a model role change", () => {
	const previous = snapshot({ model_roles: { default: "anthropic/claude-opus-5" } });
	const current = snapshot({ model_roles: { default: "anthropic/claude-sonnet-5" } });
	const changes = detectHarnessChanges(previous, current, "2026-10-07");

	assert.equal(changes.length, 1);
	assert.equal(changes[0]!.type, "model_roles_changed");
	assert.match(changes[0]!.detail, /default/);
});

test("detects a skill added and a skill removed", () => {
	const previous = snapshot({ skills: ["orca-cli", "old-skill"] });
	const current = snapshot({ skills: ["orca-cli", "new-skill"] });
	const changes = detectHarnessChanges(previous, current, "2026-10-07");

	assert.deepEqual(
		changes.map((c) => c.type).sort(),
		["skill_added", "skill_removed"],
	);
});

test("detects a hook added", () => {
	const previous = snapshot({ hooks: ["pre/eval"] });
	const current = snapshot({ hooks: ["pre/eval", "pre/format"] });
	const changes = detectHarnessChanges(previous, current, "2026-10-07");

	assert.equal(changes.length, 1);
	assert.equal(changes[0]!.type, "hook_added");
});

test("detects an AGENTS.md change", () => {
	const previous = snapshot({ agents_md_hash: "a" });
	const current = snapshot({ agents_md_hash: "b" });
	const changes = detectHarnessChanges(previous, current, "2026-10-07");

	assert.equal(changes.length, 1);
	assert.equal(changes[0]!.type, "agents_md_updated");
});

test("falls back to a generic config_changed when the hash differs but no tracked field does", () => {
	const previous = snapshot({ config_hash: "hash-a" });
	const current = snapshot({ config_hash: "hash-b" });
	const changes = detectHarnessChanges(previous, current, "2026-10-07");

	assert.equal(changes.length, 1);
	assert.equal(changes[0]!.type, "config_changed");
});

// ── Reader + persistence (temp dirs, never the real ~/.omp/agent) ──────────

let agentDir: string;
let dataDir: string;

before(async () => {
	agentDir = await mkdtemp(join(tmpdir(), "omp-insights-harness-agent-"));
	dataDir = await mkdtemp(join(tmpdir(), "omp-insights-harness-data-"));
});

after(async () => {
	await rm(agentDir, { recursive: true, force: true });
	await rm(dataDir, { recursive: true, force: true });
});

test("gatherHarnessSnapshot reads memory backend, model roles, skills, hooks and an AGENTS.md hash from the agent dir", async () => {
	await writeFile(
		join(agentDir, "config.yml"),
		"modelRoles:\n  default: anthropic/claude-opus-5\nmemory:\n  backend: mnemopi\n",
		"utf-8",
	);
	await mkdir(join(agentDir, "skills", "orca-cli"), { recursive: true });
	await mkdir(join(agentDir, "managed-skills", "landing-peach-backend-change"), { recursive: true });
	await mkdir(join(agentDir, "hooks", "pre"), { recursive: true });
	await writeFile(join(agentDir, "hooks", "pre", "eval.ts"), "", "utf-8");
	await writeFile(join(agentDir, "AGENTS.md"), "# rules\n", "utf-8");

	const snap = await gatherHarnessSnapshot(agentDir);

	assert.equal(snap.memory_backend, "mnemopi");
	assert.deepEqual(snap.model_roles, { default: "anthropic/claude-opus-5" });
	assert.deepEqual(snap.skills.sort(), ["landing-peach-backend-change", "orca-cli"]);
	assert.deepEqual(snap.hooks, ["pre/eval.ts"]);
	assert.ok(snap.config_hash.length > 0);
	assert.ok(snap.agents_md_hash && snap.agents_md_hash.length > 0);
});

test("gatherHarnessSnapshot defaults to learn / empty state when nothing is set up", async () => {
	const emptyAgentDir = await mkdtemp(join(tmpdir(), "omp-insights-harness-empty-"));
	try {
		const snap = await gatherHarnessSnapshot(emptyAgentDir);
		assert.equal(snap.memory_backend, "learn");
		assert.deepEqual(snap.model_roles, {});
		assert.deepEqual(snap.skills, []);
		assert.deepEqual(snap.hooks, []);
		assert.equal(snap.agents_md_hash, null);
		assert.equal(snap.config_hash, "");
	} finally {
		await rm(emptyAgentDir, { recursive: true, force: true });
	}
});

test("loadHarnessSnapshot returns null when no snapshot has been saved yet", async () => {
	const emptyDataDir = await mkdtemp(join(tmpdir(), "omp-insights-harness-nosnap-"));
	try {
		assert.equal(await loadHarnessSnapshot(emptyDataDir), null);
	} finally {
		await rm(emptyDataDir, { recursive: true, force: true });
	}
});

test("saveHarnessSnapshot then loadHarnessSnapshot round-trips", async () => {
	const snap = snapshot({ timestamp: "2026-10-08T00:00:00.000Z" });
	await saveHarnessSnapshot(dataDir, snap);
	assert.deepEqual(await loadHarnessSnapshot(dataDir), snap);
});
