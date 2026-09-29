---
title: Chat stream authorization
description: Revocation and reconnection for live chat responses.
---

## Revocation

Deleting a personal access token or suspending its account ends its live chat
response when the backend receives the revocation. The backend
checks revocation state when attaching the stream and before each delivery.
Unrelated accounts and tokens keep their streams.

Revocation ends delivery without cancelling or deleting the saved response. A
later request with valid credentials and the original journal proof can retrieve
that response through `/api/agent/turn/replay`.

Direct hosts that mount the chat handler must supply `Handler.Revocations` from
their revocation bus. The shared backend composition supplies its process bus.
