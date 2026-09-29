---
title: Email rate limits
description: Shared recipient budgets for Smithers email delivery.
---

## Recipient budgets

`SMITHERS_EMAIL_RATE_LIMIT_PER_RECIPIENT_PER_HR` limits email to each recipient
across every API replica using the same PostgreSQL database. Addresses are
trimmed and compared without case; duplicates in one message spend one slot.
A zero limit disables the recipient cap.

The first admitted email starts a one-hour window using the database clock.
Restarting an API replica does not reset the budget. A message with several
recipients reserves all their slots together; if any recipient is at the cap,
none of the slots or the local per-second allowance are spent. A delivery
failure after admission still spends the reserved slots, preventing repeated
provider failures from bypassing the cap.

Database failures refuse delivery. Recipient admission has a five-second timeout;
a blocked recipient does not hold up unrelated sends. Blank recipients are rejected. There is no in-memory recipient fallback.
Expired records are removed in batches during subsequent admissions.
`SMITHERS_EMAIL_RATE_LIMIT_PER_SECOND` remains a per-process provider throttle.

## Rollout

Apply product migration 0072 before starting the updated API. All replicas must
run the updated backend to enforce the shared cap; old binaries keep separate
budgets. Existing in-memory counts cannot be recovered, so the first rollout
starts fresh hourly budgets. Normal restarts thereafter preserve them.
