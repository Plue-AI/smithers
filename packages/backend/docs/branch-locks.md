---
title: Branch join permissions
description: Repository permissions for approving or denying branch join requests.
---

## Approve or deny a request

`POST /api/repos/{owner}/{repo}/branch-locks/join-requests/{id}/decide`
requires write access to the repository in the URL. The join request must
belong to that repository; using another repository's URL returns `404`
and leaves the request unchanged.

Only the current branch holder can decide a request, and the request must
match the current lock generation. Removing a member's access to a private
repository prevents them from deciding its requests, even if they still hold
its branch lock and can write to another repository.
