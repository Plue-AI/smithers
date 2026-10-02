---
title: "Repository and organization limits"
description: "How plan limits cap repositories, organizations, and storage."
---

Every repository counts toward its owner's repository limit, public or
private. Creating or importing a repository at that limit fails with
`402 plan_limit_exceeded` and `limit_kind` `repositories`. A private
repository also counts toward the private-repository limit; creating one at
that limit fails with `403`.

Each organization a user owns counts toward that user's organization limit.
Creating an organization at the limit fails with `402 plan_limit_exceeded` and
`limit_kind` `organizations`.

Git objects count toward the owner's storage limit. A push over HTTPS or SSH
may send a pack no larger than the storage the owner has left; a larger pack
is refused before it is written, and HTTPS answers `402 plan_limit_exceeded`
with `limit_kind` `storage_bytes`. An owner at the limit can still move
branches to commits the repository already has. Pushes Smithers makes for the
owner, such as GitHub sync, are refused the same way. A GitHub import whose repository is larger fails before anything is stored.
After each push the repository's git size is measured and replaces its
previous measurement; an import is measured when it is created. History
a push deletes counts until repository maintenance removes it and a later push
measures again.

| Plan       | Repositories | Private repositories | Organizations | Storage   |
| ---------- | ------------ | -------------------- | ------------- | --------- |
| Free       | 200          | 100                  | 3             | 100 GiB   |
| Personal   | 500          | 250                  | 10            | 250 GiB   |
| Pro        | 1,000        | 500                  | 10            | 500 GiB   |
| Team       | 2,000        | 1,000                | n/a           | 1 TiB     |
| Enterprise | unlimited    | unlimited            | n/a           | unlimited |

The billing overview reports `repositories` for every owner and
`organizations` for users. Concurrent creates for one owner are admitted one
at a time, so they cannot pass a limit together. A push measures its
repository before it accepts a pack, so one repository cannot pass the
storage limit through pushes. Pushes and imports to different
repositories at the same time can each use the storage left, and git copies
objects the repository already has into a pack that needs them, so the owner
can pass the limit by that much; later pushes are refused. Self-hosted
installs have no limits.
