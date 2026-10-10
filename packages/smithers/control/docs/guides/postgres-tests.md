# PostgreSQL inventory tests

The default unit suite needs no PostgreSQL server. Set `SMITHERS_TEST_PG_URL` to run `test/SqlControlRuntimePostgres.test.ts` against a dedicated test database.

`//packages/smithers/control:postgresInventory` runs the same assertions on Linux with the `adapterPostgresDatabase` service and loopback networking. It checks filtered inventory pagination, duplicate and absent IDs, empty filters, large ID sets, and time boundaries.

The package `test` target runs the suite twice, on SQLite and on a real PostgreSQL server, and merges the coverage before it checks the 100% floors. The PostgreSQL pass runs this file, so the PostgreSQL-only inventory filter counts toward coverage. Run the same matrix from the package directory with `pnpm run test:matrix`.
