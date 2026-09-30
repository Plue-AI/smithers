---
title: Landing create keys
description: Stable create identity for landing requests, reviews and inline comments.
---

## Open a landing request

`PUT /api/repos/{owner}/{repo}/landings/requests/{request_uuid}` opens a landing request under a canonical UUID. A retry with the same UUID and input returns the original landing request, even after it is closed or merged; a changed input returns `409`.

Creating a landing request never opens a second in-flight landing request for one exact ordered stack of changes onto one target bookmark. While a landing request in `open`, `draft`, `queued` or `landing` carries the same change IDs in the same order onto the same target, any other create for that stack, with a different UUID or with none (`POST .../landings`), returns `409` with code `landing_stack_in_flight`; `details.number` names the landing request that holds the stack. Proposals onto one target are serialized, so concurrent callers open one landing request and every other caller receives that refusal. A refused UUID is not recorded. A reordered, partial or extended stack is a new proposal. After the landing request is `closed`, `merged` or `failed`, the next proposal opens a new one. This check applies to creates only; editing, reopening or retargeting an existing landing request does not consult it.

## Create a review or comment

Send `idempotency_key` in the JSON body of either endpoint:

- `POST /api/repos/{owner}/{repo}/landings/{number}/reviews`
- `POST /api/repos/{owner}/{repo}/landings/{number}/comments`

Use a stable key for each source review or comment, such as its provider object ID. The key is scoped to the authenticated user and landing request, separately for reviews and comments. A retry with the same key and input returns `201` and the original object ID. A changed input with the same key returns `409`; no second object is created. Two source objects with the same text need different keys.

The server stores the key and a digest of the normalized create input with the object. The key is optional for interactive creates. The response does not include the key or digest. Keep the existing source-to-destination mapping guard when syncing, and reconcile GitHub reviews by their GitHub IDs because GitHub does not offer the same create-key contract.
