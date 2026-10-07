#!/bin/sh
# Checkout scripts cannot execute host/root prototype bytes. The system install
# is main-pinned; its loader verifies gateway bytes before exec.
set -eu
if [ "$0" = "/usr/local/lib/smithers/current/share/trm06/revoke.sh" ] && [ "$#" -eq 0 ]; then
    exec /usr/bin/python3 -I -S /usr/local/lib/smithers/current/share/trm06/launcher.py revoke
fi
printf '%s\n' '{"class":"unavailable","code":"prototype_authority_unavailable","check":"C-SPK-08"}' >&2
exit 78
