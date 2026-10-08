// SPDX-FileCopyrightText: 2026 Hari Srinivasan <harisrini21@gmail.com>
// SPDX-FileCopyrightText: 2026 Tobias Hoelzer (omp port)
// SPDX-License-Identifier: AGPL-3.0-only


// Reads the user's real omp surface (config.yml, skills, extensions, hooks,
// mcp.json, global instructions) so the report never suggests what already
// exists.

import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { AGENT_DIR } from "./cache.ts";
import type { UserContext } from "./types.ts";

export type YamlNode = { [k: string]: string | string[] | YamlNode };

export function unquoteYaml(v: string): string {
	const t = v.trim().replace(/\s+#.*$/, "").trim();
	if (
		(t.startsWith('"') && t.endsWith('"')) ||
		(t.startsWith("'") && t.endsWith("'"))
	)
		return t.slice(1, -1);
	return t;
}

/**
 * Minimal YAML-subset reader for ~/.omp/agent/config.yml: indented mappings,
 * `- ` scalar sequences, optionally quoted scalars.
 *
 * Why not a real YAML parser: the port takes no new runtime dependencies
 * (node builtins only), and the only consumers here are `modelRoles` and
 * `retry.fallbackChains` - both plain string maps and string lists.
 */
export function parseSimpleYaml(text: string): YamlNode {
	const root: YamlNode = {};
	const stack: Array<{ indent: number; node: YamlNode }> = [
		{ indent: -1, node: root },
	];
	let lastKey: { node: YamlNode; key: string } | null = null;

	for (const raw of text.split("\n")) {
		const trimmed = raw.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const indent = raw.search(/\S/);

		if (trimmed.startsWith("- ")) {
			if (!lastKey) continue;
			const existing = lastKey.node[lastKey.key];
			const item = unquoteYaml(trimmed.slice(2));
			if (Array.isArray(existing)) existing.push(item);
			else lastKey.node[lastKey.key] = [item];
			continue;
		}

		const colon = trimmed.indexOf(":");
		if (colon < 0) continue;
		const key = unquoteYaml(trimmed.slice(0, colon));
		const value = trimmed.slice(colon + 1).trim();

		while (stack.length > 1 && indent <= stack[stack.length - 1]!.indent)
			stack.pop();
		const parent = stack[stack.length - 1]!.node;

		if (!value) {
			const child: YamlNode = {};
			parent[key] = child;
			stack.push({ indent, node: child });
		} else {
			parent[key] = unquoteYaml(value);
		}
		lastKey = { node: parent, key };
	}
	return root;
}

export function yamlMap(node: YamlNode | undefined, key: string): YamlNode | undefined {
	const v = node?.[key];
	return v && !Array.isArray(v) && typeof v === "object" ? v : undefined;
}

/**
 * Flattens a parsed YAML tree into dotted-path -> scalar leaves
 * ("modelRoles.plan" -> "anthropic/claude-opus-5"). Arrays are dropped: a
 * sequence like a fallback chain isn't a single old -> new scalar, so it
 * has no sensible diff rendering in src/render/configDiff.ts.
 */
export function flattenYaml(node: YamlNode, prefix = ""): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(node)) {
		const path = prefix ? `${prefix}.${key}` : key;
		if (typeof value === "string") out[path] = value;
		else if (!Array.isArray(value)) Object.assign(out, flattenYaml(value, path));
	}
	return out;
}

export async function listDirNames(
	dir: string,
	kind: "dirs" | "files",
	exts: string[] = [],
): Promise<string[]> {
	try {
		const entries = await readdir(dir, { withFileTypes: true });
		return entries
			.filter((e) => (kind === "dirs" ? e.isDirectory() : !e.isDirectory()))
			.map((e) => e.name)
			.filter((n) => !n.startsWith("."))
			.filter((n) => !exts.length || exts.some((x) => n.endsWith(x)))
			.map((n) => (exts.length ? n.replace(/\.[^.]+$/, "") : n))
			.sort();
	} catch {
		return [];
	}
}

export async function gatherUserContext(): Promise<UserContext> {
	const ctx: UserContext = {
		existing_agents_md_rules: [],
		installed_skills: [],
		installed_managed_skills: [],
		installed_extensions: [],
		installed_hooks: [],
		mcp_servers: [],
		model_roles: {},
		fallback_chains: {},
		default_model: "",
		memory_backend: "off",
		autolearn_enabled: false,
		config_yml_flat: {},
	};

	// Global instructions. omp has no ~/.omp/agent/AGENTS.md; the user-level
	// identity file is ~/.claude/CLAUDE.md, and AGENTS.md files are per project.
	for (const file of [
		join(homedir(), ".claude", "CLAUDE.md"),
		join(AGENT_DIR, "AGENTS.md"),
	]) {
		try {
			const text = await readFile(file, "utf-8");
			for (const line of text.split("\n")) {
				const t = line.trim();
				if (t.length > 20 && t.length < 200 && /\b(always|never|do not|don't|must|require|forbid)\b/i.test(t)) {
					ctx.existing_agents_md_rules.push(t.slice(0, 150));
				}
			}
		} catch {}
	}
	ctx.existing_agents_md_rules = ctx.existing_agents_md_rules.slice(0, 20);

	// config.yml is YAML, not settings.json. The default model is a model role,
	// and retry.fallbackChains is the routing the report must not re-suggest.
	try {
		const cfg = parseSimpleYaml(await readFile(join(AGENT_DIR, "config.yml"), "utf-8"));
		ctx.config_yml_flat = flattenYaml(cfg);
		const roles = yamlMap(cfg, "modelRoles");
		if (roles) {
			for (const [role, model] of Object.entries(roles)) {
				if (typeof model === "string") ctx.model_roles[role] = model;
			}
			// Roles may alias another role with "@name" (e.g. tiny: "@smol").
			for (const [role, model] of Object.entries(ctx.model_roles)) {
				if (model.startsWith("@")) {
					const target = ctx.model_roles[model.slice(1)];
					if (target) ctx.model_roles[role] = target;
				}
			}
			ctx.default_model = ctx.model_roles.default ?? "";
		}
		const chains = yamlMap(yamlMap(cfg, "retry"), "fallbackChains");
		if (chains) {
			for (const [role, list] of Object.entries(chains)) {
				if (Array.isArray(list)) ctx.fallback_chains[role] = list;
			}
		}
		// Absent means no memory backend is enabled (memory.backend defaults to
		// "off"); an explicit override ("local", "hindsight" or "mnemopi")
		// changes what the features reference and filterSuggestions allow.
		const memory = yamlMap(cfg, "memory");
		const backend = memory?.backend;
		if (typeof backend === "string" && backend) ctx.memory_backend = backend;
		// The `learn`/`manage_skill` tools exist only when autolearn.enabled is
		// true (any backend for manage_skill; learn additionally needs a backend
		// other than "off", see memoryFeatureBlock in src/prompts.ts).
		const autolearn = yamlMap(cfg, "autolearn");
		ctx.autolearn_enabled = autolearn?.enabled === "true";
	} catch {}

	// Both skill dirs matter: a suggestion recommending an already-installed
	// skill is a bug, and most skills live under managed-skills/.
	ctx.installed_skills = await listDirNames(join(AGENT_DIR, "skills"), "dirs");
	ctx.installed_managed_skills = await listDirNames(join(AGENT_DIR, "managed-skills"), "dirs");
	ctx.installed_extensions = await listDirNames(join(AGENT_DIR, "extensions"), "files", [".ts", ".js"]);

	try {
		const events = await readdir(join(AGENT_DIR, "hooks"), { withFileTypes: true });
		for (const event of events) {
			if (!event.isDirectory()) continue;
			const hooks = await listDirNames(join(AGENT_DIR, "hooks", event.name), "files");
			for (const h of hooks) ctx.installed_hooks.push(`${event.name}/${h}`);
		}
	} catch {}

	try {
		const mcp = JSON.parse(await readFile(join(AGENT_DIR, "mcp.json"), "utf-8")) as {
			mcpServers?: Record<string, unknown>;
			servers?: Record<string, unknown>;
		};
		ctx.mcp_servers = Object.keys(mcp.mcpServers ?? mcp.servers ?? {}).sort();
	} catch {}

	return ctx;
}
