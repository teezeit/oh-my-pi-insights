// SPDX-FileCopyrightText: 2026 Hari Srinivasan <harisrini21@gmail.com>
// SPDX-FileCopyrightText: 2026 Tobias Hoelzer (omp port)
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "../index.ts";

// The terminal-UI contract: a run narrates itself through ctx.ui and must
// always tear the widget down, including when it fails. Print mode stubs
// setWidget to a no-op, so none of this is exercised by a `-p` run.
//
// Isolation: index.ts derives ~/.omp/agent from os.homedir() in module-level
// constants, so $HOME is redirected BEFORE the dynamic import. Everything the
// command reads and writes lands in a temp directory, never the real corpus.

type UiCall = { method: string; args: unknown[] };

let home: string;
// The host is faked structurally, so the registrar is typed by what this
// test supplies rather than by the extension's own ExtensionAPI.
let extension: { default: (pi: ExtensionAPI) => void };

const SID = "00000000-0000-7000-8000-000000000001";

function fakeHost(ui: UiCall[]) {
	let handler:
		| ((args: string | undefined, ctx: ExtensionCommandContext) => Promise<void> | void)
		| null = null;
	const commands: string[] = [];
	const pi: ExtensionAPI = {
		registerCommand(name, spec) {
			commands.push(name);
			handler = spec.handler;
		},
	};
	const ctx = {
		cwd: "/tmp",
		model: { id: "claude-opus-5", provider: "anthropic" },
		sessionManager: { getSessionId: () => "not-a-real-session" },
		ui: {
			notify: (...args: unknown[]) => ui.push({ method: "notify", args }),
			setStatus: (...args: unknown[]) => ui.push({ method: "setStatus", args }),
			setWidget: (...args: unknown[]) => ui.push({ method: "setWidget", args }),
		},
	};
	return { pi, ctx, commands, run: (args: string) => handler?.(args, ctx as ExtensionCommandContext) };
}

before(async () => {
	home = await mkdtemp(join(tmpdir(), "omp-insights-home-"));
	const sessions = join(home, ".omp", "agent", "sessions", "-proj");
	await mkdir(sessions, { recursive: true });

	const ts = (m: number) => new Date(Date.UTC(2026, 8, 1, 9, m)).toISOString();
	const assistant = (at: number, cost: number) => ({
		type: "message",
		timestamp: ts(at),
		message: {
			role: "assistant",
			model: "claude-opus-5",
			usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: cost } },
			content: [],
			timestamp: Date.UTC(2026, 8, 1, 9, at),
		},
	});
	const human = (at: number, text: string) => ({
		type: "message",
		timestamp: ts(at),
		message: {
			role: "user",
			attribution: "user",
			content: [{ type: "text", text }],
			timestamp: Date.UTC(2026, 8, 1, 9, at),
		},
	});

	await writeFile(
		join(sessions, `2026-09-01T09-00-00-000Z_${SID}.jsonl`),
		[
			{ type: "session", version: 3, id: SID, timestamp: ts(0), cwd: "/proj" },
			human(0, "first ask"),
			assistant(2, 1.25),
			human(10, "second ask"),
			assistant(12, 0.75),
		]
			.map((e) => `${JSON.stringify(e)}\n`)
			.join(""),
	);

	process.env.HOME = home;
	// Dynamic by necessity, not preference: index.ts resolves ~/.omp/agent
	// from homedir() in module-level constants, so the module must not load
	// until $HOME points at the fixture corpus above.
	const loaded: unknown = await import("../index.ts");
	extension = loaded as { default: (pi: ExtensionAPI) => void };
});

after(async () => {
	await rm(home, { recursive: true, force: true });
});

test("registers the /insights command", () => {
	const host = fakeHost([]);
	extension.default(host.pi);
	assert.deepEqual(host.commands, ["insights"]);
});

test("a run narrates phases and clears its widget", async () => {
	const ui: UiCall[] = [];
	const host = fakeHost(ui);
	extension.default(host.pi);

	await host.run("--md --no-open --no-llm");

	const widgets = ui.filter((c) => c.method === "setWidget");
	const rendered = widgets
		.map((c) => (Array.isArray(c.args[1]) ? (c.args[1] as string[]).join("\n") : ""))
		.join("\n");

	assert.match(rendered, /Phase 1\/5: Scanning session files/);
	assert.match(rendered, /Phase 2\/5/);
	assert.match(rendered, /Phase 5\/5: Rendering report/);

	// Every widget write is keyed, so it can be cleared.
	assert.ok(widgets.every((c) => c.args[0] === "insights"));

	// Teardown: the status line is emptied and the widget removed, or the
	// progress block is left stuck on screen after the command returns.
	const last = ui.filter((c) => c.method === "setWidget").at(-1);
	assert.deepEqual(last?.args, ["insights", undefined]);
	assert.deepEqual(
		ui.filter((c) => c.method === "setStatus").at(-1)?.args,
		["insights", ""],
	);

	const notice = ui.filter((c) => c.method === "notify").at(-1);
	assert.match(String(notice?.args[0]), /Markdown report saved/);
	assert.equal(notice?.args[1], "success");
});

test("the run writes a report over the fixture corpus", async () => {
	const host = fakeHost([]);
	extension.default(host.pi);
	await host.run("--md --no-open --no-llm");

	const report = await readFile(
		join(home, ".omp", "agent", "usage-data", "report.md"),
		"utf-8",
	);
	assert.match(report, /# omp Insights/);
	assert.match(report, /\| Total Cost \| \$2\.00 \|/);

	const manifest = JSON.parse(
		await readFile(join(home, ".omp", "agent", "usage-data", "session-set.json"), "utf-8"),
	) as { totals: { cost: number; sessions: number }; sessions: Array<{ session_id: string }> };
	assert.equal(manifest.totals.sessions, 1);
	assert.equal(manifest.totals.cost, 2);
	assert.equal(manifest.sessions[0]?.session_id, SID);
});

test("a failing run still tears the widget down", async () => {
	const ui: UiCall[] = [];
	const host = fakeHost(ui);
	extension.default(host.pi);

	// setWidget throwing stands in for any mid-run failure; the handler's
	// catch must still clear the status line and notify, not leave the UI
	// wedged with a half-finished progress block.
	let thrown = false;
	const ctx = host.ctx as { ui: { setWidget: (...a: unknown[]) => void } };
	const original = ctx.ui.setWidget;
	ctx.ui.setWidget = (...args: unknown[]) => {
		if (!thrown) {
			thrown = true;
			throw new Error("terminal went away");
		}
		original(...args);
	};

	await host.run("--md --no-open --no-llm");

	assert.deepEqual(ui.filter((c) => c.method === "setWidget").at(-1)?.args, [
		"insights",
		undefined,
	]);
	const notice = ui.filter((c) => c.method === "notify").at(-1);
	assert.match(String(notice?.args[0]), /Insights failed: terminal went away/);
	assert.equal(notice?.args[1], "error");
});
