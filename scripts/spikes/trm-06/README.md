# T-TRM-06 disposable session probe

**Incomplete; activation refused.** No real C-SPK-08 result, VS Code recording,
revocation/RSS measurement or accepted root-validation receipt has been produced.
The lead holds #3554. No product registration exists. Delete this directory when
T-TRM-07 records the validated result.

`run.sh`, `revoke.sh`, `flow.sh` and the gateway executable still exit 78 before
root setup, relay or listening. Arguments, files containing `accepted: true`,
PATH, import paths and environment switches cannot enable them. The supervisor
also refuses root startup. Its fixed TCP worker mode checks the already dropped
Ben/agent UID, GID and supplementary team group before connecting to guest
loopback; it cannot start as root or as another user.

## Built adapters

- Frames: strict tagged JSON behind a four-byte big-endian length; `data`,
  `eof`, `resize`, `signal`, `exit`, `exit_signal`, `window`, `close`. Envelopes
  are at most 65,536 bytes; data at most 8,192 bytes, encoded as numeric arrays.
  Stream 0 is stdin, 1 stdout, 2 stderr. Fatal exit signals do not expand the
  admitted host signal list.
- `control.rs` dispatches authenticated open/attach/close/kill/restart operations.
  Member requests cannot select uid, cgroup, run, environment or cwd. The boot
  provider must mutually authenticate the installed relay before dispatch.
- The owned registry admits at most 256 sessions. Closed execs and foreground
  exits retain cgroup ownership for lingering children. Failed drain does not
  forget ownership; failed startup/restart refuses new admission. Disconnect
  grace is 30 seconds and repeated disconnects cannot extend it.
- Linux cgroups are created exclusively under a held root-owned cgroup-v2 parent.
  Children join through an already opened descriptor before fixed group/GID/UID
  drop and umask 002. Startup kills every old child before observing any, requires
  populated 0 under a shared two-second deadline, then removes the empty groups.
  Revocation drains all selected groups under a shared five-second deadline.
  These are policy bounds, **not measured restart or revocation results**.
- The Linux launch adapter starts PTY/exec, the fixed installed-image SFTP server
  `/usr/lib/openssh/sftp-server`, or an installed supervisor TCP worker. All
  executable/member filesystem/network operations occur after drop. PTY terminal
  name, RFC 4254 modes, size, resize and permitted process-group signals are wired.
  Account provisioning is fresh-image-only, validates fixed account bindings,
  refuses existing homes, initializes private homes/workspace and cgroup parents.
- A Landlock ABI 3 write boundary confines dropped processes to workspace/home,
  with only fixed kernel sink devices `/dev/null`, `/dev/zero`, `/dev/tty` excepted.
  Unsupported kernels refuse. This additional prerequisite and device policy
  need reference-host/root-boundary review; no product decision is implied.
- Live process pipes stop reading at 256 KiB of unacknowledged output, with an
  additional 8,192-record metadata cap. Replay preserves each data stream and
  retained frame order. Input credit is returned after pipe writes. First-process
  exit does not wait for background descendants to close inherited output pipes.
- The Go listener fixes authentication to Ben's key and username, caps concurrent
  connections at 128, owns stalled handshakes, rejects agent/remote forwarding,
  and maps session and literal loopback direct-tcpip channels to guest frames.
  The installed relay opener uses `DialWorkspacePort(970)` only, after provider
  boot authentication, with no direct dial or local executable fallback.
- Reattachment retains at most 256 KiB of stdin, resends only unaccepted bytes,
  skips previously delivered output EOF, and restores lost input credit. The
  probe attach reply includes accepted input (`received`), consumed input
  (`written`) and `input_eof`. Those extra snapshot fields are needed to resolve
  lost WINDOW/EOF ambiguity; they are a proposed amendment, not an accepted wire
  contract. Unacknowledged signal requests are not replayed.

## Local validation

Run unprivileged, with the lane toolchain and `$HOME/.cargo/bin` on PATH:

```sh
python3 scripts/spikes/trm-06/test_launcher.py
go test ./scripts/spikes/trm-06/gateway -timeout 10s
go vet ./scripts/spikes/trm-06/gateway
cargo test --locked --manifest-path scripts/spikes/trm-06/supervisor/Cargo.toml
cargo clippy --locked --all-targets --manifest-path scripts/spikes/trm-06/supervisor/Cargo.toml -- -D warnings
```

SSH listener/channel tests use synthetic guest streams. Reconnect tests use
synthetic relay peers. Rust live-pipe and framed TCP tests start literal
unprivileged host fixtures. None uses real cgroups, fixed guest identities,
installed authority, init or `DialWorkspacePort`; none is a passing C-SPK-08
root-validation receipt. The launcher test is refusal-only (18 combinations).

## Pending install/reference-host work

The installed-main artifact and accepted-receipt authority provider is absent.
It must supply trusted listener/key/boot bindings, pin all prototype and base
SFTP executable bytes, provision a fresh `DefaultImage` with nil environments,
and invoke the installed supervisor/init and real relay adapters. No test fake
may authorize activation. The launcher and executable main wiring remain
unavailable until that provider exists.

Use [reference-host.md](reference-host.md) for the nine steps, both actual root
validation matrices and independent samples. A Mac mini with a microVM runtime
is required; VS Code Remote recording requires a person on a second Mac.
