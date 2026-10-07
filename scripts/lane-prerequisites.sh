#!/usr/bin/env bash
# Source from lane setup so the test processes inherit the prerequisite paths.
smithers_lane_prerequisites() {
  local root target
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
  if [[ ! -x "$target/release/smithers-jj-export" ]]; then
    echo 'Building test prerequisite smithers-jj-export' >&2
    (cd "$root" && cargo build --locked --release -p smithers-ffi --bin smithers-jj-export) || {
      echo 'PREREQUISITE ERROR: could not build smithers-jj-export' >&2
      return 1
    }
  fi
  [[ -x "$target/release/smithers-jj-export" ]] || {
    echo "PREREQUISITE ERROR: missing executable $target/release/smithers-jj-export" >&2
    return 1
  }
  export SMITHERS_WORKSPACE_JJ_EXPORT_BINARY="$target/release/smithers-jj-export"
}
smithers_lane_prerequisites
