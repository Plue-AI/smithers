#!/bin/sh
# No branch entry point can bypass the installed-authority refusal.
set -eu
printf '%s\n' '{"class":"unavailable","code":"prototype_authority_unavailable","check":"C-SPK-08"}' >&2
exit 78
