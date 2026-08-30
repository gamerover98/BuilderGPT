#!/usr/bin/env bash
# Starts Schematic AI Studio in development mode.
#
# Runs `npm run dev` (electron-vite dev): builds the main and preload bundles,
# starts the Vite dev server for the renderer, and launches the Electron window
# against it with hot reload.
#
# Blocks until the app is closed. Ctrl+C stops it.
#
# Usage:
#   scripts/start.sh

set -euo pipefail
# shellcheck source=scripts/_common.sh
. "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

install_dependencies_if_missing

write_step 'Starting Schematic AI Studio (development mode)'
run_npm run dev
