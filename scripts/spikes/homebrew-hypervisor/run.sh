#!/bin/bash
set -euo pipefail
export LANE=fr-t-ins-03
exec /usr/bin/python3 "$(cd "$(dirname "$0")" && pwd)/preflight.py" "$@"
