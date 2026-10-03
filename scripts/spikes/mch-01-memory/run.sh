#!/bin/sh
# From the checkout: sh scripts/spikes/mch-01-memory/run.sh --state "$STATE" --out /path/to/new/evidence
set -eu
cd "$(dirname "$0")/../../.."
df -h "$HOME"
export GOCACHE="${GOCACHE:-$HOME/.cache/go-build-lanes/cap}"
export GIT_CEILING_DIRECTORIES="$HOME"
export MSB_BACKEND=local
exec python3 -B scripts/spikes/mch-01-memory/run.py "$@"
