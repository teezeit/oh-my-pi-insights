// SPDX-FileCopyrightText: 2026 Tobias Hoelzer (omp port)
// SPDX-License-Identifier: AGPL-3.0-only


// The inline <script> in the HTML report is a classic script, not a
// module: `export function foo() {}` at top level is a SyntaxError there,
// which silently breaks every copy button. This runs the extracted script
// body in a real vm context with minimal DOM stubs to catch that class of
// regression, instead of only grepping the source for the word "export".

import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
import { aggregateData, computeTemporalData, generateHTML } from "../index.ts";
import { meta } from "./helpers.ts";

function extractScripts(html: string): string[] {
	return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
}

function makeStubButton(textContent: string) {
	return {
		textContent,
		previousElementSibling: null as { textContent: string } | null,
	};
}

function runInSandbox(script: string) {
	const clipboardWrites: string[] = [];
	const timeouts: Array<() => void> = [];
	const sandbox: Record<string, unknown> = {
		document: {
			getElementById: () => null,
			querySelectorAll: () => [],
		},
		navigator: {
			clipboard: {
				writeText: (text: string) => {
					clipboardWrites.push(text);
					return Promise.resolve();
				},
			},
		},
		setTimeout: (fn: () => void) => {
			timeouts.push(fn);
			return 0;
		},
		window: {},
	};
	vm.createContext(sandbox);
	vm.runInContext(script, sandbox);
	return { sandbox, clipboardWrites, timeouts };
}

test("every inline <script> in the HTML report is valid classic-script syntax with no top-level export", () => {
	const metas = [meta({ session_id: "s1" })];
	const agg = aggregateData(metas, new Map());
	const temporal = computeTemporalData(metas, new Map());
	const html = generateHTML(agg, {}, {}, temporal);

	const scripts = extractScripts(html);
	assert.ok(scripts.length >= 1, "expected at least one inline <script>");
	for (const script of scripts) {
		assert.ok(!/\bexport\s+function\b/.test(script), "classic script must not use `export`; it is a SyntaxError outside a module");
		assert.doesNotThrow(() => runInSandbox(script), "inline script must be valid classic-script syntax");
	}
});

test("copyText, copyFromBox and copyAllConfig are callable functions after running the script, and copyFromBox copies the preceding box's text", () => {
	const metas = [meta({ session_id: "s1" })];
	const agg = aggregateData(metas, new Map());
	const temporal = computeTemporalData(metas, new Map());
	const html = generateHTML(agg, {}, {}, temporal);
	const scripts = extractScripts(html);
	const { sandbox, clipboardWrites } = runInSandbox(scripts.join("\n"));

	assert.equal(typeof sandbox.copyText, "function");
	assert.equal(typeof sandbox.copyFromBox, "function");
	assert.equal(typeof sandbox.copyAllConfig, "function");

	const box = { textContent: "the copied text" };
	const btn = makeStubButton("Copy rule");
	btn.previousElementSibling = box;
	(sandbox.copyFromBox as (btn: unknown) => void)(btn);
	assert.deepEqual(clipboardWrites, ["the copied text"]);
});
