---
title: Run credentials
description: Credential policy for browser and REST workflow operations.
---

## Planning and run controls

A person's credentials are required for browser `Plan`, `Run`,
`Cancel`, `Signal`, `Resume`, `Steer`, and `Approval.Submit`. System-issued run
credentials and bot or service accounts receive HTTP 403 before the box receives
the operation. Repository and box access checks still apply.

`Plan` is a write: it calls the flow's planning callback and creates plan and
approval state. `List` and `Projection.Snapshot` remain available to credentials
with the required repository and box access.

REST dispatch, invoke, rerun, resume, cancel, and repository job pause require the same person
authority. This includes every cancel alias under `/api/repos/{owner}/{repo}`:

- `/workflows/runs/{id}/cancel`
- `/actions/runs/{id}/cancel`
- `/runs/{id}/cancel`

The backend's shared `RequirePerson` guard defines this policy;
`RefuseRunCredentials` applies it to REST routes. A write scope alone does not
authorize these operations.

## Admin routes

Every `/api/admin` route, and every deployment admin route mounted through
the same chain, requires three things: an admin user (`is_admin`), a token
scope of `read:admin` or `write:admin` for the route, and a person's
credential. A person's credential is a browser session or a personal access
token that classifies as `person`.

The admin user's other credentials are refused whatever scopes they carry:

| Credential | Response |
| --- | --- |
| Delegated (`via:` entry, or an install PAT) | 403, `class: "never"`, "Only a person can do this" |
| Run, machine or sync token | 403, `class: "permission"` |
| Bot or service account | 403, `class: "permission"` |
| OAuth2 access token | 403, `class: "permission"` |

`RequirePersonCredential` applies this policy after `RequireAdmin` and the
scope check. No production path mints a system-issued token with admin
scopes; the check keeps a future minter from widening admin access.
