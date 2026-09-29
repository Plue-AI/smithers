---
title: Workspace previews
description: Control access to individual workspace service ports.
---

Workspace previews are private by default. Service listings and service-action responses
provide a stable authenticated API link. Opening that link provides a short-lived
ticket for the clicking viewer. Copying a listed link never copies a credential. The gateway exchanges it for a secure, HTTP-only,
host-only session cookie before serving the guest application.

The viewer must retain repository read permission and workspace ownership or a
workspace share. The viewer and workspace owner must remain active, and the owner must retain
repository read permission. The gateway
rechecks grants at least every five seconds, including open WebSockets and
streaming responses. An authorization outage closes those connections; a check
may take up to five additional seconds before timing out.

## Public services

Only the workspace owner can read or change a service port's visibility:

```http
GET /api/repos/{owner}/{repo}/workspaces/{id}/services/{port}/visibility
PUT /api/repos/{owner}/{repo}/workspaces/{id}/services/{port}/visibility
Content-Type: application/json

{"public": true}
```

Both operations return `{"public": true}` or `{"public": false}`. Ports must be
between 1 and 65535. A workspace share, including a write share, cannot publish a
service. The setting is durable and applies only to that workspace and port.

An explicitly public service permits anonymous access, including waking its
workspace. Set `public` to `false` to revoke anonymous access. New anonymous
requests are checked before the gateway dials the workspace, with allow and deny
answers cached for at most five seconds. Open connections
are rechecked every five seconds. Suspending, deactivating, or deleting the
workspace owner also denies public access.

## Gateway composition

Configure the shared relay token and install `previewgateway.APIAuthorizer`
through `Handler.SetGrantAuthorizer`. It calls the relay-authenticated
`POST /internal/workspace-previews/authorize` endpoint. Missing authorization
configuration fails closed. Platform preview domains still require the relay
credential and cannot become public through a service visibility setting.

The `/__preview/{domain}/` path tunnel requires the relay token. Browser requests
use the preview hostname, preventing a public service from being served under
another workspace's origin.
