#!/usr/bin/env bash
# Runs every automated check for BuilderGPT: typecheck plus the test suites.
#
#   typecheck   tsc over main/preload/shared, svelte-check over the renderer
#   hello       smallest possible proof the QuickJS/WASM sandbox loads
#   smoke       end-to-end pipeline: JS build script -> blocks, .schem -> GLB
#   sandbox     RULEBOOK.md section 3 containment guarantees
#   services    main-process services, incl. the schematic write/read round-trip
#   schematics  Sponge v2/v3 and MCEdit all decode to the same voxel grid
#   blocks      block geometry: shapes, culling, texture orientation
#   document    the mutable schematic document: palette, resize, revision
#   history     transactions, undo/redo, and the N-edits-N-undos property
#   formats     writing a document back out, round-tripped through the reader
#   session     the open document as the IPC handlers drive it
#   agent       the AI tool loop, driven by a scripted model
#
# Unlike build.sh, this does NOT stop at the first failure: a test runner that
# aborts early hides how much else is broken. Every suite runs, results are
# summarised, and the script exits non-zero if any of them failed.
#
# Usage:
#   scripts/check.sh

set -uo pipefail
# shellcheck source=scripts/_common.sh
. "$(dirname "${BASH_SOURCE[0]}")/_common.sh"
# _common.sh sets -e; deliberately turn it back off so one failing suite does
# not abort the rest of the run.
set +e

install_dependencies_if_missing

STEP_NAMES=(typecheck hello smoke sandbox services schematics blocks document history formats session agent)
STEP_SCRIPTS=(typecheck smoke:hello smoke smoke:sandbox smoke:services smoke:schematics smoke:blocks smoke:document smoke:history smoke:formats smoke:session smoke:agent)
STEP_RESULTS=()

# ASCII only, to stay readable in terminals that are not UTF-8.
SEPARATOR="-----------------------------"

failures=0
for i in "${!STEP_NAMES[@]}"; do
  write_step "${STEP_NAMES[$i]}"
  if run_npm run "${STEP_SCRIPTS[$i]}"; then
    STEP_RESULTS+=("ok")
  else
    STEP_RESULTS+=("FAIL")
    failures=$((failures + 1))
  fi
done

printf '\n%s\n' "$SEPARATOR"
for i in "${!STEP_NAMES[@]}"; do
  if [ "${STEP_RESULTS[$i]}" = "ok" ]; then
    printf '  %sok%s    %s\n' "$C_OK" "$C_OFF" "${STEP_NAMES[$i]}"
  else
    printf '  %sFAIL%s  %s\n' "$C_ERR" "$C_OFF" "${STEP_NAMES[$i]}"
  fi
done
printf '%s\n' "$SEPARATOR"

if [ "$failures" -gt 0 ]; then
  printf '\n%s%d check(s) failed.%s\n' "$C_ERR" "$failures" "$C_OFF"
  exit 1
fi

printf '\n%sAll checks passed.%s\n' "$C_OK" "$C_OFF"
