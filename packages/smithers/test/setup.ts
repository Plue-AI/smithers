// Backend integration fixtures select a native PostgreSQL binary. That
// selector is not CLI configuration; explicit per-test environments still
// exercise the CLI notice contract.
delete process.env.SMITHERS_POSTGRES_TEST_BIN
