#!/bin/sh
# Checkout scripts cannot execute host/root prototype bytes. The system install
# is main-pinned; its loader verifies gateway bytes before exec.
set -eu
if [ "$0" = "/usr/local/lib/smithers/current/share/trm06/flow.sh" ] && [ "$#" -eq 0 ]; then
    exec /usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin /usr/bin/python3 -I -S -c @TRM06_BOOTSTRAP@ flow
fi
printf '%s\n' '{"class":"unavailable","code":"prototype_authority_unavailable","check":"C-SPK-08"}' >&2
exit 78
