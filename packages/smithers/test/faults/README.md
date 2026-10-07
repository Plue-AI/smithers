# Durability fault matrix (T-REL-04, #3459)

Run the existing serial matrix with `pnpm exec smthrs test
'//packages/...:faults' --jobs 1`. `Smithers.FaultSuite` discovers TypeScript
cases here; `durability-required.test.ts` now selects the named Go cases below. Missing
case files, unmatched Go selectors, skipped cases and missing kill markers
fail the matrix. The PostgreSQL transition and three merge boundaries are implemented; the
remaining required production cases stay fail-closed. The composed Start admission
case uses the production dispatcher and workspace rows with a test-only VM
qualification contract; it proves the pinned launch survives SIGKILL before
any step, not machine or run recovery. Stop/Resume remain a separate required
case until their handlers land.
Existing engine/library crash tests are not C-DUR acceptance evidence.

| Check | Required production harness | Host |
| --- | --- | --- |
| C-DUR-01 | `host/case40-host-kill-todo-run.test.ts`; backend compose `todo_pause_fault_test.go` (Start) and services `todo_pause_fault_test.go` (Stop/Resume); compose `postgres_kill_fault_test.go` | Linux CI and reference Mac |
| C-DUR-02 | backend `flowhost/machine_kill_fault_test.go` | Approved reference Mac, microVM |
| C-DUR-03 | backend compose `github_outbound_kill_test.go`; compose `todo_merge_fault_test.go`; `github-step-kill.test.ts` | CI, PostgreSQL 18, fake GitHub |
| C-DUR-04 | backend machined `fault_test.go`, `rebase_fault_test.go` | Linux CI (daemon), approved reference Mac (VM) |

These are required paths, not claims of implemented coverage. The approved
mapping in `scripts/check-commands.json` and authenticated CI results determine
whether `node scripts/check-run.mjs C-DUR-0N --landed <full-sha>` can issue a
receipt. Pending-owner mappings refuse; do not replace them with direct
journal/service calls, skipped cases or a passing availability test. The serial matrix runs in the scheduled reliability workflow rather than
ordinary push/PR CI, without known-red allowances or cache credentials. The
reference-host matrix entry refuses before building or executing branch code
until main-bundle provenance, authenticated host selection and check mappings
are approved. It is not reference-host-qualified.

The shared Go child controller lives in backend `testkit/faultprocess`,
extracted from services `durable_crash_restart_test.go`. Both suites use it. Its vocabulary is `pre-commit`, `post-commit`,
`pre-launch`, `post-launch`, `stale-owner`. A child selects a point using
`SMITHERS_CRASH_POINT` and logs `CRASH-POINT <point> [details]`. The controller
must observe the exact point token before SIGKILL. Missing, wrong and
prefix-only markers cannot establish a reached kill boundary.

Additional required boundaries:

- Start: pinned Starting before the first step; Stop: durable pause before
  parking; Resume: settled pause before the next unfinished step. Retry keeps
  earlier attempt evidence and creates a new attempt at the pinned digest.
- Merge: before Land, after Land before GitHub, after GitHub before settlement.
  Drive the eligible member's merge route with a literal reviewed head.
- PostgreSQL: SIGKILL during a route-triggered transition transaction; compare
  REST/live state to committed product events after supervised recovery.
- Rebase: after capture, mid-rebase, after rebase before activity, both with
  people present and without. Drive the dispatcher and automatic rebase;
  observe acknowledged member writes, candidate invalidation and approvals.

Acceptance uses the production install supervisor, dispatcher/routes, real
PostgreSQL 18 and machine transport. Fake GitHub belongs only at the external
HTTP boundary. Missing launch, pause, reconciliation, merge-fence,
pending-operation, capture, watcher or transport contracts block their cases.
C-DUR-04 K1–K6 belong to S2; K7/K8 belong to their S3 owners.

Per-kill observations belong with the matching check's evidence under
`.artifacts/checks/C-DUR-0N/<timestamp>/`: exact point and subject, steps re-run,
external effects, acknowledged/found write hashes, attempt/event rows,
restart logs and commit/install identity. Retain these beside the existing
check-run receipt and verified log digest; no second receipt writer.
Unavailable cases are non-passing evidence, never skips or fabricated zero
counts. This documentation produces no acceptance receipts.

No branch-built daemon or repository payload runs as root. Privileged cases
remain blocked on C-SEC-02 validation, the rebase root-input tests, approved
main-bundle artifacts and approved reference-host selection. Release binaries
must contain no kill selectors. This lane adds no privileged execution.

The Go JSON stream is retained in the existing FaultSuite output. Per-kill
observations supplied by case owners are uploaded from the matching check
evidence directories; this runner does not synthesize observations or receipts.
The runner requires a passed named test, no skipped/failed subtests and a
complete `CRASH-POINT` line attributed to every executed leaf case. Nested
matrices must mark each leaf; a parent's or sibling's marker cannot qualify
another case, and an unfinished leaf fails even if its parent reports success.
Controllers still own exact point
validation before killing. A marker alone is never recovery proof.

The nightly Linux job provisions an isolated PostgreSQL 18 service and requires
database tests. The reference entry remains refused before branch execution.
The Go wrapper prints stdout and stderr before checking process errors, signals
and exit status, retaining partial JSON on failed or timed-out cases. These
logs are diagnostic output, not passing check receipts.

The additional route cases must cover these exact marker tokens, in passing
leaf cases: `start`, `stop`, `resume`; `postgres-transition`;
`merge-pre-land`, `merge-post-land`, `merge-post-call`; and
`rebase-post-capture`, `rebase-mid`, `rebase-post-apply`. These extend the
shared vocabulary above. The runner checks the full point inventory, so
omitting a boundary cannot pass even when every executed leaf has a marker.
Repeated markers and parent-only markers do not satisfy a missing boundary.
The rebase harness names its presence subtests `people-present` and
`people-absent`. The runner requires all three rebase markers in passing
leaves within each context; a marker from the other context cannot satisfy
a missing kill point. Cases must also retain their recovery observations.

`internal/compose/postgres_kill_fault_test.go` now supplies the
`postgres-transition` case. Its operation is a person's Drop through the
production install router. Fixtures precede dispatch; a database trigger holds
the real event insert after the item update. A second connection observes
`PgSleep` and requires the PostgreSQL child log marker before the controller
kills its own PostgreSQL 18 cluster. REST and event replay retain Queued after recovery. The failed
request is not acknowledged; its retry and replay commit exactly one Drop.
HTTP exchanges, committed event replay and PostgreSQL recovery logs are retained
under `C-DUR-01/<timestamp>/postgres-transition/`.

This test needs PostgreSQL 18 `postgres` and `initdb` binaries. Set
`SMITHERS_FAULT_POSTGRES_BIN` to their directory when they are outside PATH.
It creates a private cluster on a loopback ephemeral port, disables Unix
sockets, and signals only its postmaster and the children whose kernel parent PID is that
postmaster. It waits for those children to exit before restart. It never kills the shared
integration database server. Restart is driven by the test controller; this
case does not qualify the install supervisor, run recovery, live WebSocket
projection, or all of C-DUR-01. The case lives in `compose` so it can reuse the
production router harness without introducing a services/compose import cycle.

The nightly Linux job builds checksum-pinned PostgreSQL 18.0 from the official
source archive into its runner temporary directory as the harness user. It
builds `pgcrypto` with OpenSSL for product migrations and exports
`SMITHERS_FAULT_POSTGRES_BIN` for the private-cluster case; the Docker
service remains the database for other integration cases. No system install,
sudo, or shared-server stop is required. Source provisioning is separate from
reference-host artifact approval and does not enable privileged cases.

To run only the Linux fault job remotely, dispatch `reliability.yml` on `main`
with `campaign: faults-linux`. Its default `all` and the nightly schedule keep
all campaigns and both host selections. The Linux selection does not enable
reference-host execution or approve check mappings.
