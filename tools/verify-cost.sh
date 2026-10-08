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

# Cost lives in exactly two record shapes:
#   {"type":"model_usage", "usage":{"cost":{"total":N}}}          out-of-band calls
#   {"type":"message","message":{"role":"assistant","usage":{"cost":{"total":N}}}}
COST_FILTER='def c: if type!="object" then 0
  elif (.usage|type)=="object" and ((.usage.cost|type)=="object") and ((.usage.cost.total|type)=="number") then .usage.cost.total
  elif (.message|type)=="object" and ((.message.usage|type)=="object") and ((.message.usage.cost|type)=="object") and ((.message.usage.cost.total|type)=="number") then .message.usage.cost.total
  else 0 end;
map(c)|add // 0'

sum_cost() { jq -s "$COST_FILTER" "$1"; }

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

while IFS=$'\t' read -r path signature sidecars; do
	sessions=$((sessions + 1))
	primary_total="$(jq -n --argjson a "$primary_total" --argjson b "$(sum_cost "$path")" '$a + $b')"

	IFS='|' read -r -a sidecar_paths <<<"${sidecars}"
	live_sidecars=()
	for sidecar in "${sidecar_paths[@]}"; do
		[ -n "$sidecar" ] || continue
		live_sidecars+=("$sidecar")
		cost="$(sum_cost "$sidecar")"
		if [ "$(basename "$sidecar")" = "__advisor.jsonl" ]; then
			advisor_files=$((advisor_files + 1))
			advisor_total="$(jq -n --argjson a "$advisor_total" --argjson b "$cost" '$a + $b')"
		else
			subagent_files=$((subagent_files + 1))
			subagent_total="$(jq -n --argjson a "$subagent_total" --argjson b "$cost" '$a + $b')"
		fi
	done

	recorded_sizes="$(printf '%s' "$signature" | tr '|' '\n' | sed 's/^[^=]*=//; s/:.*$//' | paste -sd'|' -)"
	if [ "$(sizes_of "$path" "${live_sidecars[@]+"${live_sidecars[@]}"}")" != "$recorded_sizes" ]; then
		drifted=$((drifted + 1))
		echo "DRIFT: $path changed since the report was generated" >&2
	fi
done < <(jq -r '.sessions[] | [.path, .log_signature, (.sidecars | join("|"))] | @tsv' "$MANIFEST")

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
