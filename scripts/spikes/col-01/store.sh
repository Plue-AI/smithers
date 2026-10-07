#!/usr/bin/env bash
# Store preparation must use the qualified guest agent launcher. The former
# direct msb command cloned and installed repository bytes as root.
set -euo pipefail
SPIKE_DIR="$(cd "$(dirname "$0")" && pwd)"
SPIKE_ROOT="$(cd "$SPIKE_DIR/../../.." && pwd)"
python3 "$SPIKE_DIR/preflight.py" "$SPIKE_ROOT"
echo 'SPIKE STORE BLOCKED: qualified non-root guest provisioning and offline validation required; no direct root install' >&2
exit 2
