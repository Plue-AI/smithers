#!/usr/bin/env bash
# Compile the production document modules with ASan, without rebuilding the
# unrelated repository engine. Same pinned Yrs, including sync and UTF-16.
set -euo pipefail
repo=$(cd "$(dirname "$0")/../../.." && pwd)
proof=$(mktemp -d "${TMPDIR:-/tmp}/smithers-live-asan.XXXXXX")
trap 'rm -rf "$proof"' EXIT
mkdir -p "$proof/src"
cat > "$proof/Cargo.toml" <<'MANIFEST'
[package]
name = "smithers-live-document-asan"
version = "0.0.0"
edition = "2021"
[workspace]
[profile.dev]
debug = false
opt-level = 1
[dependencies]
yrs = { version = "=0.27.4", features = ["small-client", "sync"] }
serde_json = "1"
MANIFEST
cat > "$proof/src/lib.rs" <<RUST
#[path = "$repo/crates/smithers-ffi/src/document_core.rs"]
mod document_core;
#[path = "$repo/crates/smithers-ffi/src/live_document_decode.rs"]
mod live_document_decode;
#[path = "$repo/crates/smithers-ffi/src/live_document.rs"]
mod live_document;
RUST
RUSTC_BOOTSTRAP=1 RUSTFLAGS='-Zsanitizer=address' cargo test \
 --manifest-path "$proof/Cargo.toml" --target "$(rustc -vV | sed -n 's/^host: //p')" \
 live_document -- --test-threads=1
