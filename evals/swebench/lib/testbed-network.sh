#!/bin/bash
# The testbed container's network condition: the one place the rig decides it.
#
#   testbed-network.sh resolve                     -> the requested mode
#   testbed-network.sh observe <container>         -> the mode docker reports
#   testbed-network.sh assert  <container> <mode>  -> both, and they must agree
#
# `SWB_TESTBED_NETWORK` names the condition and `none` is the default. It is a
# benchmark condition rather than a detail, so it is validated here, read back
# off the live container here, and stamped into the run's timings by whoever
# called this.
#
# ## Why the default is `none`
#
# The seal the codex lanes claimed was a seal on the tools an agent reaches for,
# not a kernel-level one. `shell_environment_policy.set` poisons the proxy
# variables of the commands codex spawns on the host; a `docker exec <container>
# curl …` starts its process as the docker daemon's child, inside a container
# that had the network on, so it inherits none of that. Two of the 45 `r90s`
# runs used exactly that to fetch the merged upstream fix
# (`sphinx-doc__sphinx-8721` fetched `pull/8721.patch`, `sympy__sympy-19495`
# fetched `pull/19495.diff`) and the `r90sh` lane repeated it. Will's ruling on
# 2026-08-24: a proper sandbox, so it cannot cheat.
#
# A container with no interface but `lo` cannot fetch a patch whatever command
# runs inside it, whatever the agent knows about proxies, and whatever a later
# harness invents. That is the difference this file exists to make: the previous
# seal had to be believed and could only be counted off transcripts afterwards,
# and this one is a kernel fact readable off the container while it runs.
#
# ## `docker exec` still works, and it has to
#
# Both arms are told to run the project's tests with `docker exec <container> …`,
# so a condition that took the docker socket away would measure a harness with
# no way to check its work — which is what `SWB_CODEX_NETWORK=off` does, and why
# that value is not the sealed lane. `exec` attaches a new process to an
# existing container's namespaces through the daemon's unix socket and needs no
# network of its own on either side of it.
#
# Measured on docker 29.4.0, 2026-08-24, in a `--network none` container, and
# re-measured by `./network-dryrun.sh`:
#
#   docker exec <c> sh -c 'echo ok'               exit 0
#   docker exec <c> ip -o addr                    lo, and nothing else
#   docker exec <c> wget -T3 http://example.com/  exit 1, no DNS
#   docker exec <c> wget -T3 http://93.184.216.34/  exit 1, no route
#   docker inspect -f '{{.HostConfig.NetworkMode}}'  none
#
# ## On Smithers Cloud
#
# Under `SWB_TRANSPORT=plue` the testbed is a workspace, `<container>` is its
# id, and `none` is the only value: `lib/plue.py` creates every workspace with
# `--network none`, and plue has no bridge to offer. `observe` reads the guest's
# own interface list (`lib/plue.py network`), so the recorded value is still a
# fact about the live testbed: `none` when `lo` is all it has, else `unsealed`.
#
# Spends nothing. `resolve` needs no docker; `observe` and `assert` do (or the
# plue CLI).
set -euo pipefail
S="$(cd "$(dirname "$0")/.." && pwd)"
# Validated by the run script that calls this, through lib/transport.sh.
TRANSPORT="${SWB_TRANSPORT:-docker}"

usage() {
  echo "usage: testbed-network.sh resolve | observe <container> | assert <container> <mode>" >&2
  exit 2
}

# The two values, and only these two. A typo is a stopped run rather than a
# silently networked one: `--network hostt` is a docker error, but
# `SWB_TESTBED_NETWORK=nonee` falling through to "whatever docker defaults to"
# would be a lane that believes it is sealed and is not.
validate() {
  if [ "$TRANSPORT" = "plue" ] && [ "${1:-}" != "none" ]; then
    echo "testbed-network.sh: a plue testbed is --network none, got '${1:-}'" >&2
    exit 2
  fi
  case "${1:-}" in
    none|bridge) printf '%s\n' "$1" ;;
    *)
      echo "testbed-network.sh: network must be none or bridge, got '${1:-}'" >&2
      exit 2 ;;
  esac
}

# What docker says the container is on, from two fields rather than one. A
# `HostConfig.NetworkMode` of `none` with a network attached is not `none`, and
# reading only the mode would report the request back instead of the fact.
# Older daemons spell an unspecified `--network` as `default`; docker 29 spells
# it `bridge`. Both mean the same thing and are normalised to `bridge`, so the
# recorded value is a condition rather than a daemon version.
observe() {
  CONTAINER="${1:-}"
  if [ -z "$CONTAINER" ]; then usage; fi
  if [ "$TRANSPORT" = "plue" ]; then
    "$S/lib/plue.py" network "$CONTAINER" || {
      echo "testbed-network.sh: no workspace '$CONTAINER'" >&2; exit 1; }
    return 0
  fi
  MODE="$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$CONTAINER" 2>/dev/null)" || {
    echo "testbed-network.sh: no container named '$CONTAINER'" >&2; exit 1; }
  ATTACHED="$(docker inspect -f '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}} {{end}}' \
    "$CONTAINER" 2>/dev/null | tr -s ' ' | sed 's/ $//')" || ATTACHED=""
  case "$MODE" in
    default) MODE=bridge ;;
  esac
  # The cross-check. `--network none` attaches exactly the `none` network, so
  # anything else on a container claiming `none` is a second interface and the
  # claim is false.
  if [ "$MODE" = "none" ] && [ "$ATTACHED" != "none" ]; then
    echo "testbed-network.sh: $CONTAINER reports mode none with networks '$ATTACHED'" >&2
    printf 'unsealed\n'
    return 0
  fi
  printf '%s\n' "$MODE"
}

MODE="${1:-}"
case "$MODE" in
  resolve)
    validate "${SWB_TESTBED_NETWORK:-none}" ;;
  observe)
    observe "${2:-}" ;;
  assert)
    CONTAINER="${2:-}"
    WANT="$(validate "${3:-}")"
    GOT="$(observe "$CONTAINER")"
    if [ "$GOT" != "$WANT" ]; then
      echo "testbed-network.sh: $CONTAINER is on '$GOT', the lane asked for '$WANT'" >&2
      exit 1
    fi
    printf '%s\n' "$GOT" ;;
  *)
    usage ;;
esac
