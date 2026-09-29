---
title: Pair session permissions
description: Permission checks for queued prompts and shared drafts.
---

## Waiting submissions

Removing an editor, changing their role to viewer, or ending the session
rejects their waiting prompt submissions once that change completes.
Rejected shared-draft submissions leave the draft unchanged and add no prompt.
Editors whose access remains valid can still submit normally.

Enqueue and shared-draft submissions acquire the queue lock, then the session
membership lock, and check current access within the write transaction.
Membership changes and ending a session share the membership lock through commit.
