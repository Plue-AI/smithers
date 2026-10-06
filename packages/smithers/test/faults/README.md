# Durability fault matrix (T-REL-04, #3459)

Run the existing serial matrix with `pnpm exec smthrs test
'//packages/...:faults' --jobs 1`. `Smithers.FaultSuite` discovers TypeScript
cases here; `durability-required.test.ts` now selects the named Go cases below. Missing
case files, unmatched Go selectors, skipped cases and missing kill markers
fail the matrix. The current production cases remain unavailable.
Existing engine/library crash tests are not C-DUR acceptance evidence.

| Check | Required production harness | Host |
| --- | --- | --- |
| C-DUR-01 | `host/case40-host-kill-todo-run.test.ts`; backend services `todo_pause_fault_test.go`, `postgres_kill_fault_test.go` | Linux CI and reference Mac |
| C-DUR-02 | backend `flowhost/machine_kill_fault_test.go` | Approved reference Mac, microVM |
| C-DUR-03 | backend compose `github_outbound_kill_test.go`; services `todo_merge_fault_test.go`; `github-step-kill.test.ts` | CI, PostgreSQL 18, fake GitHub |
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

The shared Go child controller lives in backend services
`durable_crash_restart_test.go`. Its vocabulary is `pre-commit`, `post-commit`,
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
The rebase harness must still cover both presence contexts and retain their
observations; point inventory alone does not prove that coverage.
