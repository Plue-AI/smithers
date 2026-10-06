#!/bin/bash
# C-REL-05: run once for each machine using Ben's independently signed-in CLI.
# The only execution door is the production personal-terminal CLI. No tokens,
# tool output, shell prompts or terminal escape sequences are retained.
set -euo pipefail
export LANE=fr-t-rel-02
if [ "$#" -ne 4 ]; then
  echo 'Usage: credential-soak.sh OWNER/REPO MACHINE EXPECTED_GUEST_UID EVIDENCE_DIR' >&2
  exit 64
fi
repo=$1 machine=$2 guest_uid=$3 evidence=$4
[[ "$repo" =~ ^smithers-mvp-canary/[0-9]{4}-[0-9]{2}-[0-9]{2}[a-zA-Z0-9_-]*$ ]] || exit 64
[[ "$machine" =~ ^[a-zA-Z0-9_-]+$ ]] || exit 64
[[ "$guest_uid" =~ ^[1-9][0-9]*$ ]] || exit 64
[ "${SMITHERS_SOAK_BEN_INDEPENDENT_LOGIN:-}" = 1 ] || {
  echo 'Ben must attest independent logins on this machine before the soak.' >&2; exit 78;
}
[ "$(id -u)" != 0 ] || { echo 'Recording tools must run without root.' >&2; exit 78; }
command -v smthrs >/dev/null || exit 69
# Refuse an existing directory: never overwrite earlier evidence.
umask 077
mkdir "$evidence"
exec python3 "$(dirname "$0")/credential-soak-capture.py" "$repo" "$machine" "$guest_uid" "$evidence"
