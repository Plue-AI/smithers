# C-MCH-05 Cleanup never deletes uncaptured work or a machine with an active session

Proves: mvp.md §6.7 Cleanup · spec.md §8.12, §4.1 (dropped → in_review within 7 days) · Layer: integration · Stage: S2 · Tickets: T-MCH-09
Automation: `packages/backend/internal/services/machine_cleanup_integration_test.go` (new) · Runs in: CI (real PostgreSQL, real jj, runtime fake, injected clock)

## Setup

- Real PostgreSQL 18 at head; the host repository store. One machine per case below, each asleep after a successful capture unless the case says otherwise.

| Case | TODO or branch | Capture | Active | Age since settle |
| --- | --- | --- | --- | --- |
| a | merged | ok, ref = capture | none | 24 h |
| b | merged | failed | none | 48 h |
| c | merged | ok, then a write (ref ≠ capture) | none | 48 h |
| d | merged | ok | open terminal | 48 h |
| e | merged | ok | SSH session | 48 h |
| f | merged | ok | service running | 48 h |
| g | dropped | ok | none | 23 h 59 m |
| h | in_review | ok | none | 30 d idle |
| i | scratch, archived | ok | none | 24 h |

## Steps

1. Run the cleanup job once at the case's age.
2. For each case, record whether the VM and disk were removed and `machines.state`.
3. For case a: read activity, attempts and evidence for the TODO; `git cat-file -e <captured commit>` in the host store; read the branch head ref.
4. Case g, at 7 days minus 1 h: reopen the PR on the fake GitHub server. Read files of the branch.
5. Kill the host process between marking case i `archived` and removing its disk. Restart and run the job.

## Pass when

- Step 2: only a and i are removed. b, c, d, e, f, g and h keep their VM and disk.
- Step 3: every row is present, the commit exists and the ref resolves.
- Step 4: the branch reads from its captured head, with content equal to the capture.
- Step 5: case i's disk is removed exactly once, and no other machine changes.

## Fail when

- Case b or c is deleted, which means uncommitted work was lost.
- Case d, e or f is deleted while a session or service is live.
- Deletion removes the head ref, activity or evidence.
- The job uses `last_activity_at` instead of the settle time, so case h, which isn't settled, is deleted.

## Evidence

`.artifacts/checks/C-MCH-05/<UTC timestamp>/`: `go test -json` output, the per-case decision log (each of the four conditions with its value), runtime fake call log, SQL dumps before and after, and the commit.
