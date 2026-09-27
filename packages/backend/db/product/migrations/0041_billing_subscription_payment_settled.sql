-- Stripe delivers events out of order and retries them for days. A
-- subscription records its latest settled payment and an account its latest
-- refund or dispute, so a reversal suspends only payments settled before it,
-- only a payment settled after it restores the plan, and an invoice settled
-- before it grants no plan credit.
ALTER TABLE billing_subscriptions ADD COLUMN payment_settled_at timestamptz;
ALTER TABLE billing_accounts ADD COLUMN last_payment_reversed_at timestamptz;
