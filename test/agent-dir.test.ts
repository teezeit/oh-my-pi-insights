// SPDX-FileCopyrightText: 2026 Tobias Hoelzer (omp port)
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { resolveAgentDir } from "../index.ts";

const HOME = "/Users/example";

test("resolveAgentDir defaults to ~/.omp/agent with no profile env set", () => {
	assert.equal(resolveAgentDir({}, HOME), join(HOME, ".omp", "agent"));
});

test("resolveAgentDir treats the literal 'default' profile as the default profile", () => {
	assert.equal(
		resolveAgentDir({ OMP_PROFILE: "default" }, HOME),
		join(HOME, ".omp", "agent"),
	);
});

test("resolveAgentDir honors PI_CODING_AGENT_DIR for the default profile", () => {
	assert.equal(
		resolveAgentDir({ PI_CODING_AGENT_DIR: "/custom/agent-dir" }, HOME),
		"/custom/agent-dir",
	);
});

test("resolveAgentDir resolves a named OMP_PROFILE under ~/.omp/profiles/<name>/agent", () => {
	assert.equal(
		resolveAgentDir({ OMP_PROFILE: "work" }, HOME),
		join(HOME, ".omp", "profiles", "work", "agent"),
	);
});

test("resolveAgentDir falls back to PI_PROFILE when OMP_PROFILE is unset", () => {
	assert.equal(
		resolveAgentDir({ PI_PROFILE: "work" }, HOME),
		join(HOME, ".omp", "profiles", "work", "agent"),
	);
});

test("resolveAgentDir prefers OMP_PROFILE over PI_PROFILE", () => {
	assert.equal(
		resolveAgentDir({ OMP_PROFILE: "a", PI_PROFILE: "b" }, HOME),
		join(HOME, ".omp", "profiles", "a", "agent"),
	);
});

test("resolveAgentDir ignores PI_CODING_AGENT_DIR for a named profile", () => {
	assert.equal(
		resolveAgentDir({ OMP_PROFILE: "work", PI_CODING_AGENT_DIR: "/custom/agent-dir" }, HOME),
		join(HOME, ".omp", "profiles", "work", "agent"),
	);
});
