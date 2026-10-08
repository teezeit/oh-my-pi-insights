// SPDX-FileCopyrightText: 2026 Tobias Hoelzer (omp port)
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { readProviderAuth } from "../src/auth.ts";

// Why: the pinned @types/node predates node:sqlite; a variable specifier keeps tsc from resolving it.
type FixtureDb = { exec(sql: string): void; prepare(sql: string): { run(...args: string[]): void }; close(): void };
const { DatabaseSync } = (await import("node:sqlite" as string)) as { DatabaseSync: new (path: string) => FixtureDb };

async function makeAgentDb(dir: string, rows: Array<{ provider: string; credential_type: string }>): Promise<string> {
	const dbPath = join(dir, "agent.db");
	const db = new DatabaseSync(dbPath);
	db.exec(
		"CREATE TABLE auth_credentials (provider TEXT PRIMARY KEY, credential_type TEXT, credential_data TEXT)",
	);
	const insert = db.prepare(
		"INSERT INTO auth_credentials (provider, credential_type, credential_data) VALUES (?, ?, ?)",
	);
	for (const row of rows) insert.run(row.provider, row.credential_type, "secret");
	db.close();
	return dbPath;
}

test("maps oauth to subscription and api_key-like types to api_key, ignoring mcp_oauth rows", async () => {
	const dir = await mkdtemp(join(tmpdir(), "omp-insights-auth-"));
	try {
		const dbPath = await makeAgentDb(dir, [
			{ provider: "anthropic", credential_type: "oauth" },
			{ provider: "github-copilot", credential_type: "oauth" },
			{ provider: "openai", credential_type: "api_key" },
			{ provider: "mcp_oauth:some-server", credential_type: "oauth" },
		]);

		const auth = await readProviderAuth(dbPath);

		assert.deepEqual(auth, {
			anthropic: "subscription",
			"github-copilot": "subscription",
			openai: "api_key",
		});
	} finally {
		await rm(dir, { recursive: true });
	}
});

test("recognizes key-like credential_type variants as api_key", async () => {
	const dir = await mkdtemp(join(tmpdir(), "omp-insights-auth-"));
	try {
		const dbPath = await makeAgentDb(dir, [
			{ provider: "mistral", credential_type: "apikey" },
			{ provider: "google", credential_type: "api-key" },
			{ provider: "unknown-thing", credential_type: "something-else" },
		]);

		const auth = await readProviderAuth(dbPath);

		assert.deepEqual(auth, {
			mistral: "api_key",
			google: "api_key",
		});
	} finally {
		await rm(dir, { recursive: true });
	}
});

test("missing agent.db returns an empty map, never throws", async () => {
	const dir = await mkdtemp(join(tmpdir(), "omp-insights-auth-"));
	try {
		const auth = await readProviderAuth(join(dir, "does-not-exist.db"));
		assert.deepEqual(auth, {});
	} finally {
		await rm(dir, { recursive: true });
	}
});
