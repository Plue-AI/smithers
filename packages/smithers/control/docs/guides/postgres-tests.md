# PostgreSQL inventory tests

The default unit suite needs no PostgreSQL server. Set `SMITHERS_TEST_PG_URL` to run `test/SqlControlRuntimePostgres.test.ts` against a dedicated test database.

`//packages/smithers/control:postgresInventory` runs the same assertions on Linux with the `adapterPostgresDatabase` service and loopback networking. It checks filtered inventory pagination, duplicate and absent IDs, empty filters, large ID sets, and time boundaries.
