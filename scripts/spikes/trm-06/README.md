# T-TRM-06 disposable session probe

**Incomplete; activation refused.** No real C-SPK-08 result, VS Code recording,
revocation/RSS measurement or accepted root-validation receipt has been produced.
The lead holds #3554. No product registration exists. Delete this directory when
T-TRM-07 records the validated result.

Checkout launchers and binaries refuse activation (exit 78). The system-installed
`/usr/local/lib/smithers/current/share/trm06/run.sh` now has a provider path:
it checks bundle gateway bytes before exec; the gateway verifies a signed,
revision/digest-bound security approval, reads protected owner configuration,
creates a fresh DefaultImage runtime with nil environments, installs only bundle
supervisor/installer bytes, starts init, authenticates the real relay and then
opens SSH. The launcher, signer-key trust seam, fresh installer and root modes
have **not** passed real-VM validation or security review. No installed positive
control or acceptance is claimed. Missing approvals still prevent all activation.

The supervisor's `--init` and `--serve` modes require fixed root-owned boot state
and the actual running inode's installed digest before any root mutation. Init
restarts a killed supervisor; each replacement independently drains old cgroups
before binding port 970. Its TCP worker checks the already dropped Ben/agent UID,
GID and supplementary team group before connecting to guest loopback.

## Built adapters

- Frames: strict tagged JSON behind a four-byte big-endian length; `data`,
  `eof`, `resize`, `signal`, `exit`, `exit_signal`, `window`, `close`. Envelopes
  are at most 65,536 bytes; data at most 8,192 bytes, encoded as numeric arrays.
  Stream 0 is stdin, 1 stdout, 2 stderr. Fatal exit signals do not expand the
  admitted host signal list.
- `control.rs` dispatches authenticated open/attach/close/kill/restart operations.
  Member requests cannot select uid, cgroup, run, environment or cwd. The boot
  provider must mutually authenticate the installed relay before dispatch.
- The installed-provider daemon loop owns at most 128 relay connections,
  runs grace maintenance every 100 ms even with no relay traffic, and closes
  owned transports before draining on shutdown or maintenance failure. Its
  executable entrypoint is wired to the installed provider; activation remains
  gated on external security acceptance and real-host evidence.
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
  refuses an existing Ben home, validates/reuses the shared fresh adapter's exact
  agent home without reading or repairing it, and initializes workspace/cgroups.
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
- The gateway lifecycle adapter stops admission, cancels pending relay opens
  and closes SSH connections before revocation. Its receipt waits for the real
  guest drain; cancellation closes the control transport. The five-second
  deadline includes shutdown. These adapters still require an installed provider.
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

The installed authority, launcher, fresh runtime and authenticated relay provider
are implemented. They refuse checkout execution and require all five accepted
checks before activation. No real reviewer key/approval, installed bundle or
reference-host activation was available in this lane. The new authority format
and boot proof remain review proposals, not security acceptance.

Use [reference-host.md](reference-host.md) for the nine steps, both actual root
validation matrices and independent samples. A Mac mini with a microVM runtime
is required; VS Code Remote recording requires a person on a second Mac.

## Installed authority contract (awaiting review)

The main-built system bundle includes `bin/trm06-gateway` (0755),
`libexec/trm06-supervisor` (0755, stage `host`), `share/trm06/install.py`
and `share/trm06/validation.py` (0644, stage `host`), the launcher and shell scripts, a raw 32-byte
`share/trm06/smithers-3f.pub`, and `share/trm06/approval.json`. It also contains
the existing runtime's msb, kernel, helper and jj artifacts. The install owner
must provision the real reviewer's public key; a lane-generated key is not
reviewer acceptance. Bundle assembly/installation and reviewer issuance remain
external prerequisites; no key, approval or install is generated by this spike.

Approval is `{ "payload": <object>, "signature": <base64 Ed25519> }`. Sign the
exact payload JSON bytes prefixed with `smithers-trm06/review/v1\n`. Payload
fields: `reviewer` (`smithers-3f`), `revision` (the installed main SHA), `expires`
(RFC3339), `artifacts` (bundle-relative paths to SHA256; all entries up to the
adapter's eight-segment plant limit except approval.json), and `checks` (exactly
`C-SEC-02/R1`, `/R2`, `/R3`, `C-SPK-08/root-prototype-install-validation` and
`C-SPK-08/root-session-input-validation`, all accepted). Duplicate/unknown fields,
checks, expired signatures, wrong revision/digests and mutable parents refuse.
The gateway rechecks authority at session admission and before installation.
This format is an implementation proposal, not a substitute for passing receipts
or smithers-3f's approval of the key/provenance seam.

The install owner's protected account home holds `.local/state/smithers/trm06/`.
Provision `config.json` as a single-link mode-0600 file, with `listen` (literal IP
and port 1024..65535), `host_key` (SSH private key PEM), and `ben_key` (one SSH
public key). All ancestors must be owner/root owned and not group/other writable;
symlinks are refused by the state descriptor walk. No environment/config field
selects an executable, image, user, workspace, root path or layer. A held file
lock excludes duplicate runs before runtime recovery or VM creation. The gateway
prints readiness only after authenticating the actual relay. Its owner-only
`control.sock` revocation command waits for guest drain and permanently ends the
run; installed `revoke.sh` uses that path. Fresh machines are deleted on exit.

Boot authentication is a fixed-length disposable probe exchange: guest magic
`TRM06\x01`, 16-byte boot id, 32-byte random guest nonce; host random 32-byte nonce
and ADR-domain HMAC-SHA256 (`smithers-machined/v1 host`, boot id, guest nonce);
guest HMAC-SHA256 (`smithers-trm06/v1 guest`, boot id, guest nonce, host nonce).
Secrets never cross the relay; invalid identity/proof, replay and cancellation
close it before session data. The extra guest-proof domain is a spike-only
amendment requiring protocol-owner review; no production wire change is made.

## Executable reference campaigns (unrun)

Only the system-installed scripts accept these operations. With the protected
configuration and an accepted bundle, `run.sh` launches a fresh machine and
`revoke.sh` drains it. `flow.sh` uses the real SSH listener for binary half-close,
1 GiB stalled output/RSS, PTY/resize/Ctrl-C, forwarding and a ten-second real
relay cut with ordered replay. The owner-only `lost-window` and `delivered-eof`
controls fault the next authenticated relay once: consume a consumed stdin
WINDOW without delivering it, or forward stdin EOF and report write failure.
The flow campaign sends one MiB of binary stdin through each and preserves exact
output and receipts. These campaigns are built but have not run on the reference host. `ben-fixture.key` must be owner-only mode 0600
and match config's Ben public key; no agent or root SSH key is admitted.

`run.sh measure` starts ten fresh installed runs and preserves terminal-only
revocation and restart samples. It requires direct populated-0 observations for
every old cgroup, refuses to infer emptiness from removal, and cannot certify
VS Code. The campaign arms an independent root observer with held kernel events
descriptors before revocation, retaining timestamped changes and 100 ms samples.
This observer remains unrun on real cgroups; missing observations remain NO. `last-drain.json` is observed before VM deletion.

`run.sh root-prototype-install-validation` and
`run.sh root-session-input-validation` run disposable real-VM fixture subsets.
They deliberately return incomplete (78), preserve partial receipts, and never
issue PASS: installed artifact replacement/races, installed cgroup/path races and independent restart ordering, and the
full malformed-input/cgroup-race matrix still need executable controls and real
execution. They use the same five-check approval gate, with no validation bypass;
initial validation authorization needs security-owner resolution.

Revocation reserves an authenticated control stream before SSH admission,
fences late opens even after failed drain, and preserves failure receipts.
Fresh supervisor instances randomize session IDs so stale streams cannot attach
to a newly created session with a reused counter. Authenticated reserved control
streams have no idle timeout; unauthenticated handshakes retain their five-second
bound. These lifecycle assertions have unprivileged transport tests only.

## Main release overlay

Run unprivileged after fetching main, with an existing uninstalled main release
bundle at the same revision and the security owner's actual raw reviewer key:

```sh
python3 scripts/spikes/trm-06/assemble.py --base /path/to/main-bundle --output /path/to/new-spike-bundle --review-key /path/to/smithers-3f.pub > /path/to/artifact-map.json
```

This archives the exact fetched `origin/main`, builds Darwin ARM64 gateway and
static Linux ARM64 supervisor, and stages scripts from that archive. The builder
needs Go and the `aarch64-unknown-linux-musl` Rust target (`rustup target add
aarch64-unknown-linux-musl`); it selects the toolchain’s bundled `rust-lld`.
The assembler checks ELF64 ARM64 headers and refuses a dynamic interpreter.
Cross-building does not replace execution or release acceptance on the reference
host.
It uses the existing release manifest's `host` stage and refuses mismatched base
revisions, replaced/unmanifested files and spike destination symlinks. It never
installs or generates a key/approval. Supply the complete artifact map to the
reviewer. The signed `share/trm06/approval.json` must be added to the bundle and
its manifest by the existing main release assembly/installation path before
activation; absence continues to refuse. No alternative root installer exists.

Init installation and restart execute through held, digest-verified executable
descriptors. The fixed argv identity is preserved for independent process
observations. The restart measurement now arms held old-cgroup observers before
SIGKILL and requires raw populated-zero samples within two seconds before its
replacement session opens. Reference-host execution and first-admission ordering
under concurrent VS Code reconnect remain pending.

The session-root campaign now also runs fresh disposable fixtures replacing
`/dev/zero` with an ordinary file and inserting an invalid child in the session
cgroup parent before init restart. It requires an explicit device-envelope or
startup-log refusal and unchanged outside/member-canary samples. These controls
are implemented but unrun; they do not supply accepted root receipts. Unsupported
Landlock execution and the complete artifact/cgroup race matrix remain unfinished.

Session children create a private mount namespace before dropping credentials:
all mounts become read-only, with writable top-level bind mounts only for the
fixed workspace and identity's home. Nested mounts remain read-only. Landlock
still confines data writes; the mount view also denies metadata mutations that
Landlock does not handle. Unsupported namespace/mount syscalls refuse spawn.
A local unprivileged user-namespace regression exercises actual kernel writes,
chmod and the installed OpenSSH SFTP SETSTAT protocol. This is supplemental;
the installed root/session campaign and reference-host measurements remain
required. OpenSSH maps read-only EROFS to SFTP failure (4), while DAC/Landlock
permission denial maps to 3; neither response replaces independent sentinel
bytes, owner and mode samples.

The root session campaign and supplemental measurement campaign now race four
ordinary authenticated SSH requests immediately after the owned supervisor's
pidfd confirms exit. Each records submission, completion and refusals. All four
must complete within the original two-second restart budget; every old group's
held raw zero sample must precede the earliest successful request submission.
This conservative lower bound may retain a NO for a request submitted while
cleanup was still running; a later exit response cannot hide early admission.
Already-empty groups still require a raw held-descriptor zero sample. The root
campaign preserves restart samples on probe failure and continues to return an
explicit incomplete result for its unimplemented controls. Real reference-host
execution, clock observations and automatic VS Code reconnect remain pending.


## Unsupported-kernel installed variant

`run.sh root-session-input-validation-no-landlock` uses the same installed
launcher, five-check approval, fresh DefaultImage, nil environments and real
relay as the other root campaigns. Supply an approved main release bundle with
a kernel that reports Landlock ABI 1/2, ENOSYS or EOPNOTSUPP. The installed
observer independently invokes the kernel version syscall and records its
release, ABI and errno. ABI >=3, missing samples and permission errors refuse
this campaign rather than masquerading as unsupported-kernel evidence.

The campaign requires a valid member exec and SFTP request to be refused by the
real SSH listener, an explicit authenticated broker refusal, no member process
or payload canary, and unchanged outside bytes/owner/mode. Raw observations live
in the scenario evidence directory. It remains an incomplete, unaccepted root
receipt: execution on the approved unsupported kernel and the remaining host
launcher/cgroup race matrices are still required. No alternate kernel, image,
branch executable, seccomp shim or activation bypass is selected by the command.

Run the supplemental launcher matrix directly with
`python3 scripts/spikes/trm-06/test_launcher_races.py`; its executable entrypoint
now runs the eight tests (including actual fd exec/environment observations).
These Linux results do not replace installed Darwin launcher evidence.

The installed live-cgroup campaign also covers replacement and writable modes
of each existing session child, after foreground/background enrollment. These
selectors preserve the original child inodes for the already-armed independent
events observer, require explicit new-admission refusal, and use authenticated
revocation with the same five-second raw populated-zero evidence gate. Empty or
foreign child sets refuse fixture mutation. Local filesystem tests substitute
UID/path observations only; they do not supply native cgroup acceptance. The
full installed host matrix and native reference-host receipts remain required.
