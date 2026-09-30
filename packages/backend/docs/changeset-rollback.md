# Changeset rollback

A partially landed changeset appends a revert to each landed member's target
bookmark. It never rewinds the bookmark. The revert removes the complete
landing range, including stacked changes, while preserving later commits from
other writers. Retrying the changeset backs out its revert to reapply the member.

The persisted landing plan records each revert before landing it. Landing
receipts make recovery safe after a lost response. A refused revert remains a
visible rollback failure and is retried on the next land request.

## Local verification

Build the native library from the same revision as the backend, then run from
`packages/backend` with `SMITHERS_FFI_LIBRARY_PATH` set to its absolute path:

```sh
go test ./internal/services -run 'TestChangesetNativeRollback|TestChangesetRollbackRetriesARefusedRevertOnce' -count=1 -v
```

The native tests use real jj/git repositories behind the repo-host HTTP API,
including recovery after losing a persisted revert response. They verify receipt
replay adds no duplicate revert and a retry reapplies the member. Without the
library path they skip; skipped tests are not release evidence.

## Hosted acceptance

Use disposable repositories with changesets enabled and retain the API responses,
member commit IDs, target history, and file contents:

1. Create a two-member changeset; make the first member a stack that lands by
   merging over an independently advanced target.
2. Land it while another writer pushes to the second target, until the second
   member fails its expected-head check after the first member lands. A large
   first member, such as 20,000 files, widens that window.
3. Verify the first target still contains its landing as an ancestor. Its
   appended revert restores the pre-landing files. The changeset reports
   failed and clears member landing markers.
4. Retry land. Verify both members land, the first member's complete stack is
   reapplied, and every earlier target commit, including the other writer's,
   remains an ancestor.

The public API cannot interrupt a revert response or move the first target
between its landing and its revert; the native tests cover both.

Record both backend and repo-host image digests. Their native library must
provide `smithers_backout_change_range`; an older library fails to load rather
than silently accepting the changed ABI. Deployment or bootstrap success alone
does not prove this rollback scenario passed. Failed attempts can leave
unbookmarked reapply/revert changes in the repository.
