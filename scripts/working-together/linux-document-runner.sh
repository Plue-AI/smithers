#!/bin/sh
# Cargo target runner for the unprivileged Linux filesystem boundary tests.
set -eu
if [ "$(uname -s)" != Linux ] || [ "$(id -u)" = 0 ]; then
  echo 'Run the build and runner as an ordinary user on Linux.' >&2
  exit 2
fi
if [ "$#" -lt 1 ]; then
  echo 'Usage: linux-document-runner.sh <test-binary> [test arguments...]' >&2
  exit 2
fi
binary=$(realpath -- "$1")
shift
if [ ! -f "$binary" ] || [ ! -x "$binary" ]; then
  echo 'Test binary is missing or not executable.' >&2
  exit 2
fi
# --mount parses comma-separated fields. Refuse ambiguous source paths.
case "$binary" in
  *,*) echo 'Test binary path contains a comma.' >&2; exit 2 ;;
esac
image=ubuntu@sha256:f144425ff09be612d6d9ad965196e9cdc23dae1f42110a8a11a3e9a8198759f7
exec docker run --rm --pull never --network none --user 19998:19998 \
  --cap-drop ALL --security-opt no-new-privileges --pids-limit 128 \
  --memory 1g --cpus 2 \
  --mount "type=bind,src=$binary,dst=/test,readonly" \
  --mount type=bind,src=/etc/machine-id,dst=/etc/machine-id,readonly \
  --entrypoint /test "$image" "$@"
