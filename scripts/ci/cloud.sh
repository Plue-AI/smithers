#!/usr/bin/env bash
# Smithers Cloud CI runner.
#
# Cloud gives this repo a pool of at most 5 small gVisor runners, and each task
# runs in its own fresh sandbox. Every task therefore pays the JS bootstrap
# (npm + pnpm + `pnpm install --frozen-lockfile --ignore-scripts`) from
# scratch, which alone costs about 11 minutes before a single gate runs. With
# one task per gate that was 39 tasks x ~12 minutes over 5 runners, so 1.5-2
# hours per push: run 11697 (2026-09-15) still had 4 tasks running and 35
# queued after 20 minutes.
#
# So .smithers/workflows/ci.tsx batches the gates (48 as of 2026-09-26) into 6 tasks, and each
# task calls the group mode here:
#
#   bash scripts/ci/cloud.sh <gate>                  # one gate (unchanged)
#   bash scripts/ci/cloud.sh group <gate> <gate>...  # bootstrap once, run many
#
# Group mode installs the union of its gates' toolchains exactly once, then
# runs each gate in order and prints `::gate <name> start`, then `::gate <name>
# ok` or `::gate <name> fail`. A failing gate does not stop the ones after it;
# the task exits non-zero at the end instead, so a single task still reports
# every gate's result. Groups are chosen to share toolchains (jj, Foundry,
# Rust) and to even out wall-clock time; ci.tsx holds the partition.
#
# Each Cloud task gets its own checkout. Keep tool installs and caches local.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
# Whether the caller was already an automated environment, recorded before this
# script declares itself one. A gate that may repair a generated file locally
# reads this rather than `CI`, so running the gate by hand still repairs and
# running it from any other automation still only checks.
host_ci="${CI:-}"
export CI=true
tools_dir="$PWD/.flows/cloud-tools"
export PATH="$tools_dir/bin:$PATH"

# A Cloud sandbox carries no user configuration, so jj and git have no author to
# name. Run 11727's `//evals/swebench:offline` warned "Name and email not
# configured. Until configured, your commits will be created with the empty
# identity", and its wave-11 predicate check then read a tree those commits
# could not produce. The identity is environment rather than a written-out user
# config file: no gate inherits state this script left on the host, and a
# developer reproducing a gate keeps whatever identity they already export.
export JJ_USER="${JJ_USER:-Smithers CI}"
export JJ_EMAIL="${JJ_EMAIL:-ci@smithers.sh}"
export GIT_AUTHOR_NAME="${GIT_AUTHOR_NAME:-$JJ_USER}"
export GIT_AUTHOR_EMAIL="${GIT_AUTHOR_EMAIL:-$JJ_EMAIL}"
export GIT_COMMITTER_NAME="${GIT_COMMITTER_NAME:-$JJ_USER}"
export GIT_COMMITTER_EMAIL="${GIT_COMMITTER_EMAIL:-$JJ_EMAIL}"

# Node's own `http` and `https` clients ignore `HTTP_PROXY` and `HTTPS_PROXY`;
# curl, npm and pnpm read them themselves, which is why every download this
# script performs already works. A Cloud runner pod has no direct egress at
# all — a NetworkPolicy drops every connect that is not kube-dns, the API or
# the Squid egress proxy — so a Node program that connects directly is not
# refused, it is blackholed, and the only symptom is that program's own
# timeout.
#
# That is `//apps/app:devkit` on runs 11723, 11727, 11734 and 11736: electrobun
# fetches its Hutch artifact index with `https.get`, the SYN went nowhere, and
# the gate reported "Hutch artifact index timed out". Every host that path
# needs is on the runner allowlist already (`github.com`,
# `githubusercontent.com`), and the Hutch binary it installs reads the proxy
# variables on its own; only Node had to be told.
#
# `NODE_USE_ENV_PROXY=1` makes Node's built-in clients read the same variables
# (the Node `ensure_node` pins from .node-version). Set only when a proxy is
# configured, so a developer reproducing a gate keeps direct connections.
if [ -n "${HTTPS_PROXY:-${https_proxy:-${HTTP_PROXY:-${http_proxy:-}}}}" ]; then
  export NODE_USE_ENV_PROXY=1
fi

# The status a gate exits with when it was never attempted, kept distinct from
# both success and failure so one task's report can say which it was. 75 is
# sysexits.h's EX_TEMPFAIL, which no gate command returns on its own.
gate_skipped=75

# Declares that a gate cannot run here and why, in the same `::gate` vocabulary
# the ok and fail markers use, so a reader of one task's log never has to infer
# a missing result from a gate that printed nothing.
skip_gate() {
  printf '::gate %s skipped (%s)\n' "$1" "$2"
  return "$gate_skipped"
}

# Whether this is a Cloud runner rather than a developer's machine. ci.tsx sets
# it on every task command; a single-gate local repro has root, a desktop and a
# package manager, so nothing below skips there.
on_cloud() { [ "${SMITHERS_CLOUD_CI:-}" = 1 ]; }

# Pinned Node for the Cloud runner. The image is Debian bookworm, whose distro
# nodejs is 18 with npm 9.2.0, so ensure_js's certified npm refused to install
# and every grouped task died in ~2 minutes before a single gate ran (run
# 11701, 2026-09-15):
#
#   npm ERR! code EBADENGINE
#   npm ERR! notsup Required: {"node":"^20.17.0 || >=22.9.0"}
#   npm ERR! notsup Actual:   {"npm":"9.2.0","node":"v18.19.0"}
#
# So bootstrap the official tarball first.
#
# The version is not written here. `.node-version` at the repo root holds the
# one Node every environment runs: actions/setup-node reads the same file
# through `node-version-file` in the generated ci.yml, and fnm, nvm and asdf
# read it on a developer's machine, so the Cloud runner, GitHub's runners and a
# laptop cannot drift onto three different releases the way they did before
# (package.json said >=22.19.0, ci.yml installed 22.19.0 and this script pinned
# 24.21.0).
#
# Parsed with sed rather than node, because the Node that would parse it is
# exactly what may be missing here. Prints the exact `x.y.z`, or fails: an
# unreadable pin must never fall back to a guess.
node_pinned_version() {
  local version
  if [ ! -f .node-version ]; then
    echo 'Missing .node-version at the repo root: it holds the one Node every environment runs' >&2
    return 1
  fi
  version="$(sed -n '1s/^[[:space:]]*v\{0,1\}\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)[[:space:]]*$/\1/p' .node-version)"
  if [ -z "$version" ]; then
    echo ".node-version must hold one exact Node release as x.y.z; found: $(head -c 100 .node-version)" >&2
    return 1
  fi
  printf '%s\n' "$version"
}

# The SHA-256 of one official Node artifact, keyed by version and architecture.
#
# The .tar.gz artifact is the one to take: the runner has no xz and cannot
# install one. Values are the `node-v<version>-linux-<arch>.tar.gz` lines of
# https://nodejs.org/dist/v<version>/SHASUMS256.txt.
#
# A version with no row here fails instead of downloading: a tarball this
# script cannot verify is a tarball it must not run. When `.node-version`
# moves, read that release's SHASUMS256.txt and add its row.
node_digest() {
  case "$1:$2" in
    26.5.0:x64) printf '22b5f47ad6ae78837e4c2b846019965ce1a06ba143de176102294a1bf44fc677\n' ;;
    26.5.0:arm64) printf '308e5fe89a82461ba5a6cf15ff5221b2cdbd7ae87600aa72bb3c3fbdc66412d1\n' ;;
    *)
      echo "No pinned SHA-256 digest for Node $1 on $2; add its digests from https://nodejs.org/dist/v$1/SHASUMS256.txt" >&2
      return 1
      ;;
  esac
}

# Read the supported floor without running Node: the installed runtime may be
# too old to start the JS toolchain. The root engines field is the same source
# runtime admission uses.
node_supported_floor() {
  local floor
  floor="$(sed -nE 's/^[[:space:]]*"node"[[:space:]]*:[[:space:]]*">=([0-9]+\.[0-9]+\.[0-9]+)"[[:space:]]*,?[[:space:]]*$/\1/p' package.json)"
  if [ -z "$floor" ]; then
    echo 'package.json engines.node must hold a >=x.y.z supported floor' >&2
    return 1
  fi
  printf '%s\n' "$floor"
}

node_version_at_least() {
  [[ "$1" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]] || return 1
  local have_major="${BASH_REMATCH[1]}" have_minor="${BASH_REMATCH[2]}" have_patch="${BASH_REMATCH[3]}"
  local required_major required_minor required_patch
  IFS=. read -r required_major required_minor required_patch <<< "$2"
  (( 10#$have_major > 10#$required_major ||
     (10#$have_major == 10#$required_major && 10#$have_minor > 10#$required_minor) ||
     (10#$have_major == 10#$required_major && 10#$have_minor == 10#$required_minor && 10#$have_patch >= 10#$required_patch) ))
}

ensure_node() {
  # Only the Cloud runner ships an unusable Node; the tarball is Linux-only and
  # developers reproducing a gate elsewhere use their own toolchain.
  if [ "$(uname -s)" != Linux ]; then
    echo "Skipping Node bootstrap on $(uname -s): $(node --version 2>/dev/null || echo 'no node')" >&2
    return 0
  fi
  local version required have
  version="$(node_pinned_version)" || exit 1
  required="$(node_supported_floor)" || exit 1
  if ! node_version_at_least "$version" "$required"; then
    echo "Pinned Node $version is below the supported floor $required" >&2
    exit 1
  fi
  have="$(node --version 2>/dev/null || true)"
  have="${have#v}"
  if node_version_at_least "$have" "$required"; then
    echo "Node $have meets the supported floor $required; keeping it" >&2
    return 0
  fi
  echo "Node ${have:-none} is below the supported floor $required; installing verified v$version" >&2
  # No apt here: the runner is an unprivileged container with no sudo, and the
  # gzip tarball needs only the curl and tar the image already ships.
  local arch sha
  case "$(uname -m)" in
    x86_64) arch=x64 ;;
    aarch64|arm64) arch=arm64 ;;
    *) echo 'Unsupported Node architecture' >&2; exit 1 ;;
  esac
  sha="$(node_digest "$version" "$arch")" || exit 1
  local tarball="$tools_dir/node-v$version-linux-$arch.tar.gz"
  mkdir -p "$tools_dir/node"
  download_verified "https://nodejs.org/dist/v$version/node-v$version-linux-$arch.tar.gz" "$tarball" "$sha"
  tar -xzf "$tarball" -C "$tools_dir/node" --strip-components=1
  # The global prefix stays ahead of the tarball's bundled npm so the certified
  # npm below still wins, while `node` now resolves to the version just added.
  export PATH="$tools_dir/bin:$tools_dir/node/bin:$PATH"
  hash -r
}

ensure_js() {
  ensure_node
  local package_manager
  package_manager="$(node -p 'require("./package.json").packageManager')"
  if [[ ! "$package_manager" =~ ^pnpm@[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "Expected an exact pnpm pin in package.json: $package_manager" >&2
    exit 1
  fi
  # Match ci.yml's certified npm, with a writable task-local global prefix.
  npm install --global --prefix "$tools_dir" npm@11.16.0 --ignore-scripts --no-audit --no-fund
  hash -r
  npm install --global --prefix "$tools_dir" "$package_manager" --ignore-scripts --no-audit --no-fund
  pnpm install --frozen-lockfile --ignore-scripts
  # Log what actually ran: EBADENGINE was invisible until someone read the tail.
  echo "Bootstrapped node $(node --version) npm $(npm --version)"
}

apt_install() {
  # Cloud runners are Debian. Developers reproducing a gate on macOS have these
  # packages already, so skip rather than fail.
  if [ "$(uname -s)" != Linux ] || ! command -v apt-get >/dev/null 2>&1; then
    echo "Skipping apt packages on $(uname -s): $*" >&2
    return 0
  fi
  local elevate=()
  if [ "$(id -u)" -ne 0 ]; then
    # Cloud runs each task as an unprivileged user in a container with no sudo
    # and no apt egress. Exiting 127 here killed every task in run 11706; skip
    # instead and let the gate fail on the tool it actually needs, if any.
    if ! command -v sudo >/dev/null 2>&1; then
      echo "Skipping apt packages: not root and no sudo: $*" >&2
      return 0
    fi
    elevate=(sudo)
  fi
  "${elevate[@]}" apt-get update -qq
  "${elevate[@]}" env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends "$@"
}

download() {
  curl --proto '=https' --tlsv1.2 --retry 3 -fsSL "$1" -o "$2"
}

# Downloads one artifact and refuses it unless it matches the pinned SHA-256.
# A version pin in the URL names a release; only the digest proves the bytes are
# the ones reviewed, so nothing downloaded here is unpacked or run before this.
download_verified() {
  download "$1" "$2" || exit 1
  if ! echo "$3  $2" | sha256sum -c -; then
    rm -f "$2"
    echo "Refusing $1: its SHA-256 does not match the pinned digest" >&2
    exit 1
  fi
}

# The SHA-256 of one pinned tool artifact, keyed by tool and architecture. The
# values come from each release's published checksums: the GitHub release
# asset `digest` for jj and Foundry, the `.sha256` file beside each ripgrep and
# rustup-init asset. A tool with no row fails instead of downloading.
tool_digest() {
  case "$1:$2" in
    jj-0.39.0:x86_64) printf '8da8d96e9c8696c21ad47847a63d533e249acb0449d9af0f0562b5ea7b024f04\n' ;;
    jj-0.39.0:aarch64) printf '15bbb0199adf57929d1e3cd90ae0b47356858cbe374814769815a1fb87d5ad1d\n' ;;
    ripgrep-14.1.1:x86_64-unknown-linux-musl) printf '4cf9f2741e6c465ffdb7c26f38056a59e2a2544b51f7cc128ef28337eeae4d8e\n' ;;
    ripgrep-14.1.1:aarch64-unknown-linux-gnu) printf 'c827481c4ff4ea10c9dc7a4022c8de5db34a5737cb74484d62eb94a95841ab2f\n' ;;
    foundry-1.8.1:amd64) printf '37b45855232e57624d90113b049ca54f0c92055bb5c1997fcbdc3076c7b89c10\n' ;;
    foundry-1.8.1:arm64) printf '27a32bd282d73018ab4d043de15ab0320b561c71b4bf3a549b130a0806e79f5c\n' ;;
    rustup-init-1.28.2:x86_64) printf '20a06e644b0d9bd2fbdbfd52d42540bdde820ea7df86e92e533c073da0cdd43c\n' ;;
    rustup-init-1.28.2:aarch64) printf 'e3853c5a252fca15252d07cb23a1bdd9377a8c6f3efa01531109281ae47f841c\n' ;;
    *)
      echo "No pinned SHA-256 digest for $1 on $2; add it from that release's published checksums" >&2
      return 1
      ;;
  esac
}

ensure_jj() {
  apt_install ca-certificates curl git xz-utils bubblewrap
  local arch sha
  case "$(uname -m)" in
    x86_64) arch=x86_64 ;;
    aarch64|arm64) arch=aarch64 ;;
    *) echo 'Unsupported Cloud CI architecture' >&2; exit 1 ;;
  esac
  mkdir -p "$tools_dir/bin"
  if ! command -v jj >/dev/null || [ "$(jj --version)" != 'jj 0.39.0' ]; then
    sha="$(tool_digest jj-0.39.0 "$arch")" || exit 1
    download_verified "https://github.com/jj-vcs/jj/releases/download/v0.39.0/jj-v0.39.0-${arch}-unknown-linux-musl.tar.gz" "$tools_dir/jj.tar.gz" "$sha"
    tar -xzf "$tools_dir/jj.tar.gz" -C "$tools_dir/bin" ./jj
  fi
  # rg's native implementation is exercised by the std conformance suite.
  if ! command -v rg >/dev/null || [[ "$(rg --version)" != 'ripgrep 14.1.1'* ]]; then
    local rg_target="${arch}-unknown-linux-gnu"
    if [ "$arch" = x86_64 ]; then rg_target=x86_64-unknown-linux-musl; fi
    sha="$(tool_digest ripgrep-14.1.1 "$rg_target")" || exit 1
    download_verified "https://github.com/BurntSushi/ripgrep/releases/download/14.1.1/ripgrep-14.1.1-${rg_target}.tar.gz" "$tools_dir/rg.tar.gz" "$sha"
    tar -xzf "$tools_dir/rg.tar.gz" -C "$tools_dir"
    ln -sf "$tools_dir/ripgrep-14.1.1-${rg_target}/rg" "$tools_dir/bin/rg"
  fi
  if [ ! -d .jj ]; then
    # `jj git init --colocate` refuses inside a LINKED git worktree, whose .git
    # is a file pointing at the main checkout — and a linked worktree is exactly
    # how a developer reproduces one gate without disturbing their tree. Cloud
    # gives each task a plain clone, so it still colocates there. Saying so and
    # carrying on beats `set -e` killing the gate before it runs.
    if [ -f .git ]; then
      echo "Skipping jj colocation: $PWD is a linked git worktree" >&2
    else
      jj git init --colocate
    fi
  fi
}

ensure_postgres() {
  # The NixOS image provides this in environment.systemPackages. The Debian
  # pool is unprivileged, so apt_install would silently skip it there; fail
  # before running the storage matrix rather than hiding a missing initdb.
  if ! command -v initdb >/dev/null 2>&1 || ! command -v pg_ctl >/dev/null 2>&1; then
    echo 'PostgreSQL 18 (initdb and pg_ctl) must be on PATH for the packages gate' >&2
    return 1
  fi
  local major
  major="$(pg_ctl --version | sed -n 's/^pg_ctl (PostgreSQL) \([0-9][0-9]*\).*/\1/p')"
  if [ -z "$major" ] || [ "$major" -lt 17 ]; then
    echo 'The packages gate needs PostgreSQL 17 or later (pg_c_utf8)' >&2
    return 1
  fi
}

ensure_foundry() {
  local arch sha
  case "$(uname -m)" in
    x86_64) arch=amd64 ;;
    aarch64|arm64) arch=arm64 ;;
    *) echo 'Unsupported Foundry architecture' >&2; exit 1 ;;
  esac
  sha="$(tool_digest foundry-1.8.1 "$arch")" || exit 1
  download_verified "https://github.com/foundry-rs/foundry/releases/download/v1.8.1/foundry_v1.8.1_linux_${arch}.tar.gz" "$tools_dir/foundry.tar.gz" "$sha"
  tar -xzf "$tools_dir/foundry.tar.gz" -C "$tools_dir/bin"
}

ensure_rust() {
  # The image has no Rust. Cargo metadata is also needed by the script suite.
  apt_install ca-certificates curl build-essential pkg-config libssl-dev
  # Install into whatever homes the environment already names. The Cloud image
  # exports CARGO_HOME=/workspace/.cargo and RUSTUP_HOME=/workspace/.rustup and
  # its gates resolve the toolchain against those; overriding them here put the
  # bootstrap's toolchain somewhere the gates never looked, so run 11727's rust
  # gates re-downloaded the pinned channel at gate time and timed out against
  # static.rust-lang.org. A task-local pair is the fallback, not the rule.
  export CARGO_HOME="${CARGO_HOME:-$tools_dir/cargo}" RUSTUP_HOME="${RUSTUP_HOME:-$tools_dir/rustup}"
  export PATH="$CARGO_HOME/bin:$PATH"
  if [ ! -x "$CARGO_HOME/bin/rustup" ]; then
    local arch sha
    case "$(uname -m)" in
      x86_64) arch=x86_64 ;;
      aarch64|arm64) arch=aarch64 ;;
      *) echo 'Unsupported Rust architecture' >&2; exit 1 ;;
    esac
    sha="$(tool_digest rustup-init-1.28.2 "$arch")" || exit 1
    download_verified "https://static.rust-lang.org/rustup/archive/1.28.2/${arch}-unknown-linux-gnu/rustup-init" "$tools_dir/rustup-init" "$sha"
    chmod +x "$tools_dir/rustup-init"
    "$tools_dir/rustup-init" -y --no-modify-path --profile minimal --default-toolchain none
  fi
  # Reads the channel, components and wasm target from rust-toolchain.toml.
  rustup toolchain install
}

# Builds the native workspace helper ci.yml's `cargoBinaries` step installs and
# names it the way that step does. Needs the rust toolchain from ensure_rust.
native_jj_export() {
  cargo build --locked -p smithers-ffi --bin smithers-jj-export
  mkdir -p "$tools_dir/native"
  install -m 755 target/debug/smithers-jj-export "$tools_dir/native/smithers-jj-export"
  export SMITHERS_WORKSPACE_JJ_EXPORT_BINARY="$tools_dir/native/smithers-jj-export"
}

# Toolchains each gate needs, one gate per line so the contract test can read
# them. Every gate needs js; the extras are what makes a group worth batching.
# An unknown gate returns non-zero here, which is how both modes reject it
# before any tool is installed.
gate_tools() {
  case "$1" in
    workspace) echo 'js jj foundry postgres' ;;
    packages) echo 'js jj foundry postgres' ;;
    examples) echo 'js jj' ;;
    scripts) echo 'js jj rust' ;;
    flows) echo 'js' ;;
    flows-egress) echo 'js' ;;
    flows-repository) echo 'js jj' ;;
    flows-fixtures) echo 'js jj' ;;
    flows-lint) echo 'js' ;;
    swebench-lint) echo 'js' ;;
    jsdoc) echo 'js' ;;
    script-lint) echo 'js' ;;
    jsdoc-rules) echo 'js' ;;
    factory-harness) echo 'js jj' ;;
    agent-eval) echo 'js' ;;
    agent-check) echo 'js' ;;
    authoring-eval) echo 'js' ;;
    authoring-check) echo 'js' ;;
    swebench) echo 'js jj' ;;
    swebench-check) echo 'js' ;;
    server) echo 'js jj' ;;
    review-app) echo 'js' ;;
    bug-worker) echo 'js' ;;
    project-copy) echo 'js' ;;
    site) echo 'js' ;;
    docs) echo 'js' ;;
    review-eval) echo 'js' ;;
    review-check) echo 'js' ;;
    recommend-eval) echo 'js' ;;
    recommend-check) echo 'js' ;;
    workflow-drift) echo 'js' ;;
    factory-drift) echo 'js' ;;
    target-index) echo 'js' ;;
    ui-check) echo 'js jj' ;;
    ui-tests) echo 'js jj' ;;
    ui-conformance) echo 'js jj' ;;
    ui-browser) echo 'js jj' ;;
    tui) echo 'js jj rust' ;;
    rust-lint) echo 'js rust' ;;
    third-party-notices) echo 'js rust' ;;
    rust-test) echo 'js rust' ;;
    native-ffi) echo 'js jj rust' ;;
    backend-go) echo 'js' ;;
    wasm-build-script) echo 'js' ;;
    faults) echo 'js jj' ;;
    web-bundle) echo 'js' ;;
    cloud-contract) echo 'js' ;;
    *) return 1 ;;
  esac
}

# Installs the union of the toolchains the given gates need, once each, in
# dependency order. This is the whole point of group mode: ensure_js alone is
# ~11 minutes on a Cloud runner and it used to run once per gate.
bootstrap_for() {
  local gate tool wanted=' '
  for gate in "$@"; do
    for tool in $(gate_tools "$gate"); do
      case "$wanted" in
        *" $tool "*) ;;
        *) wanted="$wanted$tool " ;;
      esac
    done
  done
  for tool in js jj foundry rust postgres; do
    case "$wanted" in
      *" $tool "*) ;;
      *) continue ;;
    esac
    case "$tool" in
      js) ensure_js ;;
      jj) ensure_jj ;;
      foundry) ensure_foundry ;;
      rust) ensure_rust ;;
      postgres) ensure_postgres ;;
    esac
  done
}

# Gate commands below are copied from .github/workflows/ci.yml. Remote cache
# credentials are optional for checks; no task receives publishing credentials.
# Docker integration cases retain their existing no-daemon skip behavior.
# Omitted: credentialed cache publishing/model reviews, the macOS/Windows
# matrix, and wasm byte reproducibility (requires its canonical x86_64 host).
# Bootstrap belongs to bootstrap_for, so single-gate and group mode share this.
run_gate() {
  case "$1" in
    workspace)
      pnpm exec smthrs ci '//packages/...' --jobs 2 --known-red '.github/ci-known-red.json' --verbose
      ;;
    examples)
      pnpm exec smthrs ci '//examples/...' --known-red '.github/ci-known-red.json' --verbose
      ;;
    scripts)
      pnpm exec smthrs test '//scripts/...' --known-red '.github/ci-known-red.json' --verbose
      ;;
    flows)
      pnpm exec smthrs test '//flows:pack' --known-red '.github/ci-known-red.json' --verbose
      ;;
    flows-egress)
      pnpm exec smthrs test '//flows:egress' --known-red '.github/ci-known-red.json' --verbose
      ;;
    flows-repository)
      pnpm exec smthrs test '//flows:repository' --known-red '.github/ci-known-red.json' --verbose
      ;;
    flows-fixtures)
      pnpm exec smthrs test '//flows:fixtures' --known-red '.github/ci-known-red.json' --verbose
      ;;
    flows-lint)
      pnpm exec smthrs lint '//flows/...' --known-red '.github/ci-known-red.json' --verbose
      ;;
    swebench-lint)
      pnpm exec smthrs lint '//evals/swebench/...' --known-red '.github/ci-known-red.json' --verbose
      ;;
    jsdoc)
      pnpm exec smthrs lint '//:jsdocTree' --known-red '.github/ci-known-red.json' --verbose
      ;;
    script-lint)
      pnpm exec smthrs lint '//scripts:lint' --known-red '.github/ci-known-red.json' --verbose
      ;;
    jsdoc-rules)
      pnpm exec smthrs test '//:jsdocRules' --known-red '.github/ci-known-red.json' --verbose
      ;;
    factory-harness)
      pnpm exec smthrs test '//:factoryHarness' --known-red '.github/ci-known-red.json' --verbose
      ;;
    agent-eval)
      pnpm exec smthrs test '//evals/agent:test' --known-red '.github/ci-known-red.json' --verbose
      ;;
    agent-check)
      pnpm exec smthrs build '//evals/agent:check' --known-red '.github/ci-known-red.json' --verbose
      ;;
    authoring-eval)
      pnpm exec smthrs test '//evals/authoring:test' --known-red '.github/ci-known-red.json' --verbose
      ;;
    authoring-check)
      pnpm exec smthrs build '//evals/authoring:check' --known-red '.github/ci-known-red.json' --verbose
      ;;
    swebench)
      pnpm exec smthrs test '//evals/swebench:offline' --jobs 1 --known-red '.github/ci-known-red.json' --verbose
      ;;
    swebench-check)
      pnpm exec smthrs build '//evals/swebench:check' --known-red '.github/ci-known-red.json' --verbose
      ;;
    server)
      pnpm exec smthrs ci '//apps/server/...' --known-red '.github/ci-known-red.json' --verbose
      ;;
    review-app)
      pnpm exec smthrs ci '//apps/review/...' --known-red '.github/ci-known-red.json' --verbose
      ;;
    bug-worker)
      pnpm exec smthrs ci '//apps/bug-worker/...' --known-red '.github/ci-known-red.json' --verbose
      ;;
    project-copy)
      pnpm exec smthrs lint '//:projectCopy' --known-red '.github/ci-known-red.json' --verbose
      ;;
    site)
      pnpm exec smthrs ci '//apps/site/...' --known-red '.github/ci-known-red.json' --verbose
      ;;
    docs)
      pnpm exec smthrs ci '//apps/docs/...' --known-red '.github/ci-known-red.json' --verbose
      pnpm exec smthrs run '//apps/tui-docs:check' --verbose
      pnpm exec smthrs test '//apps/tui-docs:test' --verbose
      ;;
    review-eval)
      pnpm exec smthrs test '//evals/review-seeded-bugs/...' --known-red '.github/ci-known-red.json' --verbose
      ;;
    review-check)
      pnpm exec smthrs build '//evals/review-seeded-bugs:check' --known-red '.github/ci-known-red.json' --verbose
      ;;
    recommend-eval)
      pnpm exec smthrs test '//evals/recommend/...' --known-red '.github/ci-known-red.json' --verbose
      ;;
    recommend-check)
      pnpm exec smthrs build '//evals/recommend:check' --known-red '.github/ci-known-red.json' --verbose
      ;;
    workflow-drift)
      pnpm exec smthrs lint '//:ci' --known-red '.github/ci-known-red.json' --verbose
      ;;
    factory-drift)
      pnpm exec smthrs lint '//:factoryProjection' --known-red '.github/ci-known-red.json' --verbose
      ;;
    target-index)
      # Run 11763 (main 2722d0e5) failed `checks` on this gate alone, the third
      # time that day: `.smithers/target-index.json` is derived from every
      # PACKAGE.ts, so any lane that adds a target or changes a target's
      # declared inputs re-keys it, and a lane that does not regenerate lands a
      # stale file that only Cloud notices.
      #
      # Off Cloud and outside any other automation this gate therefore repairs
      # first and verifies second, so a developer who runs it before pushing
      # ends up with the regenerated file in the working tree instead of a red
      # Cloud run. On Cloud, and under any inherited CI, it stays a pure drift
      # check: repairing there would hide exactly the stale commit it exists to
      # catch. `pnpm run target-index` is the same write, on its own.
      if ! on_cloud && [ "$host_ci" != true ]; then
        pnpm exec smthrs target '//:targetIndex' --write --verbose
      fi
      pnpm exec smthrs lint '//:targetIndex' --known-red '.github/ci-known-red.json' --verbose
      ;;
    ui-check)
      pnpm exec smthrs build '//apps/app:check' --known-red '.github/ci-known-red.json' --verbose
      ;;
    ui-tests)
      pnpm exec smthrs test '//apps/app:unitTests' --known-red '.github/ci-known-red.json' --verbose
      ;;
    ui-conformance)
      pnpm exec smthrs test '//apps/app:conformance' --known-red '.github/ci-known-red.json' --verbose
      ;;
    ui-browser)
      # Playwright installs the browsers' own system libraries through the
      # distribution package manager as root. A Cloud task is an unprivileged
      # user in a container with no sudo, so run 11727 got "Switching to root
      # user to install dependencies... Authentication failure" and "Failed to
      # install browsers" before a single test ran. No amount of allowlisting
      # fixes that; the gate needs a host this tier does not offer.
      if on_cloud; then
        skip_gate ui-browser 'Playwright browser system dependencies need root, which Cloud runners do not have'
      else
        pnpm exec smthrs test '//apps/app:browserE2e' --known-red '.github/ci-known-red.json' --verbose
      fi
      ;;
    tui)
      native_jj_export
      pnpm exec smthrs ci '//apps/tui/...' --known-red '.github/ci-known-red.json' --verbose
      ;;
    rust-lint)
      pnpm exec smthrs lint '//crates/flows-jj/...' --known-red '.github/ci-known-red.json' --verbose
      ;;
    third-party-notices)
      pnpm exec smthrs test '//scripts:thirdPartyNotices' --known-red '.github/ci-known-red.json' --verbose
      ;;
    rust-test)
      pnpm exec smthrs test '//crates/flows-jj:cargoTest' --known-red '.github/ci-known-red.json' --verbose
      ;;
    native-ffi)
      pnpm exec smthrs build '//:nativeFfi' --known-red '.github/ci-known-red.json' --verbose
      ;;
    backend-go)
      # `//:backendGo` needs the Go 1.26 toolchain and a Postgres container
      # started through Docker (the `backendPostgres` service in PACKAGE.ts).
      # A Cloud runner is an unprivileged gVisor sandbox with neither, and
      # gate_tools installs only js, jj, Foundry and Rust, so on Cloud this
      # skips; GitHub's `go-backend` job remains the required gate.
      if on_cloud; then
        skip_gate backend-go 'the Go toolchain and a Docker Postgres service are not available on Cloud runners'
      else
        pnpm exec smthrs test '//:backendGo' --known-red '.github/ci-known-red.json' --verbose
      fi
      ;;
    wasm-build-script)
      pnpm exec smthrs test '//crates/flows-jj:buildScript' --known-red '.github/ci-known-red.json' --verbose
      ;;
    faults)
      pnpm exec smthrs test '//packages/...:faults' --jobs 1 --known-red '.github/ci-known-red.json' --verbose
      ;;
    web-bundle)
      pnpm exec smthrs test '//scripts:webBundleContract' --known-red '.github/ci-known-red.json' --verbose
      ;;
    packages)
      pnpm exec smthrs test '//packages/...' --jobs 2 --known-red '.github/ci-known-red.json' --verbose
      ;;
    cloud-contract)
      bun test scripts/ci/cloud.test.ts
      ;;
    *)
      echo "Unknown Cloud CI gate: $1" >&2
      return 2
      ;;
  esac
}

# Runs one gate in a subshell and leaves its exit status in $gate_status.
# Bash suspends `set -e` for everything left of `||` or `&&` or tested by `if`,
# functions and subshells included, so `(run_gate) || status=$?` let the
# docs and tui gates report OK whenever only their last command was green.
# Here the subshell is a plain statement, so its own `set -e` stays in force.
run_gate_checked() {
  set +e
  (set -e; run_gate "$1")
  gate_status=$?
  set -e
}

# One task, many gates: bootstrap once, then report every gate's result.
run_group() {
  local gate status failed=''
  if [ "$#" -eq 0 ]; then
    echo 'Unknown Cloud CI gate: missing' >&2
    exit 2
  fi
  for gate in "$@"; do
    if ! gate_tools "$gate" >/dev/null; then
      echo "Unknown Cloud CI gate: $gate" >&2
      exit 2
    fi
  done
  bootstrap_for "$@"
  for gate in "$@"; do
    printf '::gate %s start\n' "$gate"
    # A subshell keeps one gate's cwd and shell state out of the next one.
    run_gate_checked "$gate"
    status=$gate_status
    case "$status" in
      0) printf '::gate %s ok\n' "$gate" ;;
      # skip_gate already printed the marker and the reason for it.
      "$gate_skipped") ;;
      *)
        printf '::gate %s fail\n' "$gate"
        failed="$failed $gate"
        ;;
    esac
  done
  if [ -n "$failed" ]; then
    printf 'GATE-FAIL%s\n' "$failed" >&2
    return 1
  fi
  printf 'GROUP-OK %s\n' "$*"
}

if [ "${1:-}" = group ]; then
  shift
  run_group "$@"
  exit 0
fi
if ! gate_tools "${1:-}" >/dev/null; then
  echo "Unknown Cloud CI gate: ${1:-missing}" >&2
  exit 2
fi
bootstrap_for "$1"
run_gate_checked "$1"
if [ "$gate_status" -eq "$gate_skipped" ]; then exit 0; fi
if [ "$gate_status" -ne 0 ]; then exit "$gate_status"; fi
printf 'GATE-OK %s\n' "$1"
