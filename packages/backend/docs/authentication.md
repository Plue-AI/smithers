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
- On a public route (health, sign-in, OAuth callbacks, logout, setup) a dead
  session cookie is ignored, so a stale cookie never blocks signing in again.
- A request carrying an SSE `ticket` is decided by the ticket gate.

The 401 does not clear the cookie. A late 401 for an earlier request would
otherwise delete the fresh cookie a concurrent sign-in had just set.

`smithers_flowhost_` and `smithers_chatturn_` model credentials cannot
authenticate as a user. Legacy
`jjhub_` credentials are not accepted by the API.

LFS grants, Worker exchange credentials, OAuth client Basic credentials, and
build-cache read tokens are checked by their own route gates.

## SSH gateway

The SSH configuration defaults to `127.0.0.1:2222`. An explicit `ssh.addr`
override remains available to deployments. Network access is configured by the
owner; Smithers provisions no network or TLS service.

Branch logins are an unmounted integration boundary. A composition selecting
`BranchLogins` must supply both an active-member/branch identity resolver and
a daemon-backed workspace bridge. Missing providers refuse authentication
before wake or execution. Branch logins accept member public keys only and
reject passwords, deploy keys and legacy workspace grants. Every new session
rechecks its member and branch identity.

Branch resolution prefers `smithers/<slug>` over `scratch/*/<slug>` and reports
ambiguous scratch matches on stderr. Full item and scratch names resolve
exactly; `main` has no machine. Plue retains its existing grant login parser.
The install listener, admitted daemon sessions, forwarding and remote-editor
acceptance are not enabled by this boundary.
