// SPDX-FileCopyrightText: 2026 Hari Srinivasan <harisrini21@gmail.com>
// SPDX-FileCopyrightText: 2026 Tobias Hoelzer (omp port)
// SPDX-License-Identifier: AGPL-3.0-only


// Model calls shell out to `omp -p` (see README "How model calls work"):
// omp hands extensions credentials but no completion client, so this
// inherits every provider dialect and auth scheme omp supports instead of
// reimplementing them.

import { execFile as execFileCb } from "node:child_process";

// The omp binary this extension shells out to for model calls. Overridable so
// a non-PATH install still works.
export const OMP_BIN = process.env.OMP_INSIGHTS_OMP_BIN || "omp";
export const MODEL_CALL_TIMEOUT_MS = 300_000;

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
 *
 * `--no-session` keeps these calls out of the session corpus this report
 * reads, and `--no-tools --no-extensions --no-skills` keeps them from doing
 * anything but answering.
 */
export async function callModel(
	prompt: string,
	opts: { model?: string; timeoutMs?: number } = {},
): Promise<string> {
	const args = ["--no-session", "--no-tools", "--no-extensions", "--no-skills", "--no-title"];
	if (opts.model) args.push("--model", opts.model);
	args.push("-p");

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

export function parseJsonFromResponse(text: string): unknown {
	const match = text.match(/\{[\s\S]*\}/);
	if (!match) return null;
	try {
		return JSON.parse(match[0]);
	} catch {
		return null;
	}
}
