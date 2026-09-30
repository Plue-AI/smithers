---
title: "Durable push delivery"
description: "Repository identity, retries, and recovery for Git push callbacks."
---

## Repository identity

Every push producer sends the database repository ID to repo-host using
`X-Smithers-Repository-Id`. Repo-host persists `repository_id` in each durable
callback before acknowledging the Git push. The callback resolves that ID to
its current owner and name; it never resolves an event through a reusable name.

A rename or ownership transfer keeps the ID and records the current coordinates.
Deletion returns typed `404 not_found`, which settles the delivery without
creating an event. Creating another repository at the old name allocates a new
ID and cannot inherit the old delivery. Transient lookup or insert failures keep
the delivery pending. Delivery IDs continue to deduplicate successful retries.

## Storage identity

Repo-host selects native storage by owner and name when it takes the
repository lock, after the producer authorized the push for a repository ID.
Git HTTP and SSH hold the pack until repo-host reports the lock, then check that
owner and name still resolve to that ID. A repository deleted, transferred or
renamed away in between is refused with `409` over HTTP and an error over SSH;
nothing reaches the replacement's storage. A retry authorizes against the
repository the name holds now.

## Upgrade and recovery

Deploy the API, Git HTTP and SSH producers, and repo-host together. Repo-host
must answer a push that waits for the lock before it reads the pack, so deploy
repo-host no later than the producers. Upgrade the
API before enabling new producers: an old API ignores the new identity field.
Callbacks already queued without `repository_id` receive `409` and remain in the
outbox for explicit reconciliation. Inferring an ID from owner/name is unsafe.

Monitor `smithers_repo_host_push_hook_deliveries_total` and repo-host delivery
errors. Pending files live in `.push-hook-outbox@` under the configured storage
path; after 24 hours of unsuccessful delivery they move to `.push-hook-dead@`.
Preserve those files during an upgrade. Reconcile an unidentified delivery only
against independent records establishing the original database repository ID;
never assign it to whichever repository currently owns its name. If identity
cannot be established, retain it for investigation instead of replaying it.

## Verification

The regression suite exercises callback rejection and current coordinates by
repository ID, authenticated producer metadata, and real PostgreSQL/native Git
pushes with callback failure followed by restart and replay. It checks unchanged
identity, deletion, recreation, and ownership transfer, including stored IDs and
outbox settlement.
