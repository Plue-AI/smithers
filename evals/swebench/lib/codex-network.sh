#!/bin/bash
# Prints the codex arm's network condition, validated.
#
#   lib/codex-network.sh <caller>   -> sealed | off | on
#
# The problem statement comes from a public issue tracker, so the prompt is
# untrusted input. `sealed` is the default: codex still gets
# `--dangerously-bypass-approvals-and-sandbox` (it must reach the docker socket
# to run the project's tests), but every child command's proxy points at a dead
# port and the web-search tool is off. `on` lifts that seal and hands a
# prompt-steered shell this host, the docker socket, CODEX_HOME and the network,
# so it is never implicit: the lane must also set SWB_CODEX_UNCONFINED=allowed,
# the same opt-in shape as the flows arm's SWB_FLOWS_HOST_SHELL=allowed.
#
# run-instance-codex.sh reads it per run; run-sample.sh and run-matrix.sh read
# it before the first run, so a bad value stops a wave instead of failing
# every instance in it.
set -euo pipefail
CALLER="${1:-codex-network.sh}"
NETWORK="${SWB_CODEX_NETWORK:-sealed}"
case "$NETWORK" in
  sealed|off) ;;
  on)
    if [ "${SWB_CODEX_UNCONFINED:-}" != "allowed" ]; then
      echo "$CALLER: SWB_CODEX_NETWORK=on runs codex unconfined with network on this host; set SWB_CODEX_UNCONFINED=allowed to opt in" >&2
      exit 2
    fi
    echo "$CALLER: WARNING: SWB_CODEX_NETWORK=on runs codex unconfined: a shell steered by an untrusted problem statement gets this host, the docker socket, CODEX_HOME and the network" >&2 ;;
  *)
    echo "$CALLER: SWB_CODEX_NETWORK must be on, sealed or off, got '$NETWORK'" >&2
    exit 2 ;;
esac
printf '%s\n' "$NETWORK"
