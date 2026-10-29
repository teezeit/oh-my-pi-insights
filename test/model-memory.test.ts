// SPDX-FileCopyrightText: 2026 Tobias Hoelzer (omp port)
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { buildModelArgs, getMemoryOffConfigPath } from "../src/model.ts";

// `callModel` shells out to a child `omp -p`. That child must never recall or
// retain long-term memory (mnemopi), and should not load hooks/context files
// it does not need to answer a self-contained prompt.

test("buildModelArgs disables memory via a per-run --config overlay", () => {
	const args = buildModelArgs({});
	const configIdx = args.indexOf("--config");
	assert.notEqual(configIdx, -1, "expected a --config overlay flag");
	const overlayPath = args[configIdx + 1];
	assert.ok(overlayPath, "expected a path after --config");
	assert.match(overlayPath as string, /\.ya?ml$/);
});

test("the --config overlay file sets memory.backend to off", () => {
	const overlayPath = getMemoryOffConfigPath();
	const contents = readFileSync(overlayPath, "utf8");
	assert.match(contents, /backend:\s*off/);
});

test("buildModelArgs also disables context files and rules for the child", () => {
	const args = buildModelArgs({});
	assert.ok(args.includes("--no-context-files"));
	assert.ok(args.includes("--no-rules"));
});

test("buildModelArgs keeps the existing lockdown flags and model/print placement", () => {
	const args = buildModelArgs({ model: "anthropic/claude-haiku-4-5" });
	for (const flag of ["--no-session", "--no-tools", "--no-extensions", "--no-skills", "--no-title"]) {
		assert.ok(args.includes(flag), `expected ${flag}`);
	}
	assert.ok(args.includes("--model"));
	assert.equal(args[args.indexOf("--model") + 1], "anthropic/claude-haiku-4-5");
	assert.equal(args[args.length - 1], "-p");
});

test("getMemoryOffConfigPath is memoized to one file per process", () => {
	const a = getMemoryOffConfigPath();
	const b = getMemoryOffConfigPath();
	assert.equal(a, b);
});
