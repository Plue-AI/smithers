---
title: Hosted walkthroughs
description: Publish, isolate, and remove review walkthroughs.
---

## Hosting boundary

Set `PUBLIC_BASE_URL` to the HTTPS origin of a dedicated user-content domain,
separate from every product or login registrable domain. It must contain no
credentials, path, query, or fragment. The worker rejects `jjhub.tech` and
`smithers.sh`, including their subdomains. Self-hosted operators must choose a
separate registrable domain for their own installation.

Only `GET /w/<id>` serves content on that origin. Other routes on its hostname
return 404; API, admin, metrics, and inference remain on the review API host.
Session responses keep their publish and inference endpoints on the API origin.
Walkthrough reads on other origins return 404 before storage access. Missing or
invalid content configuration disables reads, publishing, and history; deletion
remains available. Publishing and history never fall back to the API origin.

Keep `Content-Security-Policy: sandbox allow-scripts` on uploaded HTML.
Domain isolation does not make uploaded content trustworthy.

Hosted provisioning is tracked in `smithersai/plue#712`; qualified resource
adoption and rollout are tracked in `smithersai/smithers#1906`. Before rollout,
bind the provisioned content hostname and set `PUBLIC_BASE_URL` to its origin,
retaining the review API hostname and existing D1 and R2 resources. Verify a
known upload returns sandboxed HTML only on the content origin and 404 on
`review.jjhub.tech` and the Workers development hostname. Verify content-host
API requests return 404. Source tests alone are not a hosted rollout receipt.

## Publishing and retention

`POST /api/walkthroughs` reserves metadata before uploading HTML. Each session
can hold up to 50 walkthroughs, including pending uploads. Concurrent requests
for the last slot yield one success and a `429` for the other request.

`GET /api/walkthroughs?repo=owner/name` includes `status` on each history entry:
`pending` during upload or after interruption, and `complete` after upload and
metadata finalization. Existing walkthroughs migrate to `complete`.

Upload or finalization failures remove the object before releasing the slot.
If object cleanup fails or the worker stops, the pending metadata remains.
Use the authorized `DELETE /api/walkthroughs/:id` endpoint to remove pending
entries and their objects, then retry publishing. Pending entries use the same
repository authorization as complete entries. If deletion wins while an upload
is in flight, publishing cleans up the late object and returns `409`.

Hosted URLs are unlisted, not authenticated: anyone with the URL can read the
HTML, including private-repository diffs. Responses use `Cache-Control: no-store`;
deletion removes the hosted copy but cannot recall files already downloaded.
