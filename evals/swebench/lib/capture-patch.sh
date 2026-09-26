#!/bin/bash
# Captures one instance's model patch out of its workspace.
#
#   capture-patch.sh <workdir> <out-patch> [extra-exclude-pathspec ...]
#
# The patch is the working tree against the capture base `snapshot-base.sh`
# recorded before the agent started, so it holds what the agent changed and
# nothing the official image had already changed. Two things are excluded here,
# both at the source rather than by editing the patch afterwards:
#
#   1. Files the image's own `pre_install` step mutated. The capture base
#      already contains them, so they cancel.
#   2. Files that did not exist when the agent started. Agent scratch left in
#      the tree would otherwise be reported as a new file — wave 3 shipped
#      `.tmp_init_collect_repro/` with an `assert False` in it. Restoring the
#      index to the capture base drops them, which is also exactly the set the
#      codex path never had in its index, so both harnesses are captured under
#      the same rule.
#
# Anything dropped by rule 2 is listed in <out-patch>.untracked, so a wave can
# see whether a run created a file it meant to keep.
set -euo pipefail
S="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${1:-}"
OUT="${2:-}"
shift 2 || true
REF="refs/flows/capture-base"

if [ -z "$WORK" ] || [ ! -d "$WORK/.git" ]; then
  echo "capture-patch.sh: no git workspace at ${WORK:-<unset>}" >&2; exit 2
fi
if [ -z "$OUT" ]; then
  echo "capture-patch.sh: no output path given" >&2; exit 2
fi

source "$S/lib/capture-git.sh"
CAPTURE="$(capture_git rev-parse --verify --quiet "$REF^{commit}")" || {
  echo "capture-patch.sh: $WORK has no $REF — it predates the capture fix." >&2
  echo "  Re-run run-instance.sh for this instance; a patch diffed against the" >&2
  echo "  base commit would carry the image's own pre_install churn." >&2
  exit 3
}

# Restore a private index to the capture base: it is the pre-agent set of tracked
# paths, with the image's own permission bits, so the diff reports content the
# agent wrote and neither scratch files nor the mode churn the host extraction
# introduces.
( cd "$WORK" && capture_git read-tree "$CAPTURE" )
( cd "$WORK" && capture_git ls-files --others --exclude-standard ) > "$OUT.untracked"

( cd "$WORK" && capture_git diff --no-ext-diff --no-textconv --ignore-submodules=all "$CAPTURE" -- \
    ':(exclude)*.pyc' ':(exclude)**/__pycache__/**' ':(exclude).git' "$@" \
) > "$OUT" 2>/dev/null

# `SWB_CAPTURE_STRIP=host`: this ran inside a plue guest, which has no node;
# `lib/plue.py capture` strips the patch on the host once it is downloaded.
if [ "${SWB_CAPTURE_STRIP:-here}" != "host" ]; then
  node "$S/lib/strip-modes.mjs" "$OUT" >/dev/null
fi
echo "$(wc -c < "$OUT" | tr -d ' ') $(wc -l < "$OUT.untracked" | tr -d ' ')"
