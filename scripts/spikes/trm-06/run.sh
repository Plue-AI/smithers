#!/bin/sh
# Checkout scripts cannot execute host/root prototype bytes. The system install
# is main-pinned; its loader verifies gateway bytes before exec.
set -eu
if [ "$0" = "/usr/local/lib/smithers/current/share/trm06/run.sh" ]; then
    if [ "$#" -eq 1 ] && [ "$1" = "root-prototype-install-validation" ]; then
        exec /usr/bin/python3 -I -S /usr/local/lib/smithers/current/share/trm06/launcher.py check-install
    fi
    if [ "$#" -eq 1 ] && [ "$1" = "root-session-input-validation" ]; then
        exec /usr/bin/python3 -I -S /usr/local/lib/smithers/current/share/trm06/launcher.py check-session
    fi
    if [ "$#" -eq 1 ] && [ "$1" = "root-session-input-validation-no-landlock" ]; then
        exec /usr/bin/python3 -I -S /usr/local/lib/smithers/current/share/trm06/launcher.py check-no-landlock
    fi
    if [ "$#" -eq 1 ] && [ "$1" = "measure" ]; then
        exec /usr/bin/python3 -I -S /usr/local/lib/smithers/current/share/trm06/launcher.py measure
    fi
    if [ "$#" -eq 0 ]; then exec /usr/bin/python3 -I -S /usr/local/lib/smithers/current/share/trm06/launcher.py run; fi
fi
printf '%s\n' '{"class":"unavailable","code":"prototype_authority_unavailable","check":"C-SPK-08"}' >&2
exit 78
