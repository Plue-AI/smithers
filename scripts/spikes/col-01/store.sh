#!/usr/bin/env bash
# Prepare the ARM64 store with the shared runtime's non-root agent launcher.
# Archive and digest/revision receipt are retained in the printed evidence path.
set -euo pipefail
if (( $# != 0 )); then
  echo 'Usage: store.sh (reviewed main; no image, commit or helper overrides)' >&2
  exit 2
fi
SPIKE_DIR="$(cd "$(dirname "$0")" && pwd)"
exec bash "$SPIKE_DIR/run.sh" store
