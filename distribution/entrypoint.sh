#!/bin/sh
set -eu
export SMITHERS_AUTH_MODE=selfhost
exec "${SMITHERS_BACKEND_BINARY:-/opt/smithers/bin/smithers-backend}" "$@"
