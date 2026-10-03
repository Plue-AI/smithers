#!/bin/bash
# Disposable C-SPK-06 entry point. No caller-selected guest inputs.
set -eu
exec /usr/bin/python3 "$(dirname "$0")/preflight.py" "$@"
