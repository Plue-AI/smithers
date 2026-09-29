---
title: "Shared app history"
description: "Write permissions and membership changes for shared app history."
---

Owners manage membership. Editors can append events, replace history, and save
snapshots; viewers can read.

Writes and membership changes use the same per-history transaction lock. Each
write checks current membership after acquiring that lock. If removal commits
first, a queued write returns 404; if demotion to viewer commits first, it returns
403. Rejected writes leave events, branches, snapshots, and the history position
unchanged. A write that acquires the lock first may finish before the membership
change commits.

Self-hosted service composition must supply `WithAppTimelineTxBeginner(pool)`
with the PostgreSQL pool, use the generated database queries, and retain the
default READ COMMITTED isolation level. This binds permission checks and mutations
to the transaction holding the lock and makes committed membership changes visible.
