---
title: "Commit checks"
description: "Check results in commit cards and chat answers."
---

## Read a commit

`/commits.read <change-id> <owner/repository>` shows the commit's checks in
its card and chat answer. The newest result per check determines the status:
failure takes precedence over pending, then success. Missing or unavailable
checks do not count as success.
