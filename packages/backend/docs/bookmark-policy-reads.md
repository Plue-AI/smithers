---
title: "Bookmark and repository policy reads"
description: "Bounded bookmark resolution and shared immutable policy reads."
---

## Bookmark resolution

`GET /repos/{id}/bookmarks/{name}` resolves the exact local bookmark with one
native `view().get_local_bookmark` lookup. The product client uses one request,
including names containing `/`. Listings remain paginated for enumeration only.
A missing bookmark returns `bookmark_not_found`; a missing repository remains
an error.

## Repository policy

Every issue event resolves the default bookmark again, then reads
`.smithers/factory.json` by its immutable commit ID. Readers sharing the same
product client coalesce concurrent reads by repository, commit and file path.
Successful reads and absent files are cached. Failed reads retry and callers
continue to fail closed. A directory, symlink, conflict or invalid revision at
the policy path is an error, never an absent policy. Each policy is parsed into fresh slices so a caller
cannot change another reader's policy.

The process-local cache retains up to 1,024 completed file reads, evicting
completed entries when capacity is needed. Active reads remain shared. A read
has the client's timeout; cancelling one caller does not cancel other callers.
Restarting the client or eviction permits a new read. Moving the bookmark to a
new commit always reads that commit's policy.

## Validation

Native and HTTP regressions resolve names among more than 500 bookmarks.
Concurrent policy regressions send 50 readers through the product boundaries,
assert one projection read per commit, and verify movement, failure recovery
and cancellation. These are request-count assertions, not production latency
claims.

## Rollout

Deploy repo-host before its API consumers. Named bookmark absence uses
`bookmark_not_found` and immutable file absence uses `file_not_found`. An older
repo-host's untyped 404 fails closed and is retried instead of being retained
as an absent policy.

For rollback, roll API consumers back before repo-host. Rolling repo-host back
alone leaves newer consumers failing closed on untyped absence responses.
