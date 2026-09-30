# Admission

`NewMetered(pool, Config{Usage, Prices})` constructs the shared quota policy
without a payment client, API key, or webhook key. Pass its returned `Policy`
unchanged to product services: the interface includes atomic consuming writes,
caller-owned transactions, and counted sandbox resumes.

The database authority is not read-only. Admission persists usage projections
and may apply an idempotent monthly credit grant.

`Usage` reports complete values. Private adapters can embed `ProductUsage` and
override the repository and private-repository counts, storage totals, sandbox
reservations, and counted resumes where private allocations contribute. A
repository whose creation is reserved but not yet published counts toward the
repository cap, and toward the private-repository cap when private. A storage allocation represented by both
pending and final deletion records must count once. Preserve deleted-repository
owner tombstones, gateway reservations, and agent/workspace deduplication.

`UsageFactory` receives the exact pool or transaction used by the shared policy.
Every query in the returned adapter must use that handle. Do not capture the
original pool, open another connection, or reduce the adapter to product-only
queries when rebinding a transaction. Factory failure blocks the consuming
write. `ProductUsage` is an explicit choice for product-only metering.

The app composition and private commerce provider are separate integration
steps. A hosted worker needs this metered policy and durable billing projections;
it does not need checkout, portal, webhook, or payment credentials. Only an
explicit trusted single-owner composition may select unlimited admission.

Run real PostgreSQL regressions against any server whose user can create
databases:

```sh
SMITHERS_TEST_DATABASE_URL=postgres://.../postgres \
  go test ./packages/backend/admission
```

The tests create and drop their own databases and apply the real product
migration lineage. They observe PostgreSQL advisory locks and execute the
consuming writes.
