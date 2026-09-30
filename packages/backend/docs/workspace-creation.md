---
title: Workspace creation
description: Create and reuse named repository workspaces.
---

## Named workspaces

`POST /api/repos/{owner}/{repo}/workspaces` accepts `name`, optional
`source_bookmark`, and optional `kind` (`container`, `vm`, or `desktop`).
An omitted bookmark uses the repository default. An omitted kind uses
`container`. Any other field, such as `resources`, `image`, `network`,
`idle_timeout_seconds` or `services`, is refused with `400 unknown field`
before provisioning. The route never drops a setting silently.

```json
{"name":"issue-2924","source_bookmark":"main","kind":"vm"}
```

Reuse is scoped to the requesting user, repository, name, bookmark, and kind.
Different names can run concurrently on the same repository and bookmark.
Repeating the same identity returns its pending, starting, running, or suspended
workspace. Names are trimmed; an omitted name reserves the empty-name identity.
Concurrent requests for one identity share one workspace row before provisioning.
Explicit forks and snapshot restores create independent resources.

A repository with no commits yet still gets a workspace: its checkout has an
unborn branch named after the bookmark and a colocated Jujutsu repository, so
the first change can be committed there. A repository that has commits but
lacks the bookmark fails provisioning.

## From a pushed ref

`source_ref` names one of your refs pushed with `smithers repo push --name`
(`refs/smithers/users/<your id>/<name>`). The workspace checks out that commit
without starting a run; `source_commit` in the response is the commit. The ref
resolves only in your own namespace, so another user's ref name fails with
404 `user_ref_missing`. The commit is pinned under the workspace's own
`refs/smithers/workspaces/<id>/sources/<commit>`, so the checkout survives the
ref's expiry. A repository that lands through its mythical stack refuses it
with 409 `user_ref_stack`, and `source_ref` cannot be combined with
`snapshot_id`. Each request creates a new workspace: like a fork, it reserves
no named identity.

```json
{"name":"spike","source_ref":"spike"}
```

## Provisioning

Creation returns before provisioning completes. Poll the workspace until
`status` is `running` or `failed`. The per-user limit is 100 live workspaces;
reuse consumes no extra slot. Delete a workspace to release its name and slot.
Failed workspaces also release their identity and quota slot.
