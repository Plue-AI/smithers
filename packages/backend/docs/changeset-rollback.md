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
go test ./internal/services -run 'TestChangesetNativeRollbackAppendsRevertAndRetryReapplies|TestChangesetRollbackRetriesARefusedRevertOnce' -count=1 -v
```

The native test uses real jj/git repositories behind the repo-host HTTP API.
Without the library path it skips; a skipped test is not release evidence.

## Hosted acceptance

Use disposable repositories with changesets enabled and retain the API responses,
member commit IDs, target history, and file contents:

1. Create a two-member changeset; make the first member a stack that lands by
   merging over an independently advanced target.
2. After the first member lands, advance both targets before the second landing
   so the second member fails its expected-head check.
3. Verify the first target still contains its landing and the other writer's
   commit as ancestors. Its appended revert restores the pre-landing files and
   retains the other writer's files. The changeset reports failed and clears
   member landing markers.
4. Retry land. Verify both members land, the first member's complete stack is
   reapplied, and every earlier target commit remains an ancestor.
5. Interrupt a revert response after its storage commit, then retry. Verify
   recovery uses the existing receipt and adds no duplicate revert.

Record both backend and repo-host image digests. Their native library must
provide `smithers_backout_change_range`; an older library fails to load rather
than silently accepting the changed ABI. Deployment or bootstrap success alone
does not prove this rollback scenario passed. Failed attempts can leave
unbookmarked reapply/revert changes in the repository.
