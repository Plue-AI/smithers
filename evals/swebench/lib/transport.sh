#!/bin/bash
# Prints the testbed transport the rig runs on, validated.
#
#   lib/transport.sh          -> docker | plue
#
# `SWB_TRANSPORT` names it and `docker` is the default:
#
#   docker  the official image on this machine's docker daemon: pulled,
#           extracted to work/<id>, bind-mounted back at /testbed, graded by the
#           evaluator's own containers. What every lane before 2026-09-26 ran.
#   plue    the same image booted as a Smithers Cloud workspace with
#           `--network none`, through `lib/plue.py` (the Harbor adapter's seam):
#           no pull, no extraction, no disk gate on this host. The agent's
#           `bash` reaches only the workspace and grading boots a second one.
#
# A typo is a stopped run, never a silent fallback to local docker.
set -euo pipefail
case "${SWB_TRANSPORT:-docker}" in
  docker|plue) printf '%s\n' "${SWB_TRANSPORT:-docker}" ;;
  *) echo "transport.sh: SWB_TRANSPORT must be docker or plue, got '${SWB_TRANSPORT}'" >&2; exit 2 ;;
esac
