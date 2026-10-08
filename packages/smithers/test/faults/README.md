# Durability fault matrix (T-REL-04, #3459)

Run the existing serial matrix with `pnpm exec smthrs test
'//packages/...:faults' --jobs 1`. `Smithers.FaultSuite` discovers TypeScript
cases here; `durability-required.test.ts` now selects the named Go cases below. Missing
case files, unmatched Go selectors, skipped cases and missing kill markers
fail the matrix. The PostgreSQL transition and three merge boundaries are implemented; the
remaining required production cases stay fail-closed. The composed Start admission
case uses the production dispatcher and workspace rows with a test-only VM
qualification contract; it proves the pinned launch survives SIGKILL before
any step, not machine or run recovery. The packaged pause control below exercises the shipped engine boundary. The composed
Stop/Resume handlers have landed; the protocol-peer delivery controls below
cannot qualify engine parking or completed-step replay.
Existing engine/library crash tests are not C-DUR acceptance evidence.

| Check | Required production harness | Host |
| --- | --- | --- |
| C-DUR-01 | `host/case40-host-kill-todo-run.test.ts`; backend compose `todo_pause_fault_test.go` (Start) and compose `todo_live_pause_fault_test.go` (Stop/Resume); compose `postgres_kill_fault_test.go` | Linux CI and reference Mac |
| C-DUR-02 | backend `flowhost/machine_kill_fault_test.go` and compose `todo_machine_kill_fault_test.go` | Approved reference Mac, microVM |
| C-DUR-03 | backend compose `github_outbound_kill_test.go`; compose `todo_merge_fault_test.go`; `github-step-kill.test.ts`; `engine/case39-kill-crossing.test.ts` | CI, PostgreSQL 18, fake GitHub |
| C-DUR-04 | backend machined `fault_test.go`; compose `rebase_fault_test.go` | Linux CI (daemon), approved reference Mac (VM) |

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
### T-FLW-09 host and machine controls

`host/case40-host-kill-todo-run.test.ts` invokes
`TestTodoHostKillThroughInstall` in the shared composed install rehearsal.
It requires real PostgreSQL, the native FFI library, and a source-export helper
with `trusted-process-binding/v1`. The packaged host is killed with SIGKILL
at an intended keyless action. It must expose an interrupted TODO without
repeating the completed action, then retain D1 and its evidence when the same
Retry press is delivered twice after D2 activation. This trusted-process
control does **not** qualify microVM isolation or an installed Mac host kill.
Missing prerequisites fail the fault tier; ordinary Go suites leave the
explicit qualification disabled.

```sh
cd packages/smithers
pnpm exec vitest run --config vitest.faults.config.ts test/faults/host/case40-host-kill-todo-run.test.ts
```

`flowhost/machine_kill_fault_test.go` supplies the reference-machine transport
and retained-disk control. Set `SMITHERS_FAULT_HOST=reference` and
`SMITHERS_FAULT_INSTALL_BUNDLE` to an approved installed bundle. It uses the
production microVM adapter, stops only its own VM with zero shutdown grace
during an unprivileged command, observes unsuccessful command settlement,
refuses recovery through the durable dispatcher while the machine is stopped,
and checks retained bytes after restarting the same machine. It is
**supplemental**: the composed TODO machine-kill/Retry and completed engine-step
replay acceptance still need reference-host qualification. Never count this
transport control alone as a passing C-DUR-02 receipt.

`compose/todo_machine_kill_fault_test.go` authors the composed TODO lifecycle control.
It requires the approved installed bundle on an Apple Silicon Mac, abrupt
shutdown of its own real VM, retained completed-step bytes, interrupted state,
duplicate Retry after D2 activation, D1 execution and prior-attempt evidence,
and an absent host canary. The reference matrix requires its
`machine-mid-todo` observation separately from the transport control.
It has not been qualified on this Linux host.

The existing `engine/case39-kill-crossing.test.ts` is the keyed/sealed/keyless
engine control, not the five-kind composed GitHub acceptance. The matrix
continues to require `compose/github_outbound_kill_test.go`; the service fault
fixture cannot replace its production propose/merge/drop admission coverage.

### Stop/Resume delivery crossings

`compose/todo_pause_delivery_fault_test.go` drives the composed install HTTP
router with a live owner session and real PostgreSQL. For Stop and Resume it
kills the dispatcher child immediately before its signal effect, or after the
protocol peer persists the effect and before acknowledgment. Every kill needs
its exact child marker. A fresh dispatcher reconciles the existing request;
a repeated HTTP press keeps one admission fact, one intent, one effect, the
same run, attempt and pinned flow. The test checks the visible flow version
after recovery and refuses any Active-flow lookup.

These four crossings use a durable test protocol peer. They prove route and
delivery recovery, not the TODO engine's paused wait or completed-step replay.
The nightly matrix runs them in addition to the packaged-engine
`TestTodoStartPauseResumeCrashThroughRoutes`; it never substitutes them for
that acceptance case. The child environment is the shared fault harness's
credential-free environment. No root process or real GitHub write is involved.

```sh
cd packages/backend
go test -p 4 ./internal/compose -run '^TestTodoStopResumeDeliveryCrashComposed$' -count=1
```

### Packaged Stop/Resume control

`compose/todo_live_pause_fault_test.go` supplies
`TestTodoStartPauseResumeCrashThroughRoutes`. Install setup, TODO admission and
the ordinary parent workers use the shared composed install. The built-in TODO
holds its scripted planning turn before the next shipped pause boundary. The
boundaries inline into the parent plan, so later observations cannot run ahead
of planning or delivery. Their empty branch retains a JSON literal and returns
void; it survives Control's persisted plan decoding.

A credential-isolated dispatcher child serves the owner’s HTTP Stop/Resume
press and blocks after the packaged runtime accepts its durable signal. The
shared controller requires the exact `stop` or `resume` marker before SIGKILL.
The ordinary install worker then reconciles that same request. A temporary
PostgreSQL trigger reserves only pause-control deliveries for the child; it
never creates or settles a signal or engine wait.

Stop must park the real run after planning returns. Resume can advance directly
to an ordinary parked review without retaining the old pause. It retains that run,
its attempt and its original digest. Duplicate presses preserve the same
admission receipt. Provider observations require exactly one route and planning
turn. Per-crossing observations are retained under
`C-DUR-01/rehearsal/<timestamp>/{stop,resume}/`. The matrix selects both kill
leaves explicitly and still refuses any failed or skipped setup node.

This proves packaged engine parking/continuation plus dispatcher delivery
recovery on the trusted-process install. It does not qualify a microVM kill,
a cold engine-host restart, privileged execution or launchd supervision.
Reference-host qualification and approved check mappings remain required.

```sh
cd packages/smithers
pnpm exec vitest run --config vitest.faults.config.ts test/faults/durability-required.test.ts -t 'C-DUR-01: TestTodoStartPauseResumeCrashThroughRoutes'
```

### Composed reference rebase faults

`compose/rebase_fault_test.go` replaces the unavailable rebase cells with
`TestRebaseCrashThroughDispatcher` (daemon replacement) and
`TestRebaseVMCrashThroughDispatcher` (real `msb stop -t 0`). Both cover all
three points with and without people, ten repetitions per cell. Each run installs the approved bundle,
starts a TODO through the composed HTTP door, and writes 20 files through the
real member terminal. Acknowledgements follow write, fsync and close. The
person-present case holds a gated member writer while the kernel reports
`frozen 1`; opening its gate must produce no write. The person-absent case
closes the browser terminal and withdraws its presence before automatic rebase.
No empty broker or process runtime qualifies these cells.

The driver uses private qualification arm/hit/exit files already supported by
main's debug killpoints daemon. It requires the exact hit before daemon exit or
VM stop, reconnects through the production supervisor, checks `frozen 0`, and
compares every acknowledged byte and digest through the install's file HTTP
route and the captured host tree. The head visible at the kill must equal the
pre-rebase capture or recovered capture. One `todo.rebased` entry and an empty
outbox are required. Setup subtests cannot supply the crossing's marker or its
final recovery observation; FaultSuite requires all sixty exact crossings.

`TestRebaseFaultRootInputsValidatedBeforeUse` additionally selects the retained
VM restart crossing. Every reference campaign first executes the inherited
C-SEC-02 startup, symlink and bounded-envelope cases, refusing skipped or missing
cases. The composed cases probe retained member symlinks, traversal, hostile
argv/env targets and forged kill selectors; observe the member UID/GID/groups
and cgroup; retain an outside canary; and prove the member cannot create a root
canary. Every control script executes only after the approved image's fixed
setpriv drops UID/GID/groups. No branch-built executable is installed as root.

Supplemental `microsandbox/TestRebaseApprovedRootArtifactSubstitutionRefused`
uses the production runtime startup boundary for 15 substitutions: changed
bytes, forged replacement manifests after pinning, and symlinks for msb,
kernel, jj, export helper and coding host. Refusal precedes executable use and
state creation; restored approved bytes reach the positive launch control.
These Linux controls alone do not qualify privileged startup or VM recovery.
`machined/TestRebaseFaultTransportInputsRefusedBeforeSend` retains the original
socket refusal controls without claiming root qualification.

On the approved reference Mac, with a main-built debug qualification bundle:

```sh
SMITHERS_REBASE_FAULT_REQUIRED=1 \
SMITHERS_REBASE_FAULT_REFERENCE=1 \
SMITHERS_CHECK_BUNDLE="/absolute/approved/main-bundle" \
go test -p 4 ./internal/compose \
  -run '^TestRebase(CrashThroughDispatcher|VMCrashThroughDispatcher|FaultRootInputsValidatedBeforeUse)$' \
  -count=1 -timeout 4h
```

Existing check-run receipt handling remains the only qualification receipt
writer. The driver's per-cell observations live in the rehearsal evidence
directory. Missing reference selection fails in required mode; ordinary runs
skip, and FaultSuite rejects skips. Execution on the mini, current bundle
approval, and authenticated owner mappings remain required. This automation
has not been executed on the reference host by the Linux lane.

### Supplemental composed rebase process kills

`compose/TestBranchRebaseNativeCrashRecovery` runs all three rebase boundaries
with people present (the composed HTTP Rebase now dispatcher) and absent
(the automatic stack boundary), using real PostgreSQL, jj and authenticated
host-to-daemon transport. Each cell consumes a private one-shot qualification
arm, requires its exact marker, SIGKILLs only its own namespace process,
restarts with retained daemon state and boot authority, and checks retained
file bytes, the final captured tree and one `todo.rebased` entry. Verify launch
is recorded rather than running checks in this test. The supported stack clock
advances past the persisted outage backoff; daemon and freeze time stay real.

The boundaries are after the capture checkpoint, after the native repository
transaction but before checkout, and after checkout before the host activity
entry. Hooks exist only with `killpoints` in debug builds. Ordinary and release
builds contain none of these selectors.

Run an **unprivileged** qualification example, never install it as root.
Copy the built executable to a private path before running the test when using
a shared Cargo target directory; another build can replace its output.

```sh
cargo build --locked -p smithers-machined --features killpoints --example rehearsal_daemon
cd packages/backend
SMITHERS_REBASE_PROCESS_FAULTS=1 \
SMITHERS_REHEARSAL_MACHINED_BINARY="/absolute/private/rehearsal_daemon" \
go test -p 4 ./internal/compose -run '^TestBranchRebaseNativeCrashRecovery$' -count=1
```

This is supplemental process recovery evidence. The empty rehearsal broker
cannot qualify member writes, cgroup freeze, privileged input validation or
VM recovery. The required composed reference rebase matrix still needs its approved Mac
execution; supplemental controls do not enable its check mapping.
