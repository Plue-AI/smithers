---
title: "Person confirmations"
description: "Private approval storage, session decisions and unavailable dispatch boundaries on an install."
---

Person confirmations use `approvals`, with a nullable agent-session reference
and a requesting member, immutable credential identity, command, subject and
revision. Review & merge also carries generation and reviewed PR head. Legacy
repository approval endpoints exclude these rows; they continue to serve run
waits.

The install mounts `GET /api/confirmations` for the caller's rows. Browser
sessions receive the full projection; eligible delegated credentials receive
only `id` and `state`. Run and machine credentials cannot read the projection.
`confirmations:<member-id>` is a private browser-session live topic; other
members and delegated subscribers are refused.

`POST /api/confirmations/{id}/deny` requires the requesting member's browser
session and current permission for the bound command. It transitions pending
to rejected using the existing pending-row CAS. The browser credential and
Idempotency-Key bind a denial receipt; a retry returns the receipt, and reuse
for another confirmation or action returns `409 idempotency_mismatch`.
An elapsed expiry settles pending to expired before a decision.

Creation and approval execution currently refuse with
`503 infra/confirmation_unavailable`: the shared catalog dispatcher and
subject-transaction consumer are not composed. No successful creation response
is fabricated, and an unavailable consumer leaves the confirmation pending.
This storage/audience increment does not establish C-ACC-02 dispatch or merge
acceptance. The existing person's TODO Merge path remains unchanged.
