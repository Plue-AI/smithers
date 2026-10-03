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

## Install sign-in

People sign in to an install with GitHub only. There is no password and no
local account route.

- **Claim.** While the install has no owner, every start prints
  `{"setup_urls":["http://localhost:4000/setup?token=<token>","<stored-origin>/setup?token=<token>"]}` and stores only the token's
  SHA-256 digest. The first GitHub sign-in that carries the token
  (`GET /api/auth/github?setup_token=<token>`) becomes the owner, on any
  listener. Setup claims the owner before the owner picks the repository, so
  the claim checks push access only when a repository is already recorded.
  The claim deletes the token; a restart before the claim prints a new one. A
  sign-in without the current token is refused with `setup_token_invalid`.
- **Later sign-ins.** The person must be on the roster (`members`, not
  removed) and have push access or higher to the install's repository, read
  live from GitHub with an installation token. Refusals: `not_a_member`,
  `needs_github_access`, and `github_unavailable` when GitHub does not answer
  (the sign-in fails closed). Until setup records the repository only the
  owner signs in; anyone else gets `install_repository_unset`.
- **Every request.** Sessions, tokens, SSE tickets and Git over HTTP pass one
  member check; a credential whose user is not a member gets 403
  `not_a_member`.
