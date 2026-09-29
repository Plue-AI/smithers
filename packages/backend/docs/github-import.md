---
title: "GitHub import status"
description: "Status updates and access revocation for GitHub repository imports."
---

## Status updates

`GET /api/github/import/{id}` returns the caller’s import status. With
`Accept: text/event-stream`, it sends `import_job` events until `ready` or
`failed`, or a `timeout` event after five minutes.

Revoking the caller’s token, narrowing its scopes, or suspending the account
ends an open stream with a `revoked` event. No subsequent import status is
sent. If access was revoked during startup, the stream returns HTTP 403
before sending import details. Normal authentication can refuse the request
earlier with HTTP 401 or 403.

Clients should close the connection on `revoked` and authenticate again before
requesting status. Ending the status connection does not cancel the import.
