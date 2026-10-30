# SPDX-FileCopyrightText: 2026 Tobias Hoelzer (omp port)
# SPDX-License-Identifier: AGPL-3.0-only

#!/usr/bin/env bash
# Reconcile the report's total cost against the session logs with jq.
#
# Reads ~/.omp/agent/usage-data/session-set.json (written by /insights), sums
# usage.cost.total independently over every included primary log AND its
# __advisor.jsonl / subagent sidecars, and compares the result with the totals
# the report claimed. Also verifies each log's size:mtime still matches the
# signature recorded at run time, so a live session growing between the run and
# this check cannot be mistaken for a counting bug.
set -euo pipefail

MANIFEST="${1:-$HOME/.omp/agent/usage-data/session-set.json}"

TMPDIR_VC="$(mktemp -d "${TMPDIR:-/tmp}/verify-cost.XXXXXX")"
trap 'rm -rf "$TMPDIR_VC"' EXIT
IDS_CACHE_DIR="$TMPDIR_VC/ids"
mkdir -p "$IDS_CACHE_DIR"

# Cost lives in exactly two record shapes:
#   {"type":"model_usage", "usage":{"cost":{"total":N}}}          out-of-band calls
#   {"type":"message","message":{"role":"assistant","usage":{"cost":{"total":N}}}}
# Records whose id is a key in $excl[0] are fork-copied duplicates (see
# resolveForkExcludedIds/resolveForkSidecarExcludedIds in src/sources/omp.ts)
# and are dropped from the sum the same way the scanner drops them, instead
# of being double-counted.
COST_FILTER='def c: if type!="object" then 0
  elif (.usage|type)=="object" and ((.usage.cost|type)=="object") and ((.usage.cost.total|type)=="number") then .usage.cost.total
  elif (.message|type)=="object" and ((.message.usage|type)=="object") and ((.message.usage.cost|type)=="object") and ((.message.usage.cost.total|type)=="number") then .message.usage.cost.total
  else 0 end;
def excluded: (type == "object") and ((.id|type) == "string") and (($excl[0][.id] // false));
reduce .[] as $e (0; if ($e|excluded) then . else . + ($e|c) end)'

# ids-file (one id per line) -> JSON object {id: true, ...}, the shape
# COST_FILTER's $excl expects. A missing/empty file yields {} (nothing
# excluded), so every call site can pass a not-yet-created path.
ids_to_json() {
	local src="$1" dest="$2"
	if [ -s "$src" ]; then
		jq -R -s 'split("\n") | map(select(length > 0)) | reduce .[] as $x ({}; .[$x] = true)' "$src" >"$dest"
	else
		printf '{}' >"$dest"
	fi
}

sum_cost() {
	# $1 = jsonl file, $2 = ids-file of ids to exclude (optional, may not exist)
	local excl_json="$TMPDIR_VC/excl_arg.json"
	ids_to_json "${2:-/dev/null}" "$excl_json"
	jq -s --slurpfile excl "$excl_json" "$COST_FILTER" "$1"
}

# Cache: file path -> sorted list of its non-null string .id values. Keyed by
# a cksum of the path so the same ancestor log/sidecar is only parsed once
# across the whole run, even when several forks share it.
get_ids_cached() {
	local file="$1"
	local key cache
	key="$(printf '%s' "$file" | cksum | tr -d ' ')"
	cache="$IDS_CACHE_DIR/$key"
	if [ ! -f "$cache" ]; then
		jq -r 'select(type == "object" and (.id|type) == "string") | .id' "$file" >"$cache" 2>/dev/null || : >"$cache"
	fi
	cat "$cache"
}

# sessions_dir: prefer the manifest's own record of where it scanned (so a
# manifest from a fixture tree or a --since run resolves ancestors from the
# same tree), else the default omp install.
SESSIONS_DIR_VC="$(jq -r '.sessions_dir // empty' "$MANIFEST")"
[ -n "$SESSIONS_DIR_VC" ] || SESSIONS_DIR_VC="$HOME/.omp/agent/sessions"

# id -> primary log path, for every top-level session under sessions_dir (not
# just the ones in this manifest: a fork's ancestor can fall outside the
# manifest's --since window). Mirrors findSessionPath in src/sources/omp.ts:
# only direct children of each project dir are candidates, named
# "<ts>_<id>.jsonl".
SESSION_INDEX="$TMPDIR_VC/session_index.tsv"
: >"$SESSION_INDEX"
if [ -d "$SESSIONS_DIR_VC" ]; then
	while IFS= read -r f; do
		base="$(basename "$f" .jsonl)"
		id="${base#*_}"
		printf '%s\t%s\n' "$id" "$f" >>"$SESSION_INDEX"
	done < <(find -L "$SESSIONS_DIR_VC" -mindepth 2 -maxdepth 2 -type f -name '*.jsonl' 2>/dev/null)
fi

find_session_path() {
	awk -F'\t' -v id="$1" '$1 == id { print $2; exit }' "$SESSION_INDEX"
}

header_parent_session() {
	# The first {"type":"session"} record's parentSession, or empty.
	jq -r 'select(.type == "session") | (.parentSession // empty)' "$1" 2>/dev/null | head -n1
}

# Walks the fork ancestor chain of $1 (a primary log path; see
# resolveForkExcludedIds/resolveForkSidecarExcludedIds in src/sources/omp.ts)
# and writes:
#   $2 - ids-file of every ancestor primary record's id (primary exclusions)
#   $3 - a directory of ids-files, one per sidecar relative path (cksum-named),
#        the union of every ancestor's ids at that same relative sidecar path
resolve_fork_exclusions() {
	local path="$1" primary_out="$2" sidecar_dir="$3"
	: >"$primary_out"
	rm -rf "$sidecar_dir"
	mkdir -p "$sidecar_dir"

	local visited="$TMPDIR_VC/visited.$$"
	: >"$visited"
	local parent_id parent_path parent_sidecar_dir safe
	parent_id="$(header_parent_session "$path")"

	# `parentSession` has carried two shapes across omp versions: a bare
	# session id (older logs; resolved via find_session_path, a directory
	# walk) and the parent's absolute log path (current logs; usable
	# directly). Both mark a real fork; only the lookup strategy differs
	# (mirrors resolveForkExcludedIds in src/sources/omp.ts).
	while [ -n "$parent_id" ]; do
		grep -qxF "$parent_id" "$visited" 2>/dev/null && break
		printf '%s\n' "$parent_id" >>"$visited"

		if [ "${parent_id#*/}" != "$parent_id" ]; then
			parent_path="$parent_id"
		else
			parent_path="$(find_session_path "$parent_id")"
		fi
		[ -n "$parent_path" ] && [ -f "$parent_path" ] || break

		get_ids_cached "$parent_path" >>"$primary_out"

		parent_sidecar_dir="${parent_path%.jsonl}"
		if [ -d "$parent_sidecar_dir" ]; then
			while IFS= read -r sc; do
				safe="$(printf '%s' "${sc#"$parent_sidecar_dir"/}" | cksum | tr -d ' ')"
				get_ids_cached "$sc" >>"$sidecar_dir/$safe"
			done < <(find -L "$parent_sidecar_dir" -type f -name '*.jsonl' 2>/dev/null)
		fi

		parent_id="$(header_parent_session "$parent_path")"
	done
	rm -f "$visited"
}

sizes_of() {
	# Byte sizes of the primary log then each sidecar, in scanner order. Session
	# logs are append-only, so a size match is enough to prove the bytes behind
	# the report are the bytes summed here; the recorded mtime is not compared
	# because its sub-millisecond precision differs between stat and node.
	local out
	local size
	# Portable file size: wc -c works everywhere
	size=$(wc -c <"$1" | tr -d ' ')
	out="$size"
	shift
	for sidecar in "$@"; do
		size=$(wc -c <"$sidecar" | tr -d ' ')
		out+="|$size"
	done
	printf '%s' "$out"
}

primary_total=0
advisor_total=0
subagent_total=0
advisor_files=0
subagent_files=0
drifted=0
sessions=0
primary_costs="$TMPDIR_VC/primary_costs.txt"
advisor_costs="$TMPDIR_VC/advisor_costs.txt"
subagent_costs="$TMPDIR_VC/subagent_costs.txt"
: >"$primary_costs"
: >"$advisor_costs"
: >"$subagent_costs"

while IFS=$'\t' read -r session_id path signature sidecars; do
	sessions=$((sessions + 1))

	primary_excl="$TMPDIR_VC/primary_excl.$$"
	sidecar_excl_dir="$TMPDIR_VC/sidecar_excl.$$"
	resolve_fork_exclusions "$path" "$primary_excl" "$sidecar_excl_dir"

	sum_cost "$path" "$primary_excl" >>"$primary_costs"

	IFS='|' read -r -a sidecar_paths <<<"${sidecars}"
	live_sidecars=()
	for sidecar in "${sidecar_paths[@]+"${sidecar_paths[@]}"}"; do
		[ -n "$sidecar" ] || continue
		live_sidecars+=("$sidecar")

		# Relative name within the session's own sidecar dir, keyed off the
		# "<ts>_<session_id>/" path component rather than stripping the
		# literal .path prefix: a cached meta's .path can carry a stale
		# sessions_dir mount (e.g. after a symlink/mount change) while
		# .sidecars is freshly rescanned, so the two prefixes can legitimately
		# differ even though they resolve to the same file. Fork dedupe is by
		# record id, never by path identity (see src/sources/omp.ts), so the
		# exclusion lookup must not depend on path-prefix equality either.
		relname="${sidecar#*_"${session_id}"/}"
		safe="$(printf '%s' "$relname" | cksum | tr -d ' ')"

		if [ "$(basename "$sidecar")" = "__advisor.jsonl" ]; then
			advisor_files=$((advisor_files + 1))
			sum_cost "$sidecar" "$sidecar_excl_dir/$safe" >>"$advisor_costs"
		else
			subagent_files=$((subagent_files + 1))
			sum_cost "$sidecar" "$sidecar_excl_dir/$safe" >>"$subagent_costs"
		fi
	done

	rm -f "$primary_excl"
	rm -rf "$sidecar_excl_dir"

	recorded_sizes="$(printf '%s' "$signature" | tr '|' '\n' | sed 's/^[^=]*=//; s/:.*$//' | paste -sd'|' -)"
	if [ "$(sizes_of "$path" "${live_sidecars[@]+"${live_sidecars[@]}"}")" != "$recorded_sizes" ]; then
		drifted=$((drifted + 1))
		echo "DRIFT: $path changed since the report was generated" >&2
	fi
done < <(jq -r '.sessions[] | [.session_id, .path, .log_signature, (.sidecars | join("|"))] | @tsv' "$MANIFEST")

primary_total="$(jq -s 'add // 0' "$primary_costs")"
advisor_total="$(jq -s 'add // 0' "$advisor_costs")"
subagent_total="$(jq -s 'add // 0' "$subagent_costs")"

jq -n \
	--argjson reported "$(jq '.totals' "$MANIFEST")" \
	--argjson sessions "$sessions" \
	--argjson primary "$primary_total" \
	--argjson advisor "$advisor_total" \
	--argjson subagent "$subagent_total" \
	--argjson advisors "$advisor_files" \
	--argjson subagents "$subagent_files" \
	--argjson drifted "$drifted" '
	{
		sessions_checked: $sessions,
		logs_changed_since_run: $drifted,
		jq: {
			primary: $primary,
			advisor: $advisor,
			subagent: $subagent,
			total: ($primary + $advisor + $subagent),
		},
		report: {
			primary: $reported.cost_primary,
			advisor: $reported.cost_advisor,
			subagent: $reported.cost_subagent,
			total: $reported.cost,
		},
		advisor_sidecars_summed: $advisors,
		subagent_sidecars_summed: $subagents,
		delta: {
			primary: (($primary - $reported.cost_primary) | fabs),
			advisor: (($advisor - $reported.cost_advisor) | fabs),
			subagent: (($subagent - $reported.cost_subagent) | fabs),
			total: ((($primary + $advisor + $subagent) - $reported.cost) | fabs),
		},
		# 1e-6 USD: the two sums add the same doubles in a different order, so
		# only float association can differ, never a counted record.
		match: ((((($primary + $advisor + $subagent) - $reported.cost) | fabs) < 0.000001) and ($drifted == 0)),
	}'
