// SPDX-FileCopyrightText: 2026 Hari Srinivasan <harisrini21@gmail.com>
// SPDX-FileCopyrightText: 2026 Tobias Hoelzer (omp port)
// SPDX-License-Identifier: AGPL-3.0-only


// Model calls shell out to `omp -p` (see README "How model calls work"):
// omp hands extensions credentials but no completion client, so this
// inherits every provider dialect and auth scheme omp supports instead of
// reimplementing them.

import { execFile as execFileCb } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The omp binary this extension shells out to for model calls. Overridable so
// a non-PATH install still works.
export const OMP_BIN = process.env.OMP_INSIGHTS_OMP_BIN || "omp";
export const MODEL_CALL_TIMEOUT_MS = 300_000;

// `omp -p` has no flag to turn off long-term memory recall/retention
// (mnemopi), so the child's memory backend is switched off per-run with a
// `--config` overlay instead: `omp config list` confirms `memory.backend`
// accepts `off` alongside `local|hindsight|mnemopi|sharpshooter`, and
// `--config=<value>` ("Load an extra config.yml-style overlay for this run")
// applies it without touching the user's `~/.omp/agent/config.yml`. Without
// this the child inherited the user's `memory.backend: mnemopi` and retained
// the facet-extraction prompt into the project's memory bank, which then
// leaked into unrelated sessions.
let memoryOffConfigPath: string | undefined;

/** Path to a one-off `--config` overlay that sets `memory.backend: off`. */
export function getMemoryOffConfigPath(): string {
	if (memoryOffConfigPath) return memoryOffConfigPath;
	const dir = mkdtempSync(join(tmpdir(), "omp-insights-memoff-"));
	const path = join(dir, "memory-off.yml");
	writeFileSync(path, "memory:\n  backend: off\n");
	memoryOffConfigPath = path;
	return path;
}

/**
 * argv for the `omp -p` child `callModel` spawns. Pulled out as a pure
 * function so the lockdown flags are testable without spawning a process.
 *
 * `--no-session` keeps these calls out of the session corpus this report
 * reads; `--no-tools --no-extensions --no-skills` keep the child from doing
 * anything but answering; `--no-context-files --no-rules` keep it from
 * loading AGENTS.md/CLAUDE.md or repo rules it does not need, since the
 * facet/section/synthesis prompts are fully self-contained. There is no
 * documented flag to disable hooks or MCP servers for a single `-p` run, so
 * those still load (a child may print MCP connection warnings to stderr,
 * which `callModel` ignores on success); this is unrelated to the memory
 * leak and left as-is.
 */
export function buildModelArgs(opts: { model?: string }): string[] {
	const args = [
		"--no-session",
		"--no-tools",
		"--no-extensions",
		"--no-skills",
		"--no-context-files",
		"--no-rules",
		"--no-title",
		"--config",
		getMemoryOffConfigPath(),
	];
	if (opts.model) args.push("--model", opts.model);
	args.push("-p");
	return args;
}

/**
 * omp hands extensions credentials (`ctx.modelRegistry.getApiKeyAndHeaders`)
 * but no completion client, so this shells out to omp itself instead of
 * reimplementing a provider client.
 *
 * Why a subprocess: `omp -p` already speaks every provider dialect and auth
 * scheme omp supports, including the OAuth-backed ones a fallback chain
 * reaches on a rate limit. An in-process HTTP client would have to own
 * anthropic-messages, openai-responses and github-copilot and would rot the
 * first time a model role moved. The prompt goes over stdin, not argv, so
 * transcript-sized prompts cannot hit an argument-length limit.
 * `--no-session` keeps these calls out of the session corpus this report
 * reads; `buildModelArgs` adds the rest of the lockdown flags (see its
 * doc comment), including the per-run memory-off overlay.
 */
export async function callModel(
	prompt: string,
	opts: { model?: string; timeoutMs?: number } = {},
): Promise<string> {
	const args = buildModelArgs({ model: opts.model });

	const child = execFileCb(
		OMP_BIN,
		args,
		{ maxBuffer: 32 * 1024 * 1024, timeout: opts.timeoutMs ?? MODEL_CALL_TIMEOUT_MS },
		() => {},
	);

	const stdout: string[] = [];
	const stderr: string[] = [];
	child.stdout?.on("data", (c: Buffer) => stdout.push(c.toString()));
	child.stderr?.on("data", (c: Buffer) => stderr.push(c.toString()));
	child.stdin?.end(prompt);

	const code = await new Promise<number>((resolve, reject) => {
		child.on("error", reject);
		child.on("close", (c) => resolve(c ?? -1));
	});

	const text = stdout.join("");
	if (code !== 0) {
		throw new Error(
			`omp -p exited ${code}: ${(stderr.join("") || text).trim().slice(0, 300)}`,
		);
	}
	// `omp -p` prints a progress line before the answer on a TTY-less run.
	return text.replace(/^Working\.\.\.\s*/, "").trim();
}

/**
 * Caps how many tasks run at once across every caller sharing the returned
 * function, nested ones included.
 *
 * Why: each callModel is a full `omp -p` process (~450 MB RSS). Facet batches
 * times per-session transcript chunks times parallel sections once spawned
 * hundreds of them and exhausted RAM. Batching only the outer loop cannot
 * bound the nested fan-out; one shared gate around the spawn can.
 */
export function createLimiter(max: number): <T>(task: () => Promise<T>) => Promise<T> {
	let active = 0;
	const waiting: Array<() => void> = [];
	return async (task) => {
		if (active >= max) {
			// The releasing task hands its slot over without decrementing, so a
			// newcomer cannot slip in between release and this waiter resuming.
			// Why the executor form: typecheck targets es2022, which lacks
			// Promise.withResolvers.
			await new Promise<void>((resolve) => waiting.push(resolve));
		} else {
			active++;
		}
		try {
			return await task();
		} finally {
			const next = waiting.shift();
			if (next) next();
			else active--;
		}
	};
}

export function parseJsonFromResponse(text: string): unknown {
	const match = text.match(/\{[\s\S]*\}/);
	if (!match) return null;
	try {
		return JSON.parse(match[0]);
	} catch {
		return null;
	}
}
