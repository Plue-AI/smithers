#!/usr/bin/env bash
# Builds the pnpm 11 Linux ARM64 store archive that `run.sh snapshot` needs,
# inside one disposable microVM booted from the backend's DefaultImage
# (node 26.5.0, Debian 13, glibc). The VM has public network for this
# preparation only and is removed on every exit.
#
#   scripts/spikes/col-01/store.sh <commit> <absolute output directory>
#
# Output: <dir>/store.tar (the --store-dir root, so it carries the v11
# subdirectory pnpm appends, plus cache/: an offline frozen install still reads
# registry metadata from --cache-dir), store.tar.sha256 and store-receipt.txt.
set -euo pipefail
SPIKE_DIR="$(cd "$(dirname "$0")" && pwd)"
SPIKE_ROOT="$(cd "$SPIKE_DIR/../../.." && pwd)"
COMMIT="${1:?commit required}"
OUT="${2:?absolute output directory required}"
[[ "$OUT" == /* ]] || { echo 'output directory must be absolute' >&2; exit 2; }
[[ "$COMMIT" =~ ^[0-9a-f]{40}$ ]] || { echo 'commit must be a full SHA' >&2; exit 2; }
IMAGE="$(sed -n 's/^const DefaultImage = "\(.*\)"$/\1/p' "$SPIKE_ROOT/packages/backend/microsandbox/runtime.go")"
[[ -n "$IMAGE" ]] || { echo 'DefaultImage not found' >&2; exit 2; }
MSB="${SPIKE_MSB_BIN:-$(node -e 'const fs=require("node:fs"),path=require("node:path"),req=require("node:module").createRequire(fs.realpathSync(process.argv[1]));process.stdout.write(path.join(path.dirname(req.resolve("@superradcompany/microsandbox-darwin-arm64/package.json")),"bin/msb"));' "$SPIKE_ROOT/packages/smithers/flows/sandbox/node_modules/microsandbox/bin/microsandbox.cjs")}"
NAME="spike-col01-store-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$OUT"
trap '"$MSB" stop "$NAME" >/dev/null 2>&1 || true; "$MSB" rm "$NAME" >/dev/null 2>&1 || true' EXIT
"$MSB" run --name "$NAME" --cpus 4 --memory 8G --root-disk 32G --net public \
  --volume "$OUT:/out" --timeout 1h "$IMAGE" -- bash -euo pipefail -c '
    cd /root
    git init -q repo
    git -C repo fetch -q --depth 1 https://github.com/smithersai/smithers.git "'"$COMMIT"'"
    git -C repo checkout -q FETCH_HEAD
    cd repo
    npx -y pnpm@11.25.0 --version
    npx -y pnpm@11.25.0 store path --store-dir /root/store
    npx -y pnpm@11.25.0 install --frozen-lockfile --ignore-scripts --store-dir /root/store --cache-dir /root/store/cache
    # Prove the archive suffices: the guest installs offline from it.
    rm -rf node_modules
    npx -y pnpm@11.25.0 install --frozen-lockfile --offline --ignore-scripts --store-dir /root/store --cache-dir /root/store/cache
    # v11/projects holds symlinks back to the build checkout; a safe extract
    # rejects them and an offline install does not read them.
    tar -cf /out/store.tar --exclude=./v11/projects -C /root/store .
    sha256sum /out/store.tar > /out/store.tar.sha256
    { echo "commit '"$COMMIT"'"; uname -a; node --version; sha256sum pnpm-lock.yaml; du -sh /root/store; } > /out/store-receipt.txt
  '
cat "$OUT/store-receipt.txt" "$OUT/store.tar.sha256"
