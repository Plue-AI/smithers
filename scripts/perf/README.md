# Installed-product performance evidence (#3592)

`node scripts/perf/run.mjs` runs configured first-token and projection measurements on macOS
and names unavailable budgets. Exit 0 means all selected budgets passed; exit 1
means a launched workload failed; exit 2 means the run is incomplete.
Set `SMITHERS_PERF_ORIGIN` to the configured LAN/HTTPS origin and
`SMITHERS_PERF_OWNER_COOKIE` to an owner browser-session Cookie header. Host
metadata comes only from `GET /api/install/metrics`, which reads the existing Go
capacity service; no local detection or capacity calculation is performed.
The retired `/api/host` stays removed. PATs and delegated credentials cannot
read the owner-only metrics adapter.
`SMITHERS_PERF_INSTALL_VERSION` is required before an enabled workload starts;
each driver must return that same version. It remains operator-supplied metadata,
not a verified release identity. Optional `SMITHERS_PERF_BROWSER` records browser metadata.

Fresh `.artifacts/perf/<UTC timestamp>/summary.json` records each selected budget,
its raw samples or skip reason, required tickets and activation preconditions.
C-PERF-01 activates when its public page, owner session, member state and install
version are configured on the second Mac. Its actual workload refuses missing
Inspect host-clock receipts; missing timings never become passing samples.
C-PERF-02 activates when its origin, owner session, member state, TODO and install
version are configured on the network Mac. The driver refuses missing live
publishers before submitting its move workload. The runner independently checks
sample counts, clocks, commit/origin identity and literal p95 limits; a failed
workload stays failed. Machine budgets remain skipped until their lifecycle
security qualification is available. It adds no privileged step or check receipt.
The keystroke, disk-write, warm-wake and rebase-hold CLI entrypoints select their
budget through this same runner. Unavailable bindings or qualification remain
skipped, with the required tickets recorded; invoking a standalone command cannot
bypass that activation decision and launch its browser, SSH or terminal workload.
`SMITHERS_PERF_ARTIFACT_ROOT` optionally selects the artifact parent directory.
Each budget also gets a JSON artifact and an identical summary/evidence copy in
`.artifacts/checks/C-PERF-01` through `C-PERF-06`, including refusals. Evidence
directories are fresh and symlink parents are refused.
Existing library counter benchmarks remain unchanged because they measure
different boundaries.

`node scripts/perf/keystroke.mjs` drives C-PERF-03 on the second Mac using
the real File cards. Set `SMITHERS_PERF_PAGE` to the repository page,
`SMITHERS_PERF_MEMBER_A` and `SMITHERS_PERF_MEMBER_C` to distinct authenticated
Playwright storage-state files, and `SMITHERS_PERF_READ_ARGV` to the JSON argv
`["/usr/bin/ssh","-p","2222","-o","BatchMode=yes","-o","StrictHostKeyChecking=yes","--","<branch>@<host>","cat -- src/target.ts"]`,
using the Branch card's SSH destination and the member's already trusted host
key and login. Other host programs, SSH options and remote commands are refused. The scratch file must have
400 lines and no `K00000`–`K00199` markers. The driver edits the first 200 lines;
use only an authorized scratch branch. It requires the origin, token and install
version variables above and the app's installed Playwright Chromium. Run on macOS
(the editor/clipboard keyboard bindings use Command).

It records 200 browser keydown-to-remote-DOM timings, verifies full documents
via clipboard against the independent machine read, rejects missing/duplicate/
reordered markers, and requires nearest-rank p95 below 1000 ms. It writes raw
samples and failures under `.artifacts/perf/` and copies them to
`.artifacts/checks/C-PERF-03/`. Storage states, tokens and machine-read argv
are not copied into artifacts. A driver is not reference-host evidence: no
passing real-stack run has been recorded yet. The operator must ensure this
runner is the second Mac and the selected install is the reference Mac mini.

Outstanding: production Inspect and rebase-hold bindings, authenticated
machine-budget activation, reference-host browser/SSH fixture qualification
and remaining document/rebase §20.3 latency observations,
qualified network/machine security evidence,
real raw-sample artifacts, second-Mac runs, and
C-PERF-01–06 results. Receipt approval remains with `scripts/check-run.mjs`;
no check mapping is activated here. Keep #3592 open.

`questions.json` contains the fixed twenty-question C-PERF-01 workload. The
scratch repository must supply the referenced code, README and wiki pages;
missing cards fail the run rather than dropping those questions.

The composed install metrics route reuses the in-process Prometheus registry,
reports actual live socket count and the existing host profile/derived limits.
Missing latency producers are absent, never fabricated zero measurements.

Single-owner composition registers the workspace runtime's existing queue and
wake collector even before the first admission or daemon connection. Queue
depth and zero boot counts are defined then; wake duration remains absent until
the runtime observes a real boot. Conflicting collectors refuse startup.

Chat's existing collectors now include `smithers_chat_durable_latency_seconds`
for durable admission to first text and a completed answer with file/wiki
references. These process-monotonic observations include preflight and queue
time, but do not measure rendered cards. Duplicate/fenced callbacks cannot add
samples; failed, stopped or erased answers cannot add completion samples.
Only admissions observed in the same process are timed. The observer retains
at most 4096 open spans for one hour and counts capacity/expiry omissions in
`smithers_chat_latency_observations_omitted_total`; recovered admissions without
a local start have no timing. Browser samples remain the passing values.

An install with an authenticated daemon event pump also exports
`smithers_machine_bursts_total`. Its cumulative process-local counter supports
rate cross-checks: one completed logical burst counts after commit and native
object retention; staged parts, duplicate delivery and refusals do not count.
An install without that producer omits the family. It is not a file-reload
latency measurement or a microVM lifecycle qualification receipt.

The standalone keystroke driver uses the same artifact writer as the full runner,
including symlink checks for evidence directories and refusal to overwrite runs.

W20 targets: `smthrs test //scripts:perfUnit`,
`//scripts:perfKeystroke` (C-PERF-03), `//scripts:perfDiskWrite`
(C-PERF-04), and `//scripts:perf` (C-PERF-01–06 availability report).
The full run remains incomplete until every production driver and activation
precondition is available.

`node scripts/perf/disk-write.mjs` opens `src/a.ts` in the installed File
card and appends 200 fixed markers through a persistent, pinned batch SSH
connection. Run on the second Mac with an authorized scratch branch and a
newline-terminated file without `// m<number>` lines. Set the common origin,
page, install version, owner cookie and member A storage-state variables above,
plus `SMITHERS_PERF_SSH_DESTINATION` (the Branch card's `<branch>@<host>`),
`SMITHERS_PERF_BRANCH` (branch id), and `SMITHERS_PERF_SSH_MEMBER` (member C id).
The existing SSH identity must belong to C. No SSH options or remote command
are accepted from configuration. The driver exits its own control master.

It subscribes to the real branch files/activity topics before writing and refuses
unsupported publishers. It checks every card's full clipboard text against SSH
bytes and the file hint's SHA-256 and SSH attribution. Writes are spaced at
least 3 seconds apart; all 200 must produce distinct single-file burst entries.
The second Mac's Node monotonic clock measures SSH submission to receipt of a
browser DOM observer binding, an upper bound that also includes browser IPC.
The persistent master is checked before every write; fallback handshakes are
refused. Raw samples, activity and the authenticated host profile are retained
under both perf and C-PERF-04 check directories. No real-stack pass is claimed.

`//scripts:perfProjection`, `//scripts:perfWarmWake` and
`//scripts:perfRebaseHold` select C-PERF-02, 05 and 06 respectively. C-PERF-02 runs its configured measurement; C-PERF-05 and C-PERF-06
remain availability reports (exit 2), with missing drivers named in evidence.

`smthrs test //scripts:workingTogetherCodeFaults` runs the five composed
code-document link/recovery boundaries ten times each. HTTP authentication,
live transport, native document state and PostgreSQL are real; the remote daemon
is a scripted test peer. This is host-boundary evidence, never a K7 full-check
pass. Raw Go JSON and host metadata are retained under C-DUR-04. Each named
test must execute ten run/pass lifecycles and its package must complete; skips,
failures, duplicate passes and unrelated-package output cannot qualify.

Both code and wiki fault targets read the untracked
`.artifacts/working-together-host.json` fixture with `databaseUrl` (dedicated test
PostgreSQL) and `libraryPath` (absolute unprivileged native FFI library path).
Set `lane` to the lane namespace when the target runner filters ambient LANE;
otherwise they preserve the caller's LANE. They use the shared Go cache. The complete
K1–K8 target remains incomplete pending executable guest composition and the
writer/head/row/client evidence matrix.

`projection-delta.mjs` qualifies C-PERF-02 from the second Mac. Set
`SMITHERS_PERF_ORIGIN`, `SMITHERS_PERF_TODO` (a queued TODO that can move up
and down), `SMITHERS_PERF_OWNER_COOKIE` (session and `__csrf` cookies),
`SMITHERS_PERF_MEMBER_A` (Playwright storage-state file), and
`SMITHERS_PERF_INSTALL_VERSION`. The reference install needs ten TODOs.
Run `node scripts/perf/projection-delta.mjs` from the repository root.
It opens two Node live sockets plus three Chromium Home tabs, performs 200
idempotent moves, and records same-process monotonic timings and source cursors.
Any gap, coalescing, duplicate, refusal or unrelated delta fails the workload;
it never resubscribes to turn missing delivery into a passing sample. Metadata
snapshots may retain the current source cursor; a snapshot advancing it fails.
The runner writes raw samples through the existing artifact writer. A Linux
run cannot qualify the reference-host check.

`node scripts/perf/warm-wake.mjs` is the C-PERF-05 reference-Mac workload.
It opens 100 terminals through `POST /api/terminals`, observes an `awake`
Branch delta, closes each session through the retained session-destroy route,
and waits for `asleep` before the next sample. Set `SMITHERS_PERF_ORIGIN`,
`SMITHERS_PERF_BRANCH` (the Branch topic ID), `SMITHERS_PERF_REPOSITORY`
(`owner/repo`), `SMITHERS_PERF_OWNER_COOKIE` (including `__csrf`), and
`SMITHERS_PERF_INSTALL_VERSION`. The selected TODO must be in review, with a
previously booted and finally captured machine, no other work, and spare
capacity. `SMITHERS_PERF_SLEEP_SECONDS` records the configured idle policy
(default 120); it does not alter the install. The driver never discards cold,
failed, recovered-stream or mismatched-head samples.

`SMITHERS_PERF_HOST_WAKE_LOG` must identify a local JSONL export from the
install's host observer. Each complete record has `requestId` (the submitted
`X-Request-ID`), `branch`, `bootId`, `kind: "warm"`, `failed: false`,
`acceptedNs` and `awakeWrittenNs` (decimal strings from the same host monotonic
clock), and `workingHead` (independently observed in the machine after wake).
Acceptance must be measured before admission. The driver matches records by
request, rejects duplicate or cross-boot evidence and verifies the working head
against the preceding final capture. It reports nearest-rank host and client
p95 separately, and requires host p95 strictly below 5000 ms. Raw observations,
host sizing, commit, version, sleep policy and failures are written through the
shared artifact writer to both performance and C-PERF-05 check directories.
Credentials are excluded. Failed runs attempt to close their last terminal;
an unsuccessful cleanup records the remaining session ID.

The composed terminal service emits `machine wake observation` JSON log
records after provisioning settles. Acceptance starts after the request is
persisted and before admission grants capacity; the endpoint is the committed
awake state. The existing runtime supplies cold/warm classification, and guest
inspection supplies the working head. Missing, failed or repeated observations
remain failures. Requests recovered after a host restart have no local timing.
Point `SMITHERS_PERF_HOST_WAKE_LOG` at the backend's JSONL log export.

This driver is not a passing receipt. Qualified fresh/retained lifecycle and
root-layer evidence, a reference Mac and the real 100-sample workload remain
required. A client stopwatch or wake histogram cannot substitute for the host
log.
Run offline validation with `node --test scripts/perf/warm-wake.test.mjs`.

`agent-first-token.mjs` drives the main conversation on the second Mac. It uses
member A, the main conversation page, origin, owner cookie and install version.
Five warmups precede the twenty fixed questions repeated five times with a fixed
shuffle seed. The Enter keydown, first rendered answer text, and completed answer
with a File/wiki card use one browser monotonic clock. The driver reads model
metadata from the owner install API, verifies the server identity and conversation
access of the member fixture, reads Inspect, and cross-checks the wake counter.
It refuses missing Inspect preflight phases, host-monotonic `at`/`clock` receipts,
model/context or the wake counter. Existing preflight duration alone cannot
qualify those receipts. No reference-host run has been executed.

`lib/member.mjs` verifies each supplied Playwright storage-state session through
`GET /api/user` and `GET /api/conversations/main`. Co-editing refuses two states
that authenticate as the same member, even when the files have different names.
These are checks of operator-provided fixtures; no credentials or fake sessions
are minted. SSH fixtures still require the member's configured identity, trusted
host key, branch destination and verified write attribution.

`rebase-hold.mjs` contains a sample-driving contract tested with **test-only**
dependency boundaries. It sequences 100 ordinary and 100 delayed acknowledgement
rebases, retains typed markers, verifies guest hold clocks, activity and approvals,
and waits for delayed outbox drain. It restores the acknowledgement window on
failure. Its production adapter needs T-STK-08's Rebase now action and guest hold
logs, T-APP-14's edits, an acknowledgement-delay fixture and lifecycle qualification.
Invoking it uses the shared runner and reports incomplete (exit 2). Contract tests
emit no performance artifacts or passing check receipts. Browser C-PERF fixmes
remain. The existing upstream warm-wake implementation is retained in full.

Browser and SSH fixtures are checked through authenticated public reads before
scratch channels open. C-PERF-03 and C-PERF-04 require
`SMITHERS_PERF_SSH_IDENTITY`, an absolute path to member C's unencrypted SSH
private identity. OpenSSH derives its public fingerprint; the authenticated
member C session must list that fingerprint at `/api/user/keys`. SSH uses only
that identity with agent selection disabled. C-PERF-04 also requires member C's
storage state and verifies `SMITHERS_PERF_SSH_MEMBER` against its server identity.
The composed PostgreSQL router test covers a registered owner identity, a
foreign member identity and anonymous refusal. No real guest lifecycle is
qualified by those fixture checks.

The unified runner retains driver models, preflight summaries, wake counters,
and metric cross-checks alongside raw samples, including failed measurements.
The warm-wake driver and its tests were restored from upstream commit
3cd38de598; terminal startup and host observer export remain dependencies.

Keystroke and disk-write workloads refuse Linux before opening browser or SSH
connections. Failed first-token samples retain their question order as well as
model, preflight and wake cross-checks in the full runner evidence.

The unified C-PERF-06 verdict independently requires 100 normal and 100 delayed
acknowledgement samples, distinct retained markers, and p95 below 2000 ms in
each cohort. A pooled percentile cannot qualify the delayed cohort. Workload
exceptions retain completed samples and the failed attempt; delivery-restoration
errors remain alongside the original failure in unified artifacts.

The unified runner now binds the existing C-PERF-03, 04 and 05 workloads,
using their raw result objects without creating nested artifact directories.
C-PERF-05 compares `hostMs` with its budget; client timing stays a cross-check.
All three bindings refuse before measurement until authenticated lifecycle
qualification is exposed by the install. Environment flags cannot waive that
precondition. A configured driver is not an activated machine budget.
Standalone CLI behavior and artifact copies are preserved.

The C-PERF-06 artifact retains pending state, the rebase receipt, held marker
attribution, guest hold observations and completion of delayed outbox drain.
The unified verdict recomputes every duration from those observations and
rejects mismatched clocks, receipt replay, missing edits and missing delayed
capture/drain evidence independently of the workload verdict. This validation
is covered with test-only boundaries; it does not activate the production
adapter or qualify a reference-host check.
The durable preflight producer now records `at` and a process-scoped
`host monotonic:` clock on both phases, including every journal page. Historical
frames without timing remain readable. Paired preflight durations may be
aggregated across producers; raw samples keep each process clock identity.
Serving these frames through the installed Inspect trace route and real
reference-Mac browser qualification remain required before C-PERF-01 can pass.
