// SPDX-FileCopyrightText: 2026 Tobias Hoelzer (omp port)
// SPDX-License-Identifier: AGPL-3.0-only


// Shared text helpers for the HTML and Markdown renderers: emoji
// stripping (no decorative icons anywhere in the report, LLM text
// included), the title-fallback chain for advice items (contract T), and
// copy-button labeling so every "Copy" button says what it copies.

const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/gu;

/** Strip every emoji/pictograph codepoint from `s`, collapsing the extra
 * spacing left behind. Applied to all rendered text, chrome and LLM
 * sections alike, since a model can emit an emoji headline as easily as
 * a hand-written one. */
export function stripEmoji(s: string): string {
	return s.replace(EMOJI_RE, "").replace(/ {2,}/g, " ").trim();
}

/**
 * Contract T: config_additions, features_to_try, usage_patterns,
 * stop_doing and friction_analysis.ongoing items may carry an optional
 * `title`. When a cached section predates the contract (no title field),
 * fall back to the item's existing short field, then to the first
 * sentence of the long text cut at ~10 words.
 */
export function itemTitle(title: string | undefined, shortField: string | undefined, longText: string): string {
	if (title) return title;
	if (shortField) return shortField;
	const sentenceMatch = longText.match(/^[^.!?]*[.!?]/);
	const sentence = (sentenceMatch ? sentenceMatch[0] : longText).trim();
	const words = sentence.split(/\s+/).filter(Boolean);
	return words.length <= 10 ? words.join(" ") : `${words.slice(0, 10).join(" ")}\u2026`;
}

/** Title for a config_addition. Why: a cached item without `title` would
 * otherwise fall back to its addition text, and a YAML or code snippet makes
 * an unreadable heading; name the target file instead. */
export function configAdditionTitle(c: { title?: string; addition: string; where: string }): string {
	if (c.title) return c.title;
	const looksLikeCode = /\n/.test(c.addition.trim()) || /^\s*[\w.-]+:\s/.test(c.addition);
	return looksLikeCode ? `Change in ${c.where}` : itemTitle(undefined, undefined, c.addition);
}

/** Drop a dedupe placeholder ("See Friction for details.") instead of
 * rendering it as if it were real content; src/postprocess.ts writes this
 * into a why/detail field when it suppresses a cross-section duplicate. */
export function isFillerText(s: string | undefined): boolean {
	return !!s && /^See .+ for details\.$/.test(s.trim());
}

export type CopyKind = "rule" | "config" | "hook" | "prompt" | "command";

const COPY_LABELS: Record<CopyKind, string> = {
	rule: "Copy rule",
	config: "Copy config",
	hook: "Copy hook spec",
	prompt: "Copy prompt",
	command: "Copy command",
};

export function copyLabel(kind: CopyKind): string {
	return COPY_LABELS[kind];
}

/** `where` classification for a config_addition's copy-button label and
 * meta chip: anything under hooks/ -> hook spec, AGENTS.md/RULES.md ->
 * rule, config.yml (or anything else, since it still targets some file)
 * -> config. */
export function copyKindForWhere(where: string): CopyKind {
	if (/hooks\//.test(where)) return "hook";
	if (/AGENTS\.md|RULES\.md/i.test(where)) return "rule";
	return "config";
}

/** First ~100 chars of copied text, for a copy button's `title` tooltip. */
export function copyTooltip(text: string): string {
	const t = text.trim();
	return t.length > 100 ? `${t.slice(0, 100)}\u2026` : t;
}
