#!/usr/bin/env bash
# Typechecks and builds the BuilderGPT Electron app, optionally packaging it.
#
# Usage:
#   scripts/build.sh                 # typecheck + build into out/
#   scripts/build.sh --package linux # ...then package into release/
#
# --package accepts win, linux or mac. electron-builder is invoked directly
# rather than through the package:* npm scripts, because those re-run the build
# that just finished. Cross-building is subject to electron-builder's own
# platform limitations (notably, mac targets generally require macOS).
#
# The app has no native dependencies, so no rebuild step is needed for any
# target.

set -euo pipefail
# shellcheck source=scripts/_common.sh
. "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

PACKAGE_TARGET=""

while [ $# -gt 0 ]; do
  case "$1" in
    --package|-p)
      PACKAGE_TARGET="${2:-}"
      if [ -z "$PACKAGE_TARGET" ]; then
        printf '%serror: --package needs a target (win, linux or mac)%s\n' "$C_ERR" "$C_OFF" >&2
        exit 2
      fi
      shift 2
      ;;
    -h|--help)
      sed -n '2,16p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      printf '%serror: unknown argument: %s%s\n' "$C_ERR" "$1" "$C_OFF" >&2
      exit 2
      ;;
  esac
done

case "$PACKAGE_TARGET" in
  ""|win|linux|mac) ;;
  *)
    printf '%serror: invalid --package target: %s (expected win, linux or mac)%s\n' \
      "$C_ERR" "$PACKAGE_TARGET" "$C_OFF" >&2
    exit 2
    ;;
esac

install_dependencies_if_missing

write_step 'Typechecking and building'
run_npm run build

if [ -n "$PACKAGE_TARGET" ]; then
  write_step "Packaging for $PACKAGE_TARGET"
  run_npm exec -- electron-builder "--$PACKAGE_TARGET"
  printf '\n%sDone. Installer(s) written to %s/release%s\n' "$C_OK" "$REPO_ROOT" "$C_OFF"
else
  printf '\n%sDone. Bundles written to %s/out%s\n' "$C_OK" "$REPO_ROOT" "$C_OFF"
fi
