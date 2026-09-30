#!/bin/bash
# Verifies the Harbor adapter without docker, a model, or a runner install.
#
#   pnpm exec smthrs test //evals/harbor:offline
#
# `fixtures/check_infra.py` pins crash containment, the infra classification,
# the slot ledger and the verifier handover. `fixtures/check_agent.py` pins the prompt, the environment the CLI is given,
# the journal fold, the trajectory and the names. Set HARBOR_PYTHON to the
# interpreter of a Harbor install to also validate the trajectory against
# Harbor's own ATIF model; without it the check is structural and says so.
set -eu
S="$(cd "$(dirname "$0")" && pwd)"
PY="${HARBOR_PYTHON:-python3}"
"$PY" "$S/fixtures/check_agent.py"
"$PY" "$S/fixtures/check_infra.py"
"$PY" "$S/fixtures/check_ownership.py"
"$PY" "$S/fixtures/check_tb4_resources.py"
"$PY" "$S/fixtures/check_health.py"
