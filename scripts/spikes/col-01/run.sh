#!/usr/bin/env bash
set -euo pipefail
SPIKE_DIR="$(cd "$(dirname "$0")" && pwd)"
SPIKE_ROOT="$(cd "$SPIKE_DIR/../../.." && pwd)"
cd "$SPIKE_ROOT"
export GIT_CEILING_DIRECTORIES="$HOME"
SPIKE_BUILD="$SPIKE_ROOT/.artifacts/spikes/col01-build"
SPIKE_MODE="${1:-all}"
SPIKE_FREE_KIB="$(df -k "$SPIKE_ROOT" | awk 'NR==2 {print $4}')"
df -h "$SPIKE_ROOT"
if (( SPIKE_FREE_KIB < 8 * 1024 * 1024 )); then
  echo 'SPIKE FAILED: less than 8 GiB free; remove only your own outputs.' >&2
  exit 1
fi
if [[ "$SPIKE_MODE" == all || "$SPIKE_MODE" == snapshot ]]; then
  if [[ ! -r "${SPIKE_SNAPSHOT_STORE_ARCHIVE:-}" ]]; then
    echo 'SPIKE SNAPSHOT BLOCKED: SPIKE_SNAPSHOT_STORE_ARCHIVE must name a complete pnpm 11 Linux ARM64 store tar archive.' >&2
    exit 2
  fi
fi
if [[ ! -f scripts/spikes/col-01/node_modules/@playwright/test/cli.js ]]; then
  pnpm --dir "$SPIKE_DIR" install --offline --frozen-lockfile --ignore-scripts
fi
if [[ "$SPIKE_MODE" == remote ]]; then
  export SPIKE_ORIGIN="${2:?LAN origin required}"
  export SPIKE_TRANSPORT="${3:?relay or bridge required}"
  export SPIKE_CLIENT_TOPOLOGY=second-mac
  export SPIKE_EVIDENCE="${SPIKE_EVIDENCE:-$SPIKE_ROOT/.artifacts/checks/C-SPK-07/$(date -u +%Y%m%dT%H%M%SZ)-remote}"
  exec node scripts/spikes/col-01/node_modules/@playwright/test/cli.js test --config "$SPIKE_DIR/playwright.config.ts"
fi
mkdir -p "$SPIKE_BUILD" "$SPIKE_ROOT/.artifacts/col01-tmp"
export TMPDIR="$SPIKE_ROOT/.artifacts/col01-tmp"
if [[ "$SPIKE_MODE" == all || "$SPIKE_MODE" == snapshot ]]; then
  if [[ ! -x "$SPIKE_BUILD/col01-jj" ]]; then
    curl -fL --retry 3 'https://github.com/jj-vcs/jj/releases/download/v0.39.0/jj-v0.39.0-aarch64-unknown-linux-musl.tar.gz' -o "$SPIKE_BUILD/jj.tar.gz"
    echo "15bbb0199adf57929d1e3cd90ae0b47356858cbe374814769815a1fb87d5ad1d  $SPIKE_BUILD/jj.tar.gz" | shasum -a 256 -c -
    tar -xzf "$SPIKE_BUILD/jj.tar.gz" -C "$SPIKE_BUILD" ./jj
    mv "$SPIKE_BUILD/jj" "$SPIKE_BUILD/col01-jj"
  fi
fi
SPIKE_MSB="${SPIKE_MSB_BIN:-$SPIKE_ROOT/packages/smithers/flows/sandbox/node_modules/microsandbox/bin/microsandbox.cjs}"
# The backend intentionally scrubs PATH to system directories. Resolve an npm
# launcher to its native binary rather than requiring Node in that environment.
if file -b "$SPIKE_MSB" | rg -q 'script'; then
  SPIKE_MSB="$(node -e 'const fs=require("node:fs"),path=require("node:path"),req=require("node:module").createRequire(fs.realpathSync(process.argv[1]));process.stdout.write(path.join(path.dirname(req.resolve("@superradcompany/microsandbox-darwin-arm64/package.json")),"bin/msb"));' "$SPIKE_MSB")"
fi
cp "$SPIKE_DIR/msb-name.py" "$SPIKE_BUILD/msb-name"
chmod +x "$SPIKE_BUILD/msb-name"
ln -sfn "$SPIKE_MSB" "$SPIKE_BUILD/msb-real"
# The repository's pinned Rust toolchain supplies Linux std, musl and LLD.
# No build or mount enters the main checkout.
if ! rustup target list --installed | rg -q '^aarch64-unknown-linux-musl$'; then
  rustup target add aarch64-unknown-linux-musl
fi
export CARGO_TARGET_DIR="$SPIKE_BUILD/cargo"
SPIKE_SYSROOT="$(rustc --print sysroot)"
SPIKE_RUST_HOST="$(rustc -vV | awk '/^host:/ {print $2}')"
export CARGO_TARGET_AARCH64_UNKNOWN_LINUX_MUSL_LINKER="$SPIKE_SYSROOT/lib/rustlib/$SPIKE_RUST_HOST/bin/rust-lld"
RUSTFLAGS='-C linker-flavor=ld.lld' cargo build --locked --release --target aarch64-unknown-linux-musl --manifest-path "$SPIKE_DIR/guest/Cargo.toml"
cp "$CARGO_TARGET_DIR/aarch64-unknown-linux-musl/release/col01-echo" "$SPIKE_BUILD/col01-echo"
cp "$CARGO_TARGET_DIR/aarch64-unknown-linux-musl/release/col01-dochost" "$SPIKE_BUILD/col01-dochost"
node_modules/.bin/esbuild "$SPIKE_DIR/browser.ts" --bundle --outfile="$SPIKE_BUILD/spike.js"
(cd "$SPIKE_DIR" && go build -o "$SPIKE_BUILD/spike" ./relay-rtt)
SPIKE_INTERFACE="${SPIKE_INTERFACE:-$(route -n get default | awk '/interface:/ {print $2}')}"
SPIKE_LAN="${SPIKE_LAN:-$(ipconfig getifaddr "$SPIKE_INTERFACE")}"
SPIKE_EVIDENCE_ROOT="${SPIKE_EVIDENCE_ROOT:-$SPIKE_ROOT/.artifacts/checks}"
exec "$SPIKE_BUILD/spike" --mode "$SPIKE_MODE" --transport "${2:-relay}" --http-port "${SPIKE_HTTP_PORT:-0}" --build "$SPIKE_BUILD" --lan "$SPIKE_LAN" --evidence-root "$SPIKE_EVIDENCE_ROOT"
