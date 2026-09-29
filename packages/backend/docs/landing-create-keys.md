---
title: Landing review and comment create keys
description: Stable create identity for landing reviews and inline comments.
---

## Create a review or comment

Send `idempotency_key` in the JSON body of either endpoint:

- `POST /api/repos/{owner}/{repo}/landings/{number}/reviews`
- `POST /api/repos/{owner}/{repo}/landings/{number}/comments`

Use a stable key for each source review or comment, such as its provider object ID. The key is scoped to the authenticated user and landing request, separately for reviews and comments. A retry with the same key and input returns `201` and the original object ID. A changed input with the same key returns `409`; no second object is created. Two source objects with the same text need different keys.

The server stores the key and a digest of the normalized create input with the object. The key is optional for interactive creates. The response does not include the key or digest. Keep the existing source-to-destination mapping guard when syncing, and reconcile GitHub reviews by their GitHub IDs because GitHub does not offer the same create-key contract.
