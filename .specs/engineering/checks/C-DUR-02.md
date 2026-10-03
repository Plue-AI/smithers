# C-DUR-02 Killing a machine mid-run resumes the run or shows it interrupted

Proves: mvp.md §6.1 Restart, §9 Durability and Honesty · spec.md §4.1 (`working → failed` on `uncertain`, `failed → queued`), §8.4 (disk outlives the VM), §11.4.2, §19.1, §19.2 · Layer: fault · Stage: S2 · Tickets: T-FLW-09, T-REL-04
Automation: `packages/backend/flowhost/machine_kill_fault_test.go` (new), beside `workspace_crash_recovery_test.go` · Runs in: reference host (needs `msb` 0.6.16), nightly

## Setup
- Install at the commit under test with microVM isolation, real PostgreSQL 18, fake GitHub server; capacity 2.
- Scratch repository with `test` and `lint` scripts. The `todo` flow has three shell actions: the check (declared idempotent), a migration step that writes to an external fake service and declares a `reconcile` lookup, and a step that declares neither.
- `todo` is Active at digest D1. Before the kill, activate D2 (T-FLW-03).
- Kill points: M1 during a model call in `implement`; M2 during the check; M3 inside the reconciled step after its write reached the fake service; M4 inside the step that declares neither.

## Steps
1. Start a TODO and drive it to the kill point.
2. Kill the VM's libkrun process with `SIGKILL`.
3. Wait for the machine to wake again under admission, or for the run to reach a terminal state.
4. For M4, select Retry on the TODO card.
5. Read the run journal on the machine's disk, the fake service's request log, `item_events`, `checks.Attempts` and the TODO card.

## Pass when
- M1 and M2: the run resumes on the same machine disk; finished steps keep one attempt row; the check result appears once.
- M3: the lookup finds the write, the step is sealed with the found outcome, and the fake service logs exactly one write.
- M4: the run stops as `interrupted`, the TODO shows Failed with class `interrupted` and Retry, and no step re-ran on its own. After Retry a new `checks.Attempts` row starts a new run on D1 from its first step, and the earlier attempt and its evidence are kept (§4.1).
- Every resumed or retried run keeps digest D1, not D2.
- Within 60 s of the kill, the TODO card shows either a working run or `interrupted`; it never shows Working without a live run.

## Fail when
- The reconciled step writes to the fake service twice.
- The step with no declaration re-runs by itself after the kill.
- The run switches to D2 on resume.
- The TODO stays Working with no live run and no Retry.

## Evidence
`.artifacts/checks/C-DUR-02/<UTC timestamp>/`: per kill point, the journal attempt dump from the machine disk, the fake service request log, `item_events` and `checks.Attempts` rows, TODO card screenshots before and after, `msb` and launcher logs, and the commit and install version.
