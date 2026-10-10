#!/bin/zsh
# One-time, idempotent setup of the reference-host GitHub Actions runner on
# the Mac mini (#3471, path 1). A credential holder runs it as root:
#
#   sudo zsh setup-runner.sh            # host setup; no token, no network registration
#   sudo zsh setup-runner.sh register   # reads a single-use registration token from stdin
#   sudo zsh setup-runner.sh receipt    # prints the receipt again, changes nothing
#
# job-started.sh must sit next to this file. Both come from scripts/reference-host/.
#
# Decision record: smithers-3f, #3471 issuecomment-6020436303. A persistent
# runner as the non-admin user ghrunner, its workspace wiped before every job by
# a root-owned hook, and no stored credential that can mint runner
# registrations. The registration token is read from stdin, handed to
# config.sh through its ACTIONS_RUNNER_INPUT_TOKEN environment input (never
# argv, so ps cannot show it), and never written to disk.
#
# What `setup` changes, each step skipped when already in place:
#   1. group ghrunner and user ghrunner (primary group ghrunner, not staff;
#      not an admin; hidden; random password that is printed nowhere)
#   2. the operator's home (the account that ran sudo) to mode 0700 (its ACL is kept)
#   3. /opt/reference-host: bun, node, pnpm and go, root:wheel, read-only,
#      every archive checked against a pinned SHA-256 (sha512 for pnpm)
#   4. /usr/local/libexec/smithers-reference-host/job-started.sh, root:wheel 0555
#   5. ghrunner's home/actions-runner: the official runner, downloaded as
#      ghrunner and checked against the release's published SHA-256
#   6. /Library/LaunchDaemons/org.smithers.reference-host-runner.plist,
#      UserName ghrunner, written but not loaded until `register`
set -eu
setopt pipefail

readonly RUNNER_USER=ghrunner
readonly RUNNER_HOME=/Users/$RUNNER_USER
readonly RUNNER_DIR=$RUNNER_HOME/actions-runner
readonly RUNNER_VERSION=2.338.0
# Published in the v2.338.0 release notes ("BEGIN SHA osx-arm64") and as the
# asset digest of actions-runner-osx-arm64-2.338.0.tar.gz.
readonly RUNNER_SHA256=df4cebda25c86a886ed204e49fee63f5c2e7cec5f447b5c98440a826bbdf9df2
readonly REPO_URL=https://github.com/smithersai/smithers
readonly RUNNER_NAME=reference-host-mac-mini
# The operator is the account that ran sudo; its home is read from the directory service.
readonly OPERATOR=${SUDO_USER:?run through sudo from the operator account: sudo zsh setup-runner.sh}
readonly OPERATOR_HOME=$(/usr/bin/dscl . -read /Users/$OPERATOR NFSHomeDirectory | /usr/bin/awk '{print $2}')
readonly TOOLS=/opt/reference-host
readonly HOOK_DIR=/usr/local/libexec/smithers-reference-host
readonly HOOK=$HOOK_DIR/job-started.sh
readonly LABEL=org.smithers.reference-host-runner
readonly PLIST=/Library/LaunchDaemons/$LABEL.plist
readonly RUNNER_PATH=$TOOLS/bin:/usr/bin:/bin:/usr/sbin:/sbin
# Toolchain pins: package.json engines/packageManager, .node-version, go.mod
# and the bun version CI installs. Hashes are the publishers' own:
# nodejs.org SHASUMS256.txt, the bun release's SHASUMS256.txt, go.dev/dl, and
# the npm registry's dist.integrity for pnpm.
readonly NODE_VERSION=26.5.0
readonly NODE_SHA256=ee920559aaa2391569cff4d737e3b83963430e3a14dedd91bfe0ff53171b5af9
readonly BUN_VERSION=1.4.1
readonly BUN_SHA256=d8973ce835fa7867e5cc79afee6fc6f1ae0117aa4bd5fc2546fd00c512f71386
readonly GO_VERSION=1.26.8
readonly GO_SHA256=a012b25b571bd0138a03dcd25375ceba866fe5ca822f426d2c66a4de56fd3f4b
readonly PNPM_VERSION=11.25.0
readonly PNPM_SHA512_B64='XN6SW08HX3Jetx+64YpC/+eEUkeJ8ZthxzHLhyHsKKruFg4BqNWvT+2ypCzb8wDv4j2zVrDUoXtNY+EfirfJVg=='

readonly HERE=${0:A:h}
mode=${1:-setup}

say() { print -r -- "[reference-host] $*"; }
die() { print -r -- "[reference-host] error: $*" >&2; exit 1; }
as_runner() { /usr/bin/sudo -u "$RUNNER_USER" -H "$@"; }

[[ $(id -u) -eq 0 ]] || die "run as root: sudo zsh $0 ${mode}"
[[ $(uname -s) == Darwin && $(uname -m) == arm64 ]] || die "this is the macOS arm64 reference host setup"

# Download $1 to $2 and check its SHA-256 is $3. Removes the file on mismatch.
fetch_sha256() {
  /usr/bin/curl -fsSL --retry 3 -o "$2" "$1"
  local got=$(/usr/bin/shasum -a 256 "$2" | /usr/bin/awk '{print $1}')
  [[ $got == "$3" ]] || { rm -f "$2"; die "SHA-256 mismatch for $1: got $got, want $3"; }
  say "verified $1 sha256=$got"
}

ensure_user() {
  if ! /usr/bin/dscl . -read /Groups/$RUNNER_USER >/dev/null 2>&1; then
    /usr/sbin/dseditgroup -o create -r "GitHub Actions runner" $RUNNER_USER
    say "created group $RUNNER_USER"
  fi
  local gid=$(/usr/bin/dscl . -read /Groups/$RUNNER_USER PrimaryGroupID | /usr/bin/awk '{print $2}')
  if ! /usr/bin/id $RUNNER_USER >/dev/null 2>&1; then
    # The password is generated, used once by sysadminctl and never shown.
    /usr/sbin/sysadminctl -addUser $RUNNER_USER -fullName "GitHub Actions runner" \
      -GID "$gid" -home $RUNNER_HOME -shell /usr/bin/false -password "$(/usr/bin/openssl rand -base64 33)" 2>&1 |
      /usr/bin/grep -v -i password || true
    /usr/bin/id $RUNNER_USER >/dev/null 2>&1 || die "sysadminctl did not create $RUNNER_USER"
    say "created user $RUNNER_USER"
  fi
  /usr/bin/dscl . -create /Users/$RUNNER_USER PrimaryGroupID "$gid"
  /usr/bin/dscl . -create /Users/$RUNNER_USER UserShell /usr/bin/false
  /usr/bin/dscl . -create /Users/$RUNNER_USER IsHidden 1
  /usr/sbin/dseditgroup -o edit -d $RUNNER_USER -t user admin 2>/dev/null || true
  /usr/sbin/dseditgroup -o edit -d $RUNNER_USER -t user staff 2>/dev/null || true
  [[ $(/usr/sbin/dseditgroup -o checkmember -m $RUNNER_USER admin 2>&1) == no* ]] || die "$RUNNER_USER is an admin"
  [[ -d $RUNNER_HOME ]] || /usr/sbin/createhomedir -c -u $RUNNER_USER >/dev/null
  /usr/sbin/chown -R $RUNNER_USER:$RUNNER_USER $RUNNER_HOME
  /bin/chmod 0700 $RUNNER_HOME
}

lock_operator_home() {
  local before=$(/usr/bin/stat -f %Sp $OPERATOR_HOME)
  /bin/chmod 0700 $OPERATOR_HOME
  say "$OPERATOR_HOME mode $before -> $(/usr/bin/stat -f %Sp $OPERATOR_HOME) (ACL kept)"
}

# Install one tool into $TOOLS/$1 from archive URL $2 with SHA-256 $3,
# extracted by the function named $4. Skipped when the marker matches.
install_tool() {
  local dir=$TOOLS/$1 url=$2 sha=$3 unpack=$4
  if [[ -f $dir/.sha256 && $(<$dir/.sha256) == "$sha" ]]; then say "$1 already installed"; return; fi
  local scratch=$(/usr/bin/mktemp -d /private/tmp/reference-host-setup.XXXXXX)
  fetch_sha256 "$url" "$scratch/archive" "$sha"
  rm -rf "$dir"; mkdir -p "$dir"
  $unpack "$scratch/archive" "$dir"
  print -r -- "$sha" >"$dir/.sha256"
  rm -rf "$scratch"
}
unpack_strip() { /usr/bin/tar -xzf "$1" -C "$2" --strip-components 1; }
unpack_bun() { /usr/bin/ditto -x -k "$1" "$2.zip.d" && mv "$2.zip.d/bun-darwin-aarch64/bun" "$2/bun" && rm -rf "$2.zip.d"; }

install_tools() {
  mkdir -p $TOOLS/bin
  install_tool node-v$NODE_VERSION https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-darwin-arm64.tar.gz $NODE_SHA256 unpack_strip
  install_tool bun-v$BUN_VERSION https://github.com/oven-sh/bun/releases/download/bun-v$BUN_VERSION/bun-darwin-aarch64.zip $BUN_SHA256 unpack_bun
  install_tool go$GO_VERSION https://go.dev/dl/go$GO_VERSION.darwin-arm64.tar.gz $GO_SHA256 unpack_strip
  local pnpm=$TOOLS/pnpm-$PNPM_VERSION
  if [[ ! -f $pnpm/.sha512 || $(<$pnpm/.sha512) != "$PNPM_SHA512_B64" ]]; then
    local scratch=$(/usr/bin/mktemp -d /private/tmp/reference-host-setup.XXXXXX)
    /usr/bin/curl -fsSL --retry 3 -o "$scratch/pnpm.tgz" https://registry.npmjs.org/pnpm/-/pnpm-$PNPM_VERSION.tgz
    local got=$(/usr/bin/openssl dgst -sha512 -binary "$scratch/pnpm.tgz" | /usr/bin/base64)
    [[ $got == "$PNPM_SHA512_B64" ]] || die "sha512 mismatch for pnpm $PNPM_VERSION: got $got"
    say "verified pnpm-$PNPM_VERSION.tgz sha512=$got"
    rm -rf "$pnpm"; mkdir -p "$pnpm"
    unpack_strip "$scratch/pnpm.tgz" "$pnpm"
    print -r -- "$PNPM_SHA512_B64" >"$pnpm/.sha512"
    rm -rf "$scratch"
  else
    say "pnpm-$PNPM_VERSION already installed"
  fi
  ln -sfn ../node-v$NODE_VERSION/bin/node $TOOLS/bin/node
  ln -sfn ../bun-v$BUN_VERSION/bun $TOOLS/bin/bun
  ln -sfn ../go$GO_VERSION/bin/go $TOOLS/bin/go
  ln -sfn ../go$GO_VERSION/bin/gofmt $TOOLS/bin/gofmt
  print -r -- "#!/bin/sh
exec $TOOLS/bin/node $pnpm/bin/pnpm.cjs \"\$@\"" >$TOOLS/bin/pnpm
  /usr/sbin/chown -R root:wheel $TOOLS
  /bin/chmod -R u+rwX,go+rX,go-w $TOOLS
  /bin/chmod 0755 $TOOLS/bin/pnpm
}

install_hook() {
  [[ -f $HERE/job-started.sh ]] || die "job-started.sh must sit next to $0"
  mkdir -p $HOOK_DIR
  /usr/sbin/chown root:wheel /usr/local/libexec $HOOK_DIR
  /bin/chmod 0755 /usr/local/libexec $HOOK_DIR
  /usr/bin/install -o root -g wheel -m 0555 "$HERE/job-started.sh" $HOOK
  say "installed $HOOK sha256=$(/usr/bin/shasum -a 256 $HOOK | /usr/bin/awk '{print $1}')"
}

install_runner() {
  if [[ -x $RUNNER_DIR/bin/Runner.Listener ]]; then
    say "runner already unpacked at $RUNNER_DIR (it self-updates; not replaced)"
  else
    local archive=$RUNNER_HOME/actions-runner-osx-arm64-$RUNNER_VERSION.tar.gz
    as_runner /usr/bin/curl -fsSL --retry 3 -o "$archive" \
      https://github.com/actions/runner/releases/download/v$RUNNER_VERSION/actions-runner-osx-arm64-$RUNNER_VERSION.tar.gz
    local got=$(/usr/bin/shasum -a 256 "$archive" | /usr/bin/awk '{print $1}')
    [[ $got == "$RUNNER_SHA256" ]] || { rm -f "$archive"; die "runner SHA-256 mismatch: got $got, want $RUNNER_SHA256"; }
    say "verified actions-runner-osx-arm64-$RUNNER_VERSION.tar.gz sha256=$got"
    as_runner /bin/mkdir -p $RUNNER_DIR
    as_runner /usr/bin/tar -xzf "$archive" -C $RUNNER_DIR
    rm -f "$archive"
  fi
  as_runner /bin/cp -f $RUNNER_DIR/bin/runsvc.sh $RUNNER_DIR/runsvc.sh
  as_runner /bin/chmod 0755 $RUNNER_DIR/runsvc.sh
  as_runner /bin/mkdir -p $RUNNER_HOME/Library/Logs/$LABEL
  # config.sh's env.sh keeps lines already in .env and appends only missing ones.
  as_runner /usr/bin/touch $RUNNER_DIR/.env
  if ! /usr/bin/grep -qx "ACTIONS_RUNNER_HOOK_JOB_STARTED=$HOOK" $RUNNER_DIR/.env; then
    as_runner /bin/sh -c "grep -v '^ACTIONS_RUNNER_HOOK_JOB_STARTED=' '$RUNNER_DIR/.env' >'$RUNNER_DIR/.env.new' || true
      printf '%s\n' 'ACTIONS_RUNNER_HOOK_JOB_STARTED=$HOOK' >>'$RUNNER_DIR/.env.new'
      mv '$RUNNER_DIR/.env.new' '$RUNNER_DIR/.env'"
  fi
  as_runner /bin/chmod 0600 $RUNNER_DIR/.env
}

install_daemon() {
  local tmp=$(/usr/bin/mktemp /private/tmp/reference-host-plist.XXXXXX)
  cat >"$tmp" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
      <string>$RUNNER_DIR/runsvc.sh</string>
    </array>
    <key>UserName</key>
    <string>$RUNNER_USER</string>
    <key>GroupName</key>
    <string>$RUNNER_USER</string>
    <key>WorkingDirectory</key>
    <string>$RUNNER_DIR</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$RUNNER_HOME/Library/Logs/$LABEL/stdout.log</string>
    <key>StandardErrorPath</key>
    <string>$RUNNER_HOME/Library/Logs/$LABEL/stderr.log</string>
    <key>EnvironmentVariables</key>
    <dict>
      <key>ACTIONS_RUNNER_SVC</key>
      <string>1</string>
      <key>ACTIONS_RUNNER_HOOK_JOB_STARTED</key>
      <string>$HOOK</string>
      <key>HOME</key>
      <string>$RUNNER_HOME</string>
      <key>PATH</key>
      <string>$RUNNER_PATH</string>
    </dict>
    <key>ProcessType</key>
    <string>Interactive</string>
    <key>SessionCreate</key>
    <true/>
  </dict>
</plist>
PLIST
  /usr/bin/plutil -lint "$tmp" >/dev/null
  if [[ -f $PLIST ]] && /usr/bin/cmp -s "$tmp" $PLIST; then
    rm -f "$tmp"; say "$PLIST unchanged"
  else
    /usr/bin/install -o root -g wheel -m 0644 "$tmp" $PLIST; rm -f "$tmp"; say "wrote $PLIST"
  fi
}

# Try each read as ghrunner. Every line must say DENIED.
probe_denied_reads() {
  say "denied-read probe as $RUNNER_USER (each must be DENIED):"
  local target
  for target in \
    $OPERATOR_HOME \
    $OPERATOR_HOME/.smithers \
    $OPERATOR_HOME/.ssh \
    $OPERATOR_HOME/.ssh/id_ed25519 \
    $OPERATOR_HOME/.config/gh/hosts.yml \
    "$OPERATOR_HOME/Library/Application Support" \
    $OPERATOR_HOME/Library/Keychains \
    $OPERATOR_HOME/lanes; do
    if as_runner /bin/ls -d "$target/." >/dev/null 2>&1 || as_runner /bin/cat "$target" >/dev/null 2>&1; then
      say "  READABLE  $target"; probe_failed=1
    else
      say "  DENIED    $target ($(as_runner /bin/ls "$target" 2>&1 >/dev/null | /usr/bin/head -1))"
    fi
  done
  local exposed=$(/usr/bin/find /private/tmp -maxdepth 2 -user $OPERATOR -perm -004 -type f 2>/dev/null | /usr/bin/wc -l | /usr/bin/tr -d ' ')
  say "  note: $exposed world-readable $OPERATOR files under /private/tmp (lane scratch; outside this setup)"
}

receipt() {
  probe_failed=0
  say "receipt $(/bin/date -u +%Y-%m-%dT%H:%M:%SZ) on $(/bin/hostname)"
  say "id: $(/usr/bin/id $RUNNER_USER)"
  say "admin member: $(/usr/sbin/dseditgroup -o checkmember -m $RUNNER_USER admin 2>&1)"
  say "shell: $(/usr/bin/dscl . -read /Users/$RUNNER_USER UserShell | /usr/bin/awk '{print $2}')"
  /bin/ls -lde $OPERATOR_HOME $RUNNER_HOME
  /bin/ls -ld $TOOLS $TOOLS/bin $HOOK_DIR $HOOK
  /bin/ls -l $TOOLS/bin
  say "hook sha256 $(/usr/bin/shasum -a 256 $HOOK | /usr/bin/awk '{print $1}')"
  say "tools: node $($TOOLS/bin/node --version) bun $($TOOLS/bin/bun --version) pnpm $(as_runner /bin/sh -c "cd / && $TOOLS/bin/pnpm --version") $($TOOLS/bin/go version)"
  local root_only
  for root_only in $HOOK $HOOK_DIR $TOOLS $TOOLS/bin $TOOLS/node-v$NODE_VERSION/bin $PLIST; do
    if as_runner /bin/test -w $root_only; then say "WRITABLE by $RUNNER_USER: $root_only"; probe_failed=1; fi
  done
  /bin/ls -l $PLIST
  local f
  for f in .runner .credentials .credentials_rsaparams .env; do
    [[ -e $RUNNER_DIR/$f ]] && /bin/ls -l $RUNNER_DIR/$f || say "$RUNNER_DIR/$f absent"
  done
  say "daemon: $(/bin/launchctl print system/$LABEL 2>/dev/null | /usr/bin/awk '/state =|pid =/ {printf "%s ", $0}' || true)"
  probe_denied_reads
  (( probe_failed == 0 )) || die "receipt found a failed control (see above)"
  say "receipt ok"
}

register() {
  [[ -x $RUNNER_DIR/config.sh && -f $PLIST && -x $HOOK ]] || die "run setup first: sudo zsh $0"
  if [[ -f $RUNNER_DIR/.runner ]]; then
    say "runner already registered: $(/usr/bin/grep -o '"agentName": *"[^"]*"' $RUNNER_DIR/.runner)"
  else
    say "paste the single-use registration token, then press return (input hidden):"
    local token
    read -rs token
    print
    [[ $token =~ ^[A-Z0-9]{20,}$ ]] || die "that does not look like a registration token"
    # The token reaches config.sh on a pipe and in its environment, never in argv.
    print -r -- "$token" | as_runner /bin/sh -c "
      read -r ACTIONS_RUNNER_INPUT_TOKEN; export ACTIONS_RUNNER_INPUT_TOKEN
      cd '$RUNNER_DIR' && PATH='$RUNNER_PATH' exec ./config.sh --unattended --url '$REPO_URL' \
        --name '$RUNNER_NAME' --labels reference-host --work _work --replace"
    token=''
  fi
  local f
  for f in .runner .credentials .credentials_rsaparams; do
    [[ -f $RUNNER_DIR/$f ]] || die "$RUNNER_DIR/$f missing after config.sh"
    /usr/sbin/chown $RUNNER_USER:$RUNNER_USER $RUNNER_DIR/$f
    /bin/chmod 0600 $RUNNER_DIR/$f
  done
  if /bin/launchctl print system/$LABEL >/dev/null 2>&1; then
    /bin/launchctl kickstart -k system/$LABEL
  else
    /bin/launchctl bootstrap system $PLIST
  fi
  say "started system/$LABEL"
  say "next: once the runner shows online, a lane runs: gh variable set REFERENCE_HOST_ONLINE --body true -R smithersai/smithers"
}

case $mode in
  setup)
    ensure_user
    lock_operator_home
    install_tools
    install_hook
    install_runner
    install_daemon
    receipt
    say "next: a lane sets fork PR approval to all_external_contributors and mints a token; then sudo zsh $0 register"
    ;;
  register) register; receipt ;;
  receipt) receipt ;;
  *) die "usage: sudo zsh $0 [setup|register|receipt]" ;;
esac
