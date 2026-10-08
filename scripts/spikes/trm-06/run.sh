#!/bin/sh
# Checkout scripts cannot execute host/root prototype bytes. The system install
# is main-pinned; its loader verifies gateway bytes before exec.
set -eu
if [ "$0" = "/usr/local/lib/smithers/current/share/trm06/run.sh" ]; then
    if [ "$#" -eq 1 ] && [ "$1" = "startup-validation" ]; then
        exec /usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin /usr/bin/python3 -I -S -c @TRM06_BOOTSTRAP@ check-startup
    fi
    if [ "$#" -eq 1 ] && [ "$1" = "root-prototype-install-validation" ]; then
        exec /usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin /usr/bin/python3 -I -S -c @TRM06_BOOTSTRAP@ check-install
    fi
    if [ "$#" -eq 1 ] && [ "$1" = "root-session-input-validation" ]; then
        exec /usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin /usr/bin/python3 -I -S -c @TRM06_BOOTSTRAP@ check-session
    fi
    if [ "$#" -eq 1 ] && [ "$1" = "root-session-input-validation-no-landlock" ]; then
        exec /usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin /usr/bin/python3 -I -S -c @TRM06_BOOTSTRAP@ check-no-landlock
    fi
    if [ "$#" -eq 1 ] && [ "$1" = "measure" ]; then
        exec /usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin /usr/bin/python3 -I -S -c @TRM06_BOOTSTRAP@ measure
    fi
    if [ "$#" -eq 0 ]; then exec /usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin /usr/bin/python3 -I -S -c @TRM06_BOOTSTRAP@ run; fi
fi
printf '%s\n' '{"class":"unavailable","code":"prototype_authority_unavailable","check":"C-SPK-08"}' >&2
exit 78
