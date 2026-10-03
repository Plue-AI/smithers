#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
COL01_ROOT="$PWD"
for COL01_TOOL in go cargo rustup jj initdb pg_ctl pnpm node; do
  command -v "$COL01_TOOL" >/dev/null || { echo "SPIKE TEST BLOCKED: missing $COL01_TOOL" >&2; exit 1; }
done
if [[ ! -f scripts/spikes/col-01/node_modules/@playwright/test/cli.js ]]; then
  pnpm --dir scripts/spikes/col-01 install --offline --frozen-lockfile --ignore-scripts
fi
COL01_TEST_BUILD="$COL01_ROOT/.artifacts/spikes/col01-host-tests"
mkdir -p "$COL01_ROOT/.artifacts/col01-tmp"
export TMPDIR="$COL01_ROOT/.artifacts/col01-tmp"
export CARGO_TARGET_DIR="$COL01_TEST_BUILD/cargo"
cargo test --locked --manifest-path scripts/spikes/col-01/guest/Cargo.toml
cargo build --locked --manifest-path scripts/spikes/col-01/guest/Cargo.toml
export COL01_ECHO_BINARY="$CARGO_TARGET_DIR/debug/col01-echo"
export COL01_DOCHOST_BINARY="$CARGO_TARGET_DIR/debug/col01-dochost"
(cd scripts/spikes/col-01 && go test -count=1 ./... && go vet ./...)
python3 -m unittest discover -s scripts/spikes/col-01/jj-snapshot -v
node_modules/.bin/tsc --noEmit --strict --allowImportingTsExtensions --target ES2024 --module ESNext --moduleResolution Bundler --skipLibCheck --lib ES2024,DOM,DOM.Iterable scripts/spikes/col-01/PACKAGE.ts scripts/spikes/col-01/browser.ts scripts/spikes/col-01/keystrokes.spec.ts scripts/spikes/col-01/playwright.config.ts
cargo fmt --manifest-path scripts/spikes/col-01/guest/Cargo.toml -- --check
bash -n scripts/spikes/col-01/run.sh
node --check scripts/spikes/col-01/result.mjs
node --test scripts/spikes/col-01/result.test.mjs
