#!/bin/bash
set -euo pipefail
export LANE=fr7-t-ins-03
exec /usr/bin/python3 "$(cd "$(dirname "$0")" && pwd)/preflight.py" "$@"
