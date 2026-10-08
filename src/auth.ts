// SPDX-FileCopyrightText: 2026 Tobias Hoelzer (omp port)
// SPDX-License-Identifier: AGPL-3.0-only


// Reads per-provider credential type (OAuth vs API key) from omp's own
// agent.db, so cost can be split into "subscription" (API list-price
// equivalent, paid for by a plan) vs "billed" (actually charged per call).
// Read-only, and only ever touches the two columns it needs: never the
// credential data column, which may hold a token or key material.

/** Maps a row's (provider, credential_type) to the coarse auth bucket this tool cares about, or null to ignore the row. */
function mapCredentialType(provider: string, credentialType: string): "subscription" | "api_key" | null {
	// Why: mcp_oauth:* rows are per-MCP-server credentials, not LLM provider
	// auth, and would otherwise collide with a real provider's own entry.
	if (provider.startsWith("mcp_oauth:")) return null;
	const ct = credentialType.toLowerCase();
	if (ct === "oauth") return "subscription";
	if (ct === "api_key" || ct === "apikey" || ct.includes("key")) return "api_key";
	return null;
}

type Row = { provider: unknown; credential_type: unknown };

// Why: bun:sqlite has no types under Node; a variable specifier keeps tsc from
// resolving it, and this minimal shape covers the one call made.
type BunSqlite = { Database: new (path: string, opts: { readonly: boolean }) => { query(sql: string): { all(): unknown[] }; close(): void } };
const BUN_SQLITE = "bun:sqlite";

/**
 * Reads `provider`/`credential_type` out of `auth_credentials` in omp's
 * agent.db (path supplied by the caller, typically
 * `join(resolveAgentDir(...), "agent.db")`). omp is a compiled Bun binary
 * but this extension's tests run under Node, so both drivers are tried in
 * order: `node:sqlite` (Node >= 22.5, experimental) then `bun:sqlite`. Any
 * failure (missing file, missing table, no driver available) returns an
 * empty map, which reads downstream as "unknown" auth for every provider,
 * never as a false "subscription" or "api_key".
 */
export async function readProviderAuth(agentDb: string): Promise<Record<string, "subscription" | "api_key">> {
	let rows: Row[] | null = null;

	try {
		// Exception: platform-specific module, only present under Node;
		// static import would throw at module-load time when run inside
		// omp's Bun binary, which has no "node:sqlite".
		const { DatabaseSync } = await import("node:sqlite");
		const db = new DatabaseSync(agentDb, { readOnly: true });
		try {
			rows = db.prepare("SELECT provider, credential_type FROM auth_credentials").all() as Row[];
		} finally {
			db.close();
		}
	} catch {
		rows = null;
	}

	if (rows === null) {
		try {
			// Exception: platform-specific module, only present under Bun;
			// static import would fail typecheck/resolution under Node,
			// which has no "bun:sqlite" module.
			const { Database } = (await import(BUN_SQLITE)) as BunSqlite;
			const db = new Database(agentDb, { readonly: true });
			try {
				rows = db.query("SELECT provider, credential_type FROM auth_credentials").all() as Row[];
			} finally {
				db.close();
			}
		} catch {
			rows = null;
		}
	}

	if (rows === null) return {};

	const out: Record<string, "subscription" | "api_key"> = {};
	for (const row of rows) {
		if (typeof row.provider !== "string" || typeof row.credential_type !== "string") continue;
		const mapped = mapCredentialType(row.provider, row.credential_type);
		if (mapped !== null) out[row.provider] = mapped;
	}
	return out;
}
