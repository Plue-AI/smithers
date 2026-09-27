# Exact credits

Platform credit is held per owner (`user` or `org`) in integer USD nanos
(1 USD = 1,000,000,000 nanos). Every spendable amount is a grant with an
optional expiry. Product migration 0027 creates the ledger and carries the
former integer-cent balances into it.

- A platform-funded model call goes through `Ledger.ExecuteModelCall` or
  `ExecutePricedModelCall`. It reserves a bound, calls the provider once per
  key, and settles once. A failed call is released. A call whose usage is
  unknown is charged its bound. Usage above the bound becomes debt, and debt
  blocks new reservations until a grant repays it.
- Reservations draw from the soonest-expiring grants first. Every writer locks
  the account row first, so concurrent reservations cannot overspend.
- A reservation left open longer than `AbandonAfter` (default 6 h) is
  charged its bound when the account next reserves.
- `Ledger.SignupGrantNanos` is the deployment's one-time signup credit.
  `EnsureAccount` grants it under `signup_grant` in the transaction that
  creates a user's account, once per login identity (`user:<id>` and each
  linked OAuth login, recorded in `credit_signup_identities`). An
  organization, an existing account or an imported account never receives
  it.
- Plan credit is one grant per paid invoice (`invoice:<id>`), expiring at the
  end of the period the invoice pays for. `Ledger.Forfeit` ends an owner's
  live grants by key prefix on a refund, a dispute or a lapsed subscription.
  The payment webhook grants and forfeits through `Ledger.InTransaction`, so
  credit commits with the billing state it follows from; a billing read never
  forfeits. Every ledger that can create a payer's account (commerce via
  `commerce.Config.SignupCreditGrantCents`, and any model proxy resolving the
  payer) must carry the same amount.
- A self-hosted operator funds platform-model calls with
  `smithers-backend credits grant -owner user:NAME -usd AMOUNT -key KEY`
  (`Ledger.OperatorCommand`); a grant is applied once per key.
- `credit_events` is append-only. Per grant, its deltas sum to the available
  amount. Per account, they sum to the debt.

## Legacy archive

`cmd/legacyimport` reads one JSON archive and never contacts a legacy source:

```json
{
  "exported_at": "2026-09-25T12:00:00Z",
  "canonical_rows": [
    {"kind": "users", "source_id": "identity:account:7", "fields": {"id": 7, "username": "seven", "lower_username": "seven"}}
  ],
  "billing_accounts": [
    {"source_id": "<durable object id>", "owner_type": "user", "owner_id": 7,
     "balance_nanos": 1500000000,
     "grants": [{"source_key": "stripe:pi_1", "remaining_nanos": 1500000000, "expires_at": null}],
     "source": {"verbatim": "legacy records"}}
  ]
}
```

- `balance_nanos` must equal the grants still live at `exported_at`. A
  negative balance is carried as debt.
- A missing legacy ledger is `"grants": []`. A balance with no grant detail
  becomes one non-expiring `opening` grant, counted in `synthetic_openings`.
- An account with no owner, or whose owner does not exist, is sealed. It
  cannot spend. `-attach SOURCE -owner user:ID` moves it to its owner later;
  an owner the archive already names cannot be replaced.
- `canonical_rows` go directly into allowlisted product tables in archive
  order. The exporter supplies credentials already encrypted for the product.
  A row that differs from an existing row fails.

Every source is committed with a SHA-256 receipt. A replay is a no-op, and a
changed record fails. `-verify` reads every row back and compares it with the
archive. A database takes one cutover archive: `-verify` fails if it holds a
receipt the archive lacks.
