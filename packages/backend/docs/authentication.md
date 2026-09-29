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

`smithers_flowhost_` model credentials cannot authenticate as a user. Legacy
`jjhub_` credentials are not accepted by the API.

LFS grants, Worker exchange credentials, OAuth client Basic credentials, and
build-cache read tokens are checked by their own route gates.
