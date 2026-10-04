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
cookie. A well-formed token that has expired or cannot be found keeps the
`unauthorized` code.

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
