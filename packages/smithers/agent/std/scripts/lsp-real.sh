#!/bin/sh
# Installs real language servers in user space and measures push settle with
# them, then runs the real-server test. Nothing is written outside <dir>.
#
#   sh scripts/lsp-real.sh <dir> [iterations] [settleMs] [quietMs]
#
# typescript-language-server 6.0.1 and typescript 5.9.3 come from npm (a
# tsserver.js is required; typescript 7 ships none). gopls comes from
# `go install` when Go is on PATH. Reports land in <dir>/out/{ts,go}.json.
set -eu
dir=$(mkdir -p "${1:?usage: lsp-real.sh <dir> [iterations] [settleMs] [quietMs]}" && cd "$1" && pwd)
iterations=${2:-5}
settle=${3:-3000}
quiet=${4:-500}
here=$(cd "$(dirname "$0")/.." && pwd)
mkdir -p "$dir/out" "$dir/bin"
if [ ! -x "$dir/node_modules/.bin/typescript-language-server" ]; then
  (cd "$dir" && npm install --no-audit --no-fund --ignore-scripts typescript@5.9.3 typescript-language-server@6.0.1)
fi
tls="$dir/node_modules/.bin/typescript-language-server"
tsserver="$dir/node_modules/typescript/lib/tsserver.js"
test -f "$tsserver"
export SMITHERS_LSP_TLS="$tls" SMITHERS_LSP_TSSERVER="$tsserver"
(cd "$here" && node_modules/.bin/vitest run test/NodeLanguageServerReal.test.ts --coverage.enabled=false)
node "$here/scripts/lsp-settle-bench.ts" "$tls" "$tsserver" "$here/test/fixtures/lsp/ts" "$iterations" "$settle" "$quiet" \
  src/main.ts src/greet.ts > "$dir/out/ts.json"
if command -v go >/dev/null 2>&1; then
  [ -x "$dir/bin/gopls" ] || GOBIN="$dir/bin" go install golang.org/x/tools/gopls@latest
  node "$here/scripts/lsp-settle-bench.ts" "$dir/bin/gopls" - "$here/test/fixtures/lsp/go" "$iterations" "$settle" "$quiet" \
    main.go util.go > "$dir/out/go.json"
fi
echo "reports in $dir/out"
