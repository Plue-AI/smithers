#!/usr/bin/env bash
# Source from lane setup so the test processes inherit the prerequisite paths.
smithers_lane_prerequisites() {
  local root target helper capabilities
  root=$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel) || return 1
  if ! command -v bun >/dev/null 2>&1; then
    export PATH="$HOME/.bun/bin:$PATH"
  fi
  command -v bun >/dev/null 2>&1 || {
    echo 'PREREQUISITE ERROR: bun is required; install it on PATH or in ~/.bun/bin' >&2
    return 1
  }
  target=${CARGO_TARGET_DIR:-$root/target}
  [[ "$target" = /* ]] || target="$root/$target"
  helper="$target/release/smithers-jj-export"
  capabilities=""
  if [[ -x "$helper" ]]; then
    capabilities=$("$helper" --capabilities 2>/dev/null) || capabilities=""
  fi
  # J1's explicit trusted-process fixture needs this test-only binding. The
  # shipped helper's default feature set and production microVM gate stay intact.
  if [[ "$capabilities" != *'"trusted-process-binding/v1"'* ]]; then
    echo 'Building test prerequisite smithers-jj-export' >&2
    (cd "$root" && cargo build --locked --release -p smithers-ffi --bin smithers-jj-export --features trusted-process-binding) || {
      echo 'PREREQUISITE ERROR: could not build smithers-jj-export' >&2
      return 1
    }
    capabilities=$("$helper" --capabilities 2>/dev/null) || capabilities=""
  fi
  [[ -x "$target/release/smithers-jj-export" ]] || {
    echo "PREREQUISITE ERROR: missing executable $target/release/smithers-jj-export" >&2
    return 1
  }
  [[ "$capabilities" == *'"trusted-process-binding/v1"'* ]] || {
    echo 'PREREQUISITE ERROR: helper lacks trusted-process-binding/v1' >&2
    return 1
  }
  export SMITHERS_WORKSPACE_JJ_EXPORT_BINARY="$helper"
}
smithers_lane_prerequisites
