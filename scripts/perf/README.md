# Installed-product performance evidence (#3592)

`node scripts/perf/run.mjs` currently records **incomplete** runs (exit 2).
Set `SMITHERS_PERF_ORIGIN` to the configured LAN/HTTPS origin and
`SMITHERS_PERF_OWNER_COOKIE` to an owner browser-session Cookie header. Host
metadata comes only from `GET /api/install/metrics`, which reads the existing Go
capacity service; no local detection or capacity calculation is performed.
The retired `/api/host` stays removed. PATs and delegated credentials cannot
read the owner-only metrics adapter.
Optional `SMITHERS_PERF_INSTALL_VERSION` and `SMITHERS_PERF_BROWSER` record
operator-supplied metadata, not verified release/browser identities.

Fresh `.artifacts/perf/<UTC timestamp>/summary.json` records six skipped budgets,
their required tickets and activation preconditions. An absent production driver
is named explicitly. This runner does not detect whether dependency tickets have
landed, execute a benchmark, or emit check receipts. It adds no privileged step.
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

Outstanding: five other public-boundary drivers,
browser and SSH fixtures, remaining §20.3 latency/wake/burst producers,
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

The standalone keystroke driver uses the same artifact writer as the full runner,
including symlink checks for evidence directories and refusal to overwrite runs.

W20 targets: `smthrs test //scripts:perfUnit`,
`//scripts:perfKeystroke` (C-PERF-03), `//scripts:perfDiskWrite`
(C-PERF-04), and `//scripts:perf` (C-PERF-01–06 availability report).
The latter remains exit 2 until all production drivers exist.

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
`//scripts:perfRebaseHold` select C-PERF-02, 05 and 06 respectively. They are
availability reports (exit 2), not measurements; their absent production
measurement drivers remain explicitly listed in the evidence.

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

This driver is not a passing receipt. The current S2 terminal route refuses
startup, its successful session-ID response still needs integration with
T-TRM-01, and the acceptance/state-write host observer export is not yet
implemented. Those must be supplied before a reference-host run can pass;
a client stopwatch or wake histogram cannot substitute for the host log.
Run offline validation with `node --test scripts/perf/warm-wake.test.mjs`.
