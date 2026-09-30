---
title: "Engineering in a repository"
description: "Run engineering beside the code while keeping each box and credential scoped to one repository."
---

## Choose the repository before starting work

Declare engineering in the repository that contains the code. Its factory,
flow source, tests, and supporting instructions must be committed there.
A role registered in an operations repository runs in that repository's box;
naming another repository in its charter does not change its workspace or grants.
Factory rules cannot select a `repository`. Reconciliation rejects that field,
including an empty or null value, before changing any registrations.

Smithers already declares `issue.labeled:todo` with `coding/request` in
[its factory](../../../.smithers/FACTORY.ts). Put the engineering issue in
that code repository and have a configured maintainer apply `todo`.
The policy can also admit a maintainer-authored issue created at or after its
`todoSince` timestamp without that label.
The stack service starts the existing coding flow in that repository's own
workspace, with the approved source and repository policy. It proposes a
pull request under `changes: "send-upstream"`. The owner merges it, or a
maintainer applies `automerge` and the stack merges after review approval.
When GitHub merges the pull request, the next main pull marks the landing
merged with the GitHub merge commit as its receipt (`github_merge` on
`GET /landings/{n}`). Smithers never appends it to its own main. The
receipt needs the repository owner's GitHub App installation to cover the
GitHub repository; without one, the landing stays open.
Do not register a second prompt worker for the same TODO.

For another repository, commit its own factory and the flows it runs there.
Reuse public engineering instructions through versioned local source; never
load a private operations checkout, its credentials, or an unpinned remote
profile into a public build. A new executable file flow uses a tagged
`Flow.make` default export at `flows/<name>/flow.ts` and must be installed in
the host's executable catalog. The prompt-rule reconciler does not execute
TypeScript flows merely because their names appear in the projection.

## Keep authority local

Each prompt factory registration records its declaring repository, execution
owner, active workspace, and immutable source revision. The runtime resolves
those records again before launch and rejects a different workspace or
repository through
[the host target resolver](../internal/services/repository_job_flow_runtime.go). The flow's capability envelope does not authorize another
repository, even when the same person owns both.

An organization repository needs a configured factory owner who is still an
active organization owner, plus that person's active workspace in the code
repository. Missing ownership prevents new registrations and retires the old
factory registrations. Moving a role does not transfer existing registrations:
remove its old trigger from the operations factory and reconcile that revision,
then enable the code repository's factory. Retain the retirement receipt before
turning on the replacement to avoid duplicate work.

## Verify the rollout

Retain the code repository's committed revision, factory reconciliation receipt,
registration or coding launch, workspace and repository IDs, run result, test
output, and pull request. Exercise a second owned repository and confirm that
its source and credentials remain inaccessible from the first box. A launch
receipt alone does not prove that the role edited code, passed tests, or opened
a pull request. Database and resolver tests do not prove VM or credential
isolation in a deployed host; retain those receipts from the hosted run too.
