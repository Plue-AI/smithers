---
title: "Repository creation recovery"
description: "Durable reservations and completion receipts for repository creation."
---

## Recovery

Repository creation reserves an ID and token in PostgreSQL before staging
storage on repo-host. Recovery acquires the repository namespace lock, then
reads the reservation again by ID and token. An aborted or replaced reservation
is skipped. The current reservation supplies the creation inputs.

If repo-host completed an abort before the API could delete the reservation,
recovery repeats that abort and releases the reservation after its completion
receipt is confirmed. A failed abort keeps the reservation for retry.

## Completion receipts

Repo-host retains permanent token receipts under `.provision-decisions@` in its
storage root. Abort and finalize persist their receipt before removing the
provisioning journal and acknowledging completion. This also applies when the
journal is already absent. Keep these receipts with the storage backup; deleting
them permits delayed requests to reuse completed tokens.
Restore completion receipts together with repository storage after a restart or
backup recovery. They have no expiry.

A completed token refuses further staging, publishing, and import writes.
Repeating the same completion settles its durable receipt and any remaining
staging directory. It does not touch the live repository again. A different
completion action returns a conflict. Finalizing an unpublished stage remains a
conflict and does not consume its token.

Ordinary stage and publish retries remain valid until completion. A completed
token stays fenced across repo-host restarts, whether its old destination is
occupied or free.
