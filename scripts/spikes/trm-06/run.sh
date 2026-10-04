#!/bin/sh
# No branch-built script, compiler or binary is promoted to a root/host probe.
# T-SEC-01 has not supplied an authenticated installed-prototype provider.
set -eu
printf '%s\n' '{"class":"unavailable","code":"prototype_authority_unavailable","check":"C-SPK-08","missing":["accepted T-SEC-01 R1-R3 receipts","main-pinned installed prototype","accepted root-prototype-install-validation","accepted root-session-input-validation"]}' >&2
exit 78
