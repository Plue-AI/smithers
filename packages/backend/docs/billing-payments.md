---
title: "Refunds and disputed payments"
description: "How refunded and disputed subscription payments affect paid access and model credit."
---

Refunds and newly opened payment disputes mark live subscriptions as `past_due`
and suspend paid access. Unspent plan credit is forfeited; credit already spent
is not charged again, and signup credit remains available.

Repeated webhook deliveries do not deduct credit twice or restart the past-due
period. An active subscription update or billing refresh cannot undo a payment
reversal. Cancellation still ends the subscription.

A later settled subscription payment restores access according to the current
payment-provider status and grants credit once per invoice. An older payment
received late cannot restore access or credit after its reversal. Likewise, a
reversal older than the latest settled payment does not suspend that newer
payment's access or forfeit its credit.
