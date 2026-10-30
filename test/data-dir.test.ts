// SPDX-FileCopyrightText: 2026 Tobias Hoelzer (omp port)
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { migrateLegacyDataDir } from "../index.ts";

let root: string;

before(async () => {
	root = await mkdtemp(join(tmpdir(), "omp-insights-datadir-"));
});

after(async () => {
	await rm(root, { recursive: true, force: true });
});

async function freshAgentDir(name: string): Promise<string> {
	const dir = join(root, name);
	await mkdir(dir, { recursive: true });
	return dir;
}

test("migrates a legacy usage-data folder when omp-insights does not exist", async () => {
	const agentDir = await freshAgentDir("legacy-only");
	await mkdir(join(agentDir, "usage-data", "session-meta"), { recursive: true });
	await writeFile(join(agentDir, "usage-data", "session-meta", "x.json"), '{"a":1}', "utf-8");
	await writeFile(join(agentDir, "usage-data", "report.html"), "<html>old</html>", "utf-8");

	const result = await migrateLegacyDataDir(agentDir);
	assert.equal(result, "migrated");

	const meta = await readFile(join(agentDir, "omp-insights", "session-meta", "x.json"), "utf-8");
	assert.equal(meta, '{"a":1}');
	const report = await readFile(join(agentDir, "omp-insights", "report.html"), "utf-8");
	assert.equal(report, "<html>old</html>");

	await assert.rejects(readFile(join(agentDir, "usage-data", "report.html"), "utf-8"));
});

test("leaves both folders untouched when both exist", async () => {
	const agentDir = await freshAgentDir("both-exist");
	await mkdir(join(agentDir, "usage-data"), { recursive: true });
	await writeFile(join(agentDir, "usage-data", "marker.txt"), "legacy", "utf-8");
	await mkdir(join(agentDir, "omp-insights"), { recursive: true });
	await writeFile(join(agentDir, "omp-insights", "marker.txt"), "new", "utf-8");

	const result = await migrateLegacyDataDir(agentDir);
	assert.equal(result, "none");

	assert.equal(await readFile(join(agentDir, "usage-data", "marker.txt"), "utf-8"), "legacy");
	assert.equal(await readFile(join(agentDir, "omp-insights", "marker.txt"), "utf-8"), "new");
});

test("does nothing when neither folder exists", async () => {
	const agentDir = await freshAgentDir("neither");

	const result = await migrateLegacyDataDir(agentDir);
	assert.equal(result, "none");

	await assert.rejects(readFile(join(agentDir, "omp-insights", "marker.txt"), "utf-8"));
	await assert.rejects(readFile(join(agentDir, "usage-data", "marker.txt"), "utf-8"));
});

test("a second call after a successful migration is a no-op", async () => {
	const agentDir = await freshAgentDir("twice");
	await mkdir(join(agentDir, "usage-data"), { recursive: true });
	await writeFile(join(agentDir, "usage-data", "marker.txt"), "legacy", "utf-8");

	const first = await migrateLegacyDataDir(agentDir);
	assert.equal(first, "migrated");

	const second = await migrateLegacyDataDir(agentDir);
	assert.equal(second, "none");

	assert.equal(await readFile(join(agentDir, "omp-insights", "marker.txt"), "utf-8"), "legacy");
});

test("a failing rename resolves to none instead of throwing", async () => {
	// agentDir itself is a file, not a directory: any rename targeting a path
	// under it fails (ENOTDIR), simulating a race or permission error.
	const agentDir = join(root, "agent-is-a-file");
	await writeFile(agentDir, "not a directory", "utf-8");

	const result = await migrateLegacyDataDir(agentDir);
	assert.equal(result, "none");
});
