---
title: "API authentication"
description: "How the backend handles API credentials and authentication errors."
---

## Authorization header

API requests accept a `Bearer` or `token` header with a `smithers_` personal
token or `smithers_oat_` OAuth access token. Basic authentication accepts a
token as its password. Tokens must match the issued format.

A request without an `Authorization` header continues anonymously unless its
route requires sign-in. On user-token routes, a presented header with an
unrecognized or malformed credential, including an empty value, returns HTTP
401, `WWW-Authenticate: Bearer error="invalid_token"`, and JSON
`code: "invalid_token"`. An invalid header does not fall back to a session
cookie. A well-formed token that has expired, was revoked or cannot be found
is a dead credential (below).

## Dead credentials

A dead credential is a session cookie or bearer token the server no longer
honors: unknown, expired, revoked, or held by a suspended or removed member.
It returns HTTP 401 with this body on every route that refuses it:

```json
{"code":"unauthenticated","class":"permission","fault":"user","message":"Sign in again"}
```

- A dead bearer token is refused on every user-token route.
- A dead session cookie is refused on every repository route
  (`/api/repos/{owner}/{repo}` and below, and the Git LFS batch alias)
  before the repository is resolved. The answer is byte-identical for a
  private, a missing and an unowned repository, so a dead cookie cannot probe
  which repositories exist. A request with no credential still gets 404
  there.
- On a route that requires sign-in, a dead session cookie gets the same 401.
  A request with no credential keeps `code: "unauthorized"`.
- A route that writes its own 401 `unauthenticated` (the install command
  authorizer behind `/api/members` and `/api/todos`, branch reads, TODO
  merge) says "Sign in again" for a dead session cookie and "Sign in" (or
  "Sign in to merge") for no credential.
- On a public route (health, sign-in, OAuth callbacks, logout, setup) a dead
  session cookie is ignored, so a stale cookie never blocks signing in again.
- A request carrying an SSE `ticket` is decided by the ticket gate.

Logout revokes every session cookie auth accepts. Auth looks a cookie up
by its SHA-256 digest, then as a legacy raw key unless the cookie is a
64-hex string, which is never a raw key. `POST /api/auth/logout` deletes by
the same rule, so a UUID, a 64-hex or any other opaque cookie that signed in
is dead afterward, and a stored digest presented as a cookie can neither
sign in nor sign out the session it names.

The 401 does not clear the cookie. A late 401 for an earlier request would
otherwise delete the fresh cookie a concurrent sign-in had just set.

`smithers_flowhost_` and `smithers_chatturn_` model credentials cannot
authenticate as a user. Legacy
`jjhub_` credentials are not accepted by the API.

LFS grants, Worker exchange credentials, OAuth client Basic credentials, and
build-cache read tokens are checked by their own route gates.

## SSH gateway

Use `/ssh retry-webhooks` to copy the connection line, or `smthrs ssh retry-webhooks`
to open the local SSH client. The authenticated catalog endpoint is
`GET /api/ssh?branch=retry-webhooks`. It reads branch metadata without waking a
machine. The line uses the first public origin's host name, or `localhost` when
no public origin is configured; Settings address changes apply to subsequent
reads. The CLI launches `ssh` with separate arguments and preserves its exit code.

The install listens on `127.0.0.1:2222` and adds the owner's configured bind
address on port 2222. Changing that address updates the listener without a
restart. The stable host key lives in `$STATE/ssh/`. Reaching that port from
another machine is the owner's network setup; Smithers provisions no network
or TLS service.

Branch resolution prefers `smithers/<slug>` over `scratch/*/<slug>` and refuses
ambiguous scratch matches. Full item and scratch names resolve exactly; `main`
has no machine. Plue retains its existing grant login parser.

Branch execution requires active-member key authentication, provisioned member
identity, person admission and authenticated daemon sessions. Missing providers
refuse before wake or execution. Passwords, deploy keys, legacy workspace grants
and agent forwarding are refused. Real microVM shell, SFTP, forwarding and
remote-editor acceptance remain reference-host checks; connection metadata does
not establish their availability.
