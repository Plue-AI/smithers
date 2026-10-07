---
title: "Wiki transport"
description: "The shared backend owns wiki reads and live synchronization."
---

## Backend authority

The Worker forwards API requests to `SMITHERS_BACKEND_ORIGIN`, preserving bodies,
cookies, status and streaming. It owns no wiki state or synchronization protocol.

Wiki page reads, document snapshots and revision history remain ordinary HTTP
reads. The page-level `/updates` and `/stream` endpoints are retired; the
backend returns 404. There is no special Wiki update envelope or SSE replay.

Live co-editing belongs to the authenticated `/api/live` document transport.
While that transport is unavailable, the install serves snapshot reads and
refuses collaborative editing without an HTTP fallback.
