# Durability fault matrix (T-REL-04, #3459)

Run the existing serial matrix with `pnpm exec smthrs test
'//packages/...:faults' --jobs 1`. `Smithers.FaultSuite` discovers TypeScript
cases here; this command does not yet cover the planned Go cases below.
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
journal/service calls, skipped cases or a passing availability test. This
matrix is not yet nightly-qualified or reference-host-qualified.

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
