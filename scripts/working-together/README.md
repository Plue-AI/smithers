# Working-together fault evidence

`smthrs test //scripts:workingTogetherComponents` executes the existing Rust
versions, outbox, capture, reconcile, barrier, documents, rebase, link and
moved-off suites with
`testing,killpoints`. K1/K2's process-exit test repeats ten times per point.
The authenticated link K3b/K5b/K5c process-exit test also repeats ten times
per point. The runner requires explicit successful receipts for both process-kill
tests; suites compiled without those tests cannot qualify. Moved-off metadata
fixtures run in the same campaign. These suites include real temporary disk/process boundaries and test-only
service fixtures. They do not qualify the integrated C-DUR-04 matrix.

`smthrs test //scripts:workingTogetherFaults` runs the same components, records
K1–K8 as blocked, and exits 2 after component success. A component failure or a
suite with zero assertions exits 1. Both write fresh C-DUR-04 directories with
commit, actual runner host profile, argv and complete logs. Symlink parents and
existing directories are refused. Hooks are enabled only for the debug test
build; no branch binary is installed or run by root.

Full proof still needs the integrated writer/head/receipt/browser matrix in
`packages/backend/internal/machined/fault_test.go`, W3 capture/VM composition,
and W15's daemon document wiring. The reference rehearsal also needs a second
Mac's authenticated browser/SSH fixtures, sleep/wake, two typists during rebase,
host restart, stale outside save, revocation and both themes. A component pass
or an unavailable performance run never marks any of those as complete.

`smthrs test //scripts:workingTogetherWikiFaults` runs the composed wiki
host crash/restart boundary ten times with real PostgreSQL and native document
state. Create the untracked `.artifacts/working-together-host.json` with
`databaseUrl` naming a dedicated test PostgreSQL server and `libraryPath` naming
the current unprivileged native library. The runner sets the required test
environment internally because target tools receive a narrow environment.
Credentials are never copied into receipts. The app's
pinned Yjs installation and Bun must be available. Missing native state fails,
and a skipped or incomplete test never qualifies. Fresh C-DUR-04 evidence
contains the runner profile and full Go JSON logs. `boundary-passed` qualifies
this fixture only: the complete writer/head/receipt/client-text artifact matrix
remains incomplete. No guest VM or second laptop proof is implied.

The Linux document filesystem boundary can run without provisioning a privileged
broker. On a Linux host with Docker, as an ordinary user:

```sh
docker pull ubuntu@sha256:f144425ff09be612d6d9ad965196e9cdc23dae1f42110a8a11a3e9a8198759f7
CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUNNER="$PWD/scripts/working-together/linux-document-runner.sh" \
  cargo test --locked --target x86_64-unknown-linux-gnu -p smithers-machined \
  --test document_disk_dispatch -- --ignored --test-threads=1 --nocapture
CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUNNER="$PWD/scripts/working-together/linux-document-runner.sh" \
  cargo test --locked --target x86_64-unknown-linux-gnu -p smithers-machined \
  --test confinement -- --test-threads=1 --nocapture
```

For a native ARM64 Linux host, use `aarch64-unknown-linux-gnu` and
`CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_RUNNER`. The runner also accepts a test
executable emitted by `cargo test --no-run --message-format=json`. It runs only
that read-only mounted executable as UID/GID 19998, without network or Linux
capabilities. Tests write to the disposable container's real overlay filesystem;
no host working copy or credentials are mounted. `/etc/machine-id` identifies the
runner host in the log. Build with Cargo as an ordinary user; the runner refuses
root execution.

These cases use production RPC dispatch, document service, Yrs and Linux disk
operations, with controlled version receipts and time. They cover permission
failures, forged authors, duplicate frames, two-member edits, restart recovery,
200 outside-save orderings and 10,000 reads during directory/symlink swaps. A save after the document has flushed
is non-overlapping and applies; an overlapping save against the pre-flush or
held-inode base keeps the live edit and reports the outside version. This is
Linux boundary evidence, not the installed broker/cgroup, microVM, browser,
reference-host latency or complete C-COL-04/C-DUR-04 acceptance.


`node scripts/working-together/faults.mjs --host-only` executes K4 and K4b's
production authenticated host dispatcher with real PostgreSQL and a bare Git
object store. The untracked `.artifacts/working-together-host.json` needs only
`databaseUrl` for a disposable test PostgreSQL server in this mode. K4 exits
the host after commit and before ACK; K4b cuts the connection for 30 seconds
while fifty distinct fixture bursts queue, then reconnects to the same host
service without restarting it. Both run ten times and replay twice, checking
exact rows, hashes and versions retained through Git GC. This mode takes about
six minutes; `go test -short` skips K4b. The runner requires every named test and
all twenty subtest lifecycles, refusing failures, skips, missing runs and duplicate
receipts. It preserves JSON logs and environment metadata under C-DUR-04.

These are host boundary proofs with a fixture wire peer. They do not exercise
an installed guest watcher, its durable outbox, a VM kill, working-copy recovery,
capture convergence or the complete per-run C-DUR-04 artifact inventory. The
summary remains `incomplete`; the Mac/approved-image campaign is still required.

`node scripts/working-together/faults.mjs --watcher-only` runs the composed Linux
watcher recovery campaign: K1, K2, K3, K3b and K5a–c, ten runs each. Build the
`rehearsal_daemon` example with `--features killpoints`, then add its absolute
path as `machinedFaultBinary` to `.artifacts/working-together-host.json`, alongside
`databaseUrl` and `libraryPath`. Linux user namespaces, bubblewrap and jj are
required. The campaign uses real inotify, native snapshot and versions objects,
the daemon's outbox and bundle transport, PostgreSQL, the host store and the
composed sleeping-branch HTTP diff door. Each run retains acknowledged writer
hashes, rows, captured heads, daemon logs and outbox records in the campaign's
evidence directory. Missing, skipped, failed or duplicated run receipts fail.
The executable is copied into that directory before launch; every restart uses
those same digest-bound bytes even if the shared Cargo target is rebuilt.

K5 hooks arm only after all twenty acknowledged writes have host receipts.
This keeps the ordinary five-second capture cadence from killing writer setup.
The first repetition pauses setup past that cadence to exercise the race;
the armed hook still must exit with code 73 and recover every written file.

Its empty broker census cannot qualify member-session attribution, guest init
supervision, K4/K4b host faults or K6 VM kills. The summary stays `incomplete`;
successful daemon and host modes must never be combined into a full-check pass.

`node scripts/working-together/faults.mjs --watcher-host-only` runs ten real
watcher/host repetitions each of K4 and K4b using the same private fixture and
digest-bound daemon as `--watcher-only`. K4 exits a separate host process after
the production burst transaction commits, before its wire ACK; the daemon
stays alive. A replacement host authenticates the retained host-owned boot,
replays the real outbox and captures after it drains. K4b closes the transport
for at least 30 seconds while fifty outside writes become fifty real bursts.
The debug-only `qualification-K4b-capture.arm` marker in the daemon's protected
state requests the ordinary local capture under the mutation lock, so each
burst closes without waiting for an unavailable host RPC. It neither creates
fixture events nor acknowledges anything. The same host process reconnects.
Both cases verify acknowledged bytes, unique file rows, captured host trees,
empty outboxes and every sleeping-branch diff through the composed HTTP router.
Evidence includes writer logs, unacknowledged records, host and daemon logs,
database exports and capture heads; K4b also records actual outage duration
and the unchanged host PID. This is portable watcher/host evidence. Populated
member cgroups, guest init and real VM force-stop still require the approved
reference campaigns; the summary remains `incomplete`.


On the reference Mac, `node scripts/working-together/faults.mjs --session-only`
runs K1–K3b and K5a–c against the composed approved microVM install, ten times
each. `--vm-only` runs K6 at K1 and K5b, ten times each. The host fixture must
also name an absolute `checkBundle` containing the approved debug daemon with
killpoints; the normal install bundle intentionally cannot reach these holds.
The driver refuses these modes on Linux, missing bundles and skipped tests.

Both modes reuse the production member terminal, broker cgroups, watcher,
outbox, host store, PostgreSQL and capture path. Acknowledgements follow
write/fsync/close. The daemon mode consumes a one-shot exit request only after
the writer has finished at the held boundary, then requires a new ready host
connection and a working member terminal without manually starting the daemon
or waking the VM. K6 still uses the actual msb force-stop/wake path. Each run
retains the writer hashes, outbox, heads, rows and host object checks. A green
selected campaign remains incomplete evidence for C-DUR-04 until real watcher
K4/K4b host crash/outage and the remaining campaigns qualify together.

`node scripts/working-together/faults.mjs --member-host-only` runs K4 and
K4b ten times each on the approved reference guest. K4 opens its writer through
the authenticated terminal route and records its member UID and broker cgroup.
It then transfers the retained private daemon connection to a separate host
process running the production event consumer, PostgreSQL transaction and host
object importer. This process exits with code 73 after committing a burst and
before ACK. The writer stays alive in its member cgroup. The install's ordinary
reconnect replays the outbox; capture, HTTP file reads and terminal reattachment
check every acknowledged byte, unique file row and retained versions object.
K4b keeps the host alive during a thirty-second outage and fifty bursts.
Neither case installs branch code as root or synthesizes a session census.

`node scripts/working-together/faults.mjs --s2` orchestrates all S2 campaigns.
Run it on the approved reference Mac. Its private
`.artifacts/working-together-host.json` contains `databaseUrl`, `libraryPath`,
`checkBundle`, a lane-specific `databaseNamespace` (at most fifteen characters)
and `s2Linux: {"host":"member@linux-host","root":"/absolute/checkout"}`.
The Linux checkout must be at the identical commit, with its own private host
fixture naming the real killpoint rehearsal binary. SSH and SCP must already
be authenticated. No test writes to a real GitHub repository.

The driver invokes Linux watcher and watcher/host campaigns over SSH, checks
the remote revision before launch, and copies their complete evidence trees
back. It independently validates the copied Go lifecycle logs. Guest sessions,
VM force-stop and both member/host faults run sequentially on the Mac. Guest
bundles must name the campaign revision; receipts link their full rehearsal
evidence directories and retain the bundle manifest digest. Configuration and
boot secrets stay outside evidence.

The aggregate requires every campaign, matching revisions, Linux and Darwin
host profiles and all K1–K6 lifecycles. It returns zero only when those campaigns
pass; a skip, missing fixture, copy failure or missing lifecycle returns one.
The summary links each evidence directory and preserves failures while running
the remaining campaigns. This is S2 campaign evidence, not owner approval of a
check-command mapping. C-J3-03, C-J3-06 (including the recorded VS Code step)
and C-PERF-04 still require their separate reference-install/browser campaigns.

K4's first Linux repetition deliberately waits for the first acknowledged file
to commit before writing the other nineteen. A real host can exit at an early
burst under contention or the normal capture cadence. Pre-ACK evidence must
show a committed nonempty prefix, not assume all files shared that transaction.
After replay, every acknowledged path still must have exactly one durable row,
its independent expected bytes in the capture and sleeping HTTP diff, and no
unacknowledged outbox record. Diff verification sorts paths across entries;
it does not require the writer to finish inside a single burst window.
