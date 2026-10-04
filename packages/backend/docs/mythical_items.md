---
title: "TODO steering and amendments"
description: "Transactional signal admission and the production activation boundary."
---

## Transactional admission

`flowdispatch.Service.SignalInTx` admits a signal through the existing jobs
store in the caller's PostgreSQL transaction. It shares validation, scope
binding, authorization context, reconciliation policy and request identity with
`Signal`. The caller commits or rolls back the product event, revision and
signal intent together. Admission performs no runtime resolution or delivery;
the existing jobs worker delivers committed intents and reconciles lost replies.

The dispatcher records intent; it does not authorize a TODO mutation, lock a
merge fence, settle a wait, append a revision or start an attempt. Those operations
must use the pinned TODO service and bound catalog authorization before admission.

## Activation boundary

TODO Message notifications currently refuse `notification_unavailable` before
queue admission. The pinned `todo` composition and its closure, notification
lineage and guest-host delivery contracts must pass their production checks
before replacing this refusal. Existing `coding/request` delivery is retained.

The public `POST /api/todos/{n} {steer}`, `PATCH /api/todos/{n}` and corresponding
catalog commands are not enabled by this dispatcher change. Their activation
requires T-STK-01/02/05/12, T-FLW-11, T-MCH-14, T-INS-02, T-FLW-01, T-SEC-01,
T-CAT-01 and T-ACC-03. Delegation also requires T-ACC-04; delegated Amend requires
T-APP-04. No branch-built artifact or repository code executes as root or on the
host through this admission seam.
