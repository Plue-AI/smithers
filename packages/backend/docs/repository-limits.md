---
title: "Repository and organization limits"
description: "How plan limits cap repositories per owner and organizations per user."
---

Every repository counts toward its owner's repository limit, public or
private. Creating, forking, or importing a repository at that limit fails with
`402 plan_limit_exceeded` and `limit_kind` `repositories`. A private
repository also counts toward the private-repository limit; creating one at
that limit fails with `403`. Transferring a repository checks the new owner's
limits the same way.

Each organization a user owns counts toward that user's organization limit.
Creating an organization at the limit fails with `402 plan_limit_exceeded` and
`limit_kind` `organizations`.

| Plan       | Repositories | Private repositories | Organizations |
| ---------- | ------------ | -------------------- | ------------- |
| Free       | 200          | 100                  | 3             |
| Personal   | 500          | 250                  | 10            |
| Pro        | 1,000        | 500                  | 10            |
| Team       | 2,000        | 1,000                | n/a           |
| Enterprise | unlimited    | unlimited            | n/a           |

The billing overview reports `repositories` for every owner and
`organizations` for users. Concurrent creates for one owner are admitted one
at a time, so they cannot pass a limit together. Self-hosted installs have no
limits.
