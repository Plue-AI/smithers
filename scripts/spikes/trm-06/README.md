# T-TRM-06 protocol probes

**INCOMPLETE; activation refused.** No C-SPK-08 or C-SEC-02 passing result,
recording, revocation timing, RSS measurement or accepted security receipt exists
in this lane. Issue #3554 remains open under the lead's claim. Ready identity:
`sha256:0f0689e4c249`.

`run.sh`, `revoke.sh` and `flow.sh` exit 78 with
`unavailable/prototype_authority_unavailable` before any external command.
Arguments, receipt paths and environment flags cannot enable them. Go and Rust
entry points also refuse; they bind no listener and perform no setup, cleanup,
spawn or relay. No branch-built probe is installed or executed by root, and no
branch-built gateway is run on the host. Unit test binaries run unprivileged.
An authenticated installed-artifact/receipt provider is still absent; a file
containing `accepted: true` is not authority. This directory has no product
startup registration.

## Built probe contracts

- Rust frames: `data`, `eof`, `resize`, `signal`, `exit`, `exit_signal`,
  `window`, `close`. Four-byte big-endian length followed by strict tagged JSON;
  65,536-byte envelope, 8,192-byte data payload (byte arrays), 262,144-byte
  per-direction replay/credit bound. Stream 0 is stdin, 1 stdout, 2 stderr.
  Exit signal is a separate probe variant; this is not an ADR 0004 amendment.
- Rust replay retains only unacknowledged bytes, rejects impossible or stale
  offsets, and refuses writes without credit. It is a pure accounting probe;
  it is not connected to process pipes, SSH windows or a reconnect timer.
- Linux startup cleanup walks fixed root-owned, non-writable ancestors without
  following symlinks, requires cgroup v2, opens child cgroups by held descriptor,
  writes every `cgroup.kill` before polling, and requires exact `populated 0`
  under one shared two-second deadline. It is compiled, not run on real cgroups.
  The guest helper is a design reference, never a cleanup subprocess or oracle.
  The inline polling loop is replaced by a shared policy tested with deterministic
  clock/kernel faults: all kills precede reads, every child is observed, one
  deadline includes descriptor resolution, and kill/read errors refuse admission.
- Dormant Linux child identity drop pins Ben 20001 or agent 19999, supplementary
  team group 20000, matching primary GID, and umask 002. It sets real/effective/
  saved GID and UID, verifies all credentials, and returns an error at the first
  failed operation. It is not called by a process launcher; account provisioning
  and real before-payload identity observations remain unimplemented. Mac tests
  inject syscall failures; Linux code is cross-compiled, not executed.
- Go maps shell/exec/PTY/SFTP/direct-tcpip and resize/signal/exit requests, refuses
  agent and remote forwarding, restricts TCP to literal guest loopback targets,
  and returns fixed fresh-only `DefaultImage` configuration with nil environments
  and artifacts. Its transport seam calls existing `DialWorkspacePort` at port
  970. No direct guest-test dial or host execution fallback is present.

Host PTY wrappers and host SSH viewers have no guest session-frame or cgroup
lifecycle. These disposable additions replace no product path. Delete this
entire directory when T-TRM-07 records validated results.

## Validation and remaining work

Run unprivileged from the repository root:

```sh
python3 scripts/spikes/trm-06/test_launcher.py
go test ./scripts/spikes/trm-06/gateway
go build -o /tmp/trm06-gateway ./scripts/spikes/trm-06/gateway
go vet ./scripts/spikes/trm-06/gateway
cargo test --locked --manifest-path scripts/spikes/trm-06/supervisor/Cargo.toml
cargo check --locked --target aarch64-unknown-linux-musl --all-targets --manifest-path scripts/spikes/trm-06/supervisor/Cargo.toml
```

The launcher regression is refusal-only (18 entry-point/argument combinations
with poisoned PATH/import/environment and unchanged outside sentinel). It is
**not** either root-validation subcheck: it lacks the installed positive control,
real init/start/restart and authenticated SSH/relay dispatch.

Still required in #3554: authenticated installed-main provenance and accepted
T-SEC-01 R1–R3 receipts; fixed account provisioning and process-launch integration
of the dormant privilege drop; guest PTY/exec/SFTP/TCP execution and owned cgroup registry; authenticated multiplexed
control/data dispatch; SSH listener/authentication and channel pumping; close,
revocation and restart operations; live flow control/reattachment; both real
root-validation matrices; the nine C-SPK-08 steps on the reference host with
VS Code on a second Mac; raw samples and screen recording. No result for
T-TRM-07 can be accepted until those run. The five-second and two-second bounds
remain requirements, not measured claims.
