# T-COL-01 disposable spike (#3441)

From this checkout, run:

```sh
scripts/spikes/col-01/run.sh
```

Requires Apple Silicon, the pinned Rust toolchain, Go, pnpm, Chromium installed
for the app's Playwright version, local `msb 0.6.16` and PostgreSQL binaries
(`initdb`, `pg_ctl`). An npm msb launcher is resolved to its native binary;
`SPIKE_MSB_BIN` overrides are rejected by preflight. The isolated browser package pins Yjs 13.6.32, Playwright 1.62.1 and the
app's lib0 0.2.117; its launcher installs only offline from the existing store.
No container runtime or guest build toolchain is needed. The Rust toolchain cross-links static Linux
binaries with its bundled musl and LLD.

Before building or starting a VM, the launcher compares the runtime source and
embedded assets against `origin/main`. Missing, changed, symlinked or extra
inputs refuse the launch with exit 2. The runtime installs a root helper;
matching a branch-provided digest does not authorize its bytes. Fetch main
before measurements. Remote browser mode does not provision a VM.

Modes: `rtt` (both transports, idle/busy, setup, controls), `keystrokes` (both
transports), `control` (retry only the write baselines), `snapshot` (jj burst capture), and `serve relay|bridge` (keep one document VM and host endpoint up
for a second Mac). The default runs everything. `SPIKE_LAN` selects the LAN
IPv4 address; otherwise it uses the default-route interface (`SPIKE_INTERFACE` overrides it). It refuses loopback. The HTTP server
binds exactly that address and loopback, uses plain HTTP, and exposes no UI.

Default evidence is `<checkout>/.artifacts/checks/C-SPK-03/`
and `C-SPK-07/`, in fresh UTC directories. `SPIKE_EVIDENCE_ROOT` overrides the
checks root on another host. Each run contains environment receipts, raw CSV,
nearest-rank percentiles, connection setup samples and real save receipts.
The host revision receipt uses `git rev-parse HEAD`; host-side jj is not needed
for RTT or browser measurements. Snapshot commands run inside the disposable VM.
Browser runs also contain traces, text files and matching SHA-256 digests.
`guest-kernel.json` records read-only guest kernel, uid, capabilities and
BTF/config/cgroup/user-namespace path availability; it does not prove attribution support.
`result.md` records a provisional transport/fallback decision, never ADR 0003.
An executed threshold failure makes the command exit nonzero after retaining
all remaining measurements; completed observations are distinct from a pass.

The actual backend `DialWorkspacePort` and configured `startBridges` are used
unchanged. A disposable name shim maps only adapter-derived names into
`spike-col01-*`, resolving the real CLI path before exec. Ownership labels and
private runtime metadata still govern cleanup. One fresh VM uses the spec's
detected-memory/vCPU formulas and DefaultImage. Handled exits delete that VM;
unrelated sandboxes are never changed. A hard process/host crash can leave an
owned `spike-col01-*` VM: remove only its exact recorded name. The script refuses
to build below 8 GiB free and keeps build output in this checkout's `.artifacts`.

The lane runs two headless Chromium tabs on this Mac through its LAN address.
This exercises the IP stack without crossing a physical link to a second Mac.
The deviation accompanies every observation; strict C-SPK-07 is partial.
Other VMs are recorded rather than stopped; a host other than the team's Mac mini or competing VMs also prevents claiming
the isolated reference-host check. A guest handshake excludes
the adapter's transient readiness probe sockets from accepted bridge streams;
setup timings include the handshake and do not discard any timed sample.

Each transport has 1,000 byte-verified frames per size/load cell and 20 ready
connection setup samples. Setup is separate from steady-state latency. All
frames on a measurement connection remain on that connection. All guest vCPUs
are loaded with `yes` workers and their count is checked before busy samples.
The framing writes header and body together to avoid a prototype-induced
Nagle stall. Nothing changes TCP settings in the backend's Python helpers.

Each browser workload has 1,000 A insertions (10/s and 30/s), then 1,000 A plus
1,000 B concurrent insertions at 10/s. Seeded random positions stay in A's
lines 1–200 or B's lines 201–400. Receipt is stamped by the runner only after
the receiving `Y.Text` observer applies an exact tagged character. No first
sample is dropped. Disk convergence is checked after 1.5 s. The host owns no
CRDT mirror: initialization and every update reach the one Yrs stream.

Runner send/receipt times use one `process.hrtime.bigint` clock; RTT uses one
Go monotonic clock. Host↔VM duration is exact on the host clock. A 20-request
minimum-RTT HTTP calibration estimates the outbound and return shares; it
assumes symmetric HTTP delay and leaves an uncertainty bound, automation
overhead, possible later drift and negative estimates visible. It is not an
exact one-way network measurement. Per-editor p95 also gates concurrent runs.

The default also shallow-clones public `main` inside the VM, installs dependencies
with pinned Node 26.5.0 / pnpm 11.25.0 (dependency installation is offline and
requires `SPIKE_SNAPSHOT_STORE_ARCHIVE`, an absolute path to a tar archive of
an already populated pnpm 11 store for Linux ARM64). `store.sh` refuses preparation until a qualified non-root guest launcher
and fresh-machine offline validation are available. Its former direct msb path
ran checkout and installs as root and has been removed. Supply a complete
Linux ARM64 store prepared through reviewed provisioning; no archive is
produced by this refusal. The archive is copied into the guest,
extracted safely, and passed explicitly as `--store-dir`; its SHA-256 is retained.
A Mac-only store may omit Linux optional dependencies and is insufficient.
Missing packages fail closed; no network-heavy install runs on the reference host, and measures jj 0.39.0 snapshots for
0/1/12/200 changed files, idle and with every vCPU busy, 100 samples per cell.
Preparation downloads use a temporary HTTPS proxy on the existing loopback
bridge, restricted to GitHub, npm and Node hosts; VM network rules stay intact.
The timed command includes process startup and the full repository scan.
Edits use 200 additional tracked 128-byte fixture files; setup and validation
warm caches between samples. Ignored dependencies are checked explicitly.
Snapshot artifacts are in C-SPK-03. Its 12-file idle p95 gate is 500 ms; a slow
no-change result goes to the lead for the fsmonitor decision. Snapshot-only
runs can be folded into a combined report by passing their evidence directory
as the third argument to `result.mjs`. Host free space is monitored during this
larger preparation, and an owned command is cancelled below 8 GiB.

For the missing second-Mac check, run `run.sh serve bridge` (or the measured
choice) on the host. Copy its printed LAN origin and run this checkout on the
second Mac with `SPIKE_CLIENT_TOPOLOGY=second-mac run.sh remote <origin> bridge`.
Remote mode labels topology as caller-asserted and preserves runner/network
profile receipts. It does not boot another VM. Ctrl-C on the host cleans its VM.
For an exact remote command, set `SPIKE_HTTP_PORT=39041` on the host and use
`run.sh remote http://<host-LAN-address>:39041 relay` on the second Mac after starting
`SPIKE_HTTP_PORT=39041 run.sh serve relay` on this host. Use that host's real
LAN address elsewhere. A busy chosen port fails rather than taking it over.
On macOS 15+ the second Mac's Local Network privacy can block Homebrew `node`
and Chromium from LAN peers: `remote` then fails with `EHOSTUNREACH` while
`curl` works. Grant the terminal Local Network access, or relay the second
Mac's own LAN address to the host with an Apple-signed `/usr/bin/python3` TCP
forwarder (TCP_NODELAY both ways) and record that deviation. The `control`
PostgreSQL fixture needs a valid locale: over a bare `ssh` session set
`LC_ALL=en_US.UTF-8`, or `postmaster became multithreaded during startup`.

Validation, with build output kept inside the checkout:

```sh
export GIT_CEILING_DIRECTORIES="$HOME"
export CARGO_TARGET_DIR="$PWD/.artifacts/spikes/col01-host-tests"
cargo test --locked --manifest-path scripts/spikes/col-01/guest/Cargo.toml
python3 -m unittest discover -s scripts/spikes/col-01/jj-snapshot -v
cargo build --locked --manifest-path scripts/spikes/col-01/guest/Cargo.toml 
export COL01_ECHO_BINARY="$CARGO_TARGET_DIR/debug/col01-echo"
export COL01_DOCHOST_BINARY="$CARGO_TARGET_DIR/debug/col01-dochost"
(cd scripts/spikes/col-01 && go test -race ./... && go vet ./...)
```

The 2026-10-06 reference-host run (RTT matrix, second-Mac keystrokes, snapshot table) is recorded in
[ADR 0003](../../../docs/architecture/0003-live-code-co-editing.md).
Retain this prototype and its raw evidence as the reproducible T-COL-11 benchmark method; do not port it into product code. Run measurements with `--no-cache`. Declared exclusive targets: `//scripts/spikes/col-01:test`, `:rtt`, `:keystrokes`, `:snapshot`.
Nothing here becomes product code. See [control/README.md](control/README.md)
for the current two-exec service versus one-exec rejected-alternative gap.

The spike module deliberately uses `packages/backend/col01` as its Go module
path to exercise backend internal services and the real PostgreSQL testkit.
It is disposable test scaffolding, not a product package at that path.
The test target supports Darwin and Linux only when Go, Rust, jj, PostgreSQL
`initdb`/`pg_ctl`, pnpm and the pinned Yjs package are available.

The bridge 4 KiB idle plateau tested as delayed ACK/Nagle: the existing guest
helper omits TCP_NODELAY. `rtt` therefore also measures `bridge-nodelay`, a
diagnostic third transport: `echo/bridge_nodelay.py` is the helper's `bridge`
byte pipe copied with TCP_NODELAY on both sockets, run as a spike service on
guest port 19003 against the same host listener. `bridge-nodelay-client`
(19004), `bridge-nodelay-upstream` (19005) and `bridge-nodelay-none` (19006)
run the same copy with the option on only the accepted guest socket, only the
socket to `host.microsandbox.internal`, or neither, to attribute the stall one
socket at a time; `none` must reproduce the shipped helper. Diagnostics are
never chosen. Since #3749 the production helper sets the option on both
sockets, so `bridge` itself measures the fix.
ADR 0004 supports both topologies.

Host load gates every run and RTT cell. A run starts only when the 1-minute
load is below 10. Each cell starts below 10 (the guest's own busy workers
subtracted) and reruns, up to five attempts, if it ends at or above 10; rejected
attempts stay in `samples-rejected.csv`. Each cell records load and running VMs
before and after, and `host-load.csv` samples the host every 10 s.


Reference-host findings (lead ruling 10-03):
- Astra1/Fable1: **moved to T-COL-11 (lead ruling 10-03)**. Prepare a populated Linux ARM64 pnpm 11 store archive for the measured revision, then run the snapshot target on the reference host with `SPIKE_SNAPSHOT_STORE_ARCHIVE`; retain all eight 0/1/12/200-file idle/busy cells (100 samples each), dependency identities and the 12-file idle budget result.
- Astra2/Fable3: **moved to T-COL-11 (lead ruling 10-03)**. Run the complete isolated reference-host RTT matrix with no competing VM (both transports, 64 B/4 KiB, idle/busy, 1,000 samples per cell and 20 setup samples), then obtain the second-Mac plain-LAN browser receipt for all three workloads with convergence and disk hashes. Retain the bridge delayed ACK/Nagle confounder and resolve it in the ADR 0003 topology decision; this harness landing claims neither reference-host acceptance nor a second-Mac pass.

T-COL-11 follow-up measurements run inside the same disposable guest after
snapshot mode's eight cells. `growth.py` snapshots 1,000 additional bursts of
12 changed 128-byte fixture files, retains allocated `.jj`/`.git` bytes after
each capture, abandons operations older than the newest 100, and runs GC with
`--expire now`. Non-colocated Git objects are counted under `.jj` once. Its
14-day projection uses 80,640 captures and the strict 2 GiB budget; this gross
pre-GC projection does not approve a retention change. Then 100 synthetic
12-blob, flat-tree, parentless versions commits are timed and byte-verified.
This isolates the requested object-creation workload, not the production
before/after directory-tree builder. Preparation and validation warm caches.

The guest filesystem probe validates EXCHANGE, NOREPLACE's EEXIST with intact
files, and RESOLVE_BENEATH with a readable local file and a rejected escaping
symlink. Both follow-up tools refuse any identity except Linux agent uid 19999
before creating evidence. Freeze and kill remain explicitly **blocked** until
a reviewed main-pinned privileged helper exists; checking control-file existence
would not measure them. The kernel command exits nonzero for this incomplete
inventory, so the extended run cannot claim a passing check. No privileged
helper is built, installed or invoked by this extension.

C-SPK-03 retains `growth-samples.csv`, `versions-samples.csv`, `growth-summary.json`,
`growth-abandon.log`, `growth-gc.log`, `kernel-probes.json` and failure evidence.
The reference-host rerun, second-device browser results and signed ADR topology
are still required. No topology decision is inferred from missing observations.

Completed snapshot or growth observations that miss their budget exit **3**.
The launcher verifies the complete summary before continuing to the remaining
follow-up measurements, and retains the budget failure in its final exit.
Execution, security, corruption, cancellation and incomplete-summary failures
still stop dependent work. This allows slow snapshot runs to collect growth,
versions and filesystem evidence without turning a latency miss into a pass.
The final report requires the 1,000 consecutive growth samples, 100 versions
samples, abandon/GC logs, evaluated growth budget, and complete guest kernel
observations. A blocked privileged probe cannot be reported as a measured no
or a passing C-SPK-03 receipt.

### T-COL-11 root-input refusal

`run.sh` checks host harness and runtime bytes against `origin/main` before
building, installing dependencies or starting a machine, including remote
browser mode. Changed or extra executable inputs and helper/image/toolchain/
plist overrides fail closed. The launcher refuses non-Apple-Silicon hosts and
root host measurement processes. This is an admission gate, not a completed
ExecutionPlacementAndRootInputs receipt: executable/toolchain identities and
actual guest command/cleanup uid evidence still require the reference-host run.

`jj-snapshot/cgroup_probe.py` is the fixed, no-argument freeze/kill probe source.
It must first land on reviewed main, then be embedded in the approved image or
bundle; a lane checkout must never install or execute it as root. Invoke the
installed helper with the image-shipped Python interpreter in isolated mode
(`python3 -I <installed-main-helper>`), without caller-selected environment or
stdin. It exclusively creates `/sys/fs/cgroup/smithers-col11-probe`, forks its
own disposable child, drops the child to uid/gid 19999, checks freeze/thaw and
kill events, then reaps that child and removes the group. It accepts no working
copy path. Existing groups and absent cgroup v2 refuse the run. No privileged
probe has been executed by the Linux lane; `kernel.py` deliberately retains its
blocked result until approved provisioning and receipt plumbing are available.

### Daily retention campaign

On the admitted reference host, `SPIKE_DAILY_CYCLES=1` with `run.sh snapshot`
adds three daily cycles to the existing guest growth driver. Each cycle has
5,760 captures at five-second intervals over eight hours, with start times at
least 24 hours apart. Allow at least 56 hours; the command timeout is 60 hours.
Missed capture slots fail instead of producing a catch-up burst. The same
non-root guest, clone and fixture continue across cycles. The harness retains
`retention-samples.csv`, `retention-cycles.json`, and each cycle's operation
inventory, abandon log and GC log, including available partial failure evidence.

Cleanup keeps every operation younger than 24 hours and at least the newest
100. It refuses an unordered operation inventory rather than guessing about
concurrent history. The bound is the largest measured pre-cleanup size plus
14 times the largest positive difference between successive post-cleanup sizes.
Pre-existing reclaimed garbage earns no credit. The strict budget is 2 GiB.
A normal 1,000-capture run remains useful diagnostic evidence, but `result.mjs`
refuses retention acceptance without all three cycles and 17,280 paced samples.
If the measured bound misses, retain it and obtain owner approval of a revised
cadence or kept-operation count; this harness does not invent a policy from an
unmeasured projection. Linux lane tests validate argv selection and arithmetic;
the jj timestamp template and actual abandon/GC execution still need the guest
run. No three-cycle measurement is claimed by this source change.
