// SPDX-FileCopyrightText: 2026 Tobias Hoelzer (omp port)
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { gatherHarnessSnapshot, gatherUserContext } from "../index.ts";

// Regression for GitHub issue #10: omp loads skills from ~/.agents/skills,
// ~/.claude/skills and project-level roots, not just <agentDir>/skills and
// <agentDir>/managed-skills. ~/.claude/skills entries are commonly symlinks
// into ~/.agents/skills (see omp://skills.md), so a skill reachable only
// through a symlinked directory must count too.

let agentDir: string;
let home: string;
let cwd: string;

before(async () => {
	agentDir = await mkdtemp(join(tmpdir(), "omp-insights-skills-agent-"));
	home = await mkdtemp(join(tmpdir(), "omp-insights-skills-home-"));
	cwd = await mkdtemp(join(tmpdir(), "omp-insights-skills-cwd-"));

	// A skill authored directly under ~/.agents/skills.
	await mkdir(join(home, ".agents", "skills", "foo"), { recursive: true });
	await writeFile(join(home, ".agents", "skills", "foo", "SKILL.md"), "---\nname: foo\n---\nFoo skill.\n", "utf-8");

	// A skill reachable only through a symlink, mirroring how
	// ~/.claude/skills/<name> is commonly a symlink into ~/.agents/skills on
	// a real machine.
	await mkdir(join(home, "skill-source", "baz"), { recursive: true });
	await writeFile(join(home, "skill-source", "baz", "SKILL.md"), "---\nname: baz\n---\nBaz skill.\n", "utf-8");
	await mkdir(join(home, ".claude", "skills"), { recursive: true });
	await symlink(join(home, "skill-source", "baz"), join(home, ".claude", "skills", "baz"), "dir");
});

after(async () => {
	await rm(agentDir, { recursive: true, force: true });
	await rm(home, { recursive: true, force: true });
	await rm(cwd, { recursive: true, force: true });
});

test("gatherHarnessSnapshot discovers skills under ~/.agents/skills and a symlinked ~/.claude/skills entry", async () => {
	const snap = await gatherHarnessSnapshot(agentDir, home, cwd);
	assert.ok(snap.skills.includes("foo"), `expected skills to include "foo", got ${JSON.stringify(snap.skills)}`);
	assert.ok(snap.skills.includes("baz"), `expected skills to include "baz", got ${JSON.stringify(snap.skills)}`);
});

test("gatherUserContext discovers skills under ~/.agents/skills and a symlinked ~/.claude/skills entry", async () => {
	const ctx = await gatherUserContext(home, cwd);
	assert.ok(
		ctx.installed_skills.includes("foo"),
		`expected installed_skills to include "foo", got ${JSON.stringify(ctx.installed_skills)}`,
	);
	assert.ok(
		ctx.installed_skills.includes("baz"),
		`expected installed_skills to include "baz", got ${JSON.stringify(ctx.installed_skills)}`,
	);
});
