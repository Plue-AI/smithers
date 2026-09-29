---
title: Workspace creation
description: Create and reuse named repository workspaces.
---

## Named workspaces

`POST /api/repos/{owner}/{repo}/workspaces` accepts `name`, optional
`source_bookmark`, and optional `kind` (`container`, `vm`, or `desktop`).
An omitted bookmark uses the repository default. An omitted kind uses
`container`.

```json
{"name":"issue-2924","source_bookmark":"main","kind":"vm"}
```

Reuse is scoped to the requesting user, repository, name, bookmark, and kind.
Different names can run concurrently on the same repository and bookmark.
Repeating the same identity returns its pending, starting, running, or suspended
workspace. Names are trimmed; an omitted name reserves the empty-name identity.
Concurrent requests for one identity share one workspace row before provisioning.
Explicit forks and snapshot restores create independent resources.

Creation returns before provisioning completes. Poll the workspace until
`status` is `running` or `failed`. The per-user limit is 100 live workspaces;
reuse consumes no extra slot. Delete a workspace to release its name and slot.
Failed workspaces also release their identity and quota slot.
