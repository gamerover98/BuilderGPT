#!/usr/bin/env bash
# Shared helpers for the Schematic AI Studio shell scripts.
#
# Source this from build.sh / start.sh / check.sh. It is not meant to be run
# directly.
#
# The scripts are deliberately thin wrappers over the npm scripts in
# package.json: package.json stays the single source of truth for how the app is
# built and tested, and these just make it convenient to invoke from a shell,
# from any working directory, with dependencies bootstrapped.

set -euo pipefail

# BASH_SOURCE[0] is this file even when sourced, so the repo root resolves
# correctly no matter which script sourced it or where it was run from.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export REPO_ROOT

if [ -t 1 ]; then
  C_STEP=$'\033[36m'; C_OK=$'\033[32m'; C_ERR=$'\033[31m'; C_OFF=$'\033[0m'
else
  C_STEP=''; C_OK=''; C_ERR=''; C_OFF=''
fi

write_step() {
  printf '\n%s==> %s%s\n' "$C_STEP" "$1" "$C_OFF"
}

run_npm() {
  ( cd "$REPO_ROOT" && npm "$@" )
}

install_dependencies_if_missing() {
  if [ -d "$REPO_ROOT/node_modules" ]; then
    return 0
  fi
  write_step 'node_modules is missing — installing dependencies'
  if [ -f "$REPO_ROOT/package-lock.json" ]; then
    run_npm ci
  else
    run_npm install
  fi
}
