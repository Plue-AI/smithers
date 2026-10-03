# C-MCH-05 Cleanup never deletes uncaptured work or a machine with an active session

Proves: mvp.md §6.7 Cleanup · spec.md §8.12, §4.1 (dropped → in_review within 7 days) · Layer: integration · Stage: S2 · Tickets: T-MCH-09
Automation: unavailable (owner-approved executable mapping pending; C-PRC-03) · Runs in: unavailable (owner must declare the execution host)

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

Candidate Automation declaration (unapproved): `packages/backend/internal/services/machine_cleanup_integration_test.go` (policy, runtime fake, CI), `packages/backend/microsandbox/real_cleanup_reopen_test.go` (destructive recovery, real microVM, reference host); both use real PostgreSQL and an injected clock.

Owner action before PRC-03 activation: supply an explicit approved executable command and its declared Runs in host. Do not infer a command from a path or prose. Until that mapping is approved and available, the runner refuses this check and ticket closure remains blocked. Check: C-PRC-03.

## Steps

1. Run the cleanup job once at the case's age.
2. For each case, record whether the VM and disk were removed and `machines.state`.
3. For case a: read activity, attempts and evidence for the TODO; `git cat-file -e <captured commit>` in the host store; read the branch head ref.
4. In the policy suite advance case g past 24 h and run cleanup before testing reopen. In the real-microVM suite create a dropped TODO with distinct tracked and untracked files plus a binary file, capture it, record each path’s bytes and digest, and settle it with no sessions. Advance the clock to 24 h plus 1 min, run the production cleanup job, and verify the original runtime and disk path are absent. Verify captured commit, tree, blobs, branch head, activity, attempts and evidence remain in the host store. At 7 days minus 1 h reopen through the normal PR-reopen path, admit a fresh real microVM reconstructed from the captured head, and compare every recorded path byte for byte. Never reuse the old disk or preseed the new working copy.
5. Kill the host process between marking case i `archived` and removing its disk. Restart and run the job.

## Pass when

- Step 2: only a and i are removed. b, c, d, e, f, g and h keep their VM and disk.
- Step 3: every row is present, the commit exists and the ref resolves.
- Step 4: cleanup removes g’s original disk after retention. Reopen creates a fresh real machine from retained objects, and all recorded tracked, untracked and binary bytes match the capture. A missing object or use of the original disk fails the check.
- Step 5: case i's disk is removed exactly once, and no other machine changes.

## Fail when

- Case b or c is deleted, which means uncommitted work was lost.
- Case d, e or f is deleted while a session or service is live.
- Deletion removes the head ref, activity or evidence.
- The job uses `last_activity_at` instead of the settle time, so case h, which isn't settled, is deleted.

## Evidence

`.artifacts/checks/C-MCH-05/<UTC timestamp>/`: `go test -json` output, the per-case decision log (each of the four conditions with its value), runtime fake call log, SQL dumps before and after, and the commit.
