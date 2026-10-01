#!/bin/sh
# The msb binary every issue-sweep microVM runs as, one nice level per
# ISSUE_SWEEP_MSB_NICE below the flow host, so a busy guest never starves the
# host's 19 s run-lease heartbeat (#3328). vm.ts points MSB_PATH here.
exec nice -n "${ISSUE_SWEEP_MSB_NICE:-10}" "$ISSUE_SWEEP_MSB" "$@"
