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
