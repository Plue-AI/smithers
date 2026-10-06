# Landing

Reserve new tables in `packages/backend/db/ownership.csv` at Ready:
`table,product,planned:T-XXX-00;owner:smithers-owner`. Keep target ownership
(product/private/retired) in its existing column. Planned rows do not describe
installed tables. Set `SMITHERS_MIGRATION_TICKET` to the implementing ticket;
the migration gate refuses another ticket's reservation.

Fetch the landing branch, then run `node scripts/renumber-migration.mjs <file>`
for each unlanded product migration. The helper requires sqlc v1.30.0 from
`PACKAGE.ts`, assigns max(origin/main)+1, updates the registry, converts implemented reservations,
and regenerates sqlc. It refuses files already on `origin/main` before writes,
including renamed copies, and refuses when unlanded status cannot be established.
Never change landed migration filenames, numbers or bytes.

Run after renumbering and generation, without database credentials:

```sh
go test -run 'TestMigrationGate|TestMigrationRegistry' ./packages/backend/db/product/
```

`node scripts/commit.mjs --push --test '<required check>'` runs that mandatory
gate, sqlc drift, and the mandatory five-target drift set before either Git or jj publication. Missing or
failed gates refuse publication, including with `--no-test`. The bootstrap
helper publishes main; this authorized wave uses the lane's explicit Git
fetch/rebase/push workflow to frontrun after the same checks.

Execute repository tests and generators as unprivileged machine users, without
live database or publication credentials. Machine dispatch remains blocked until
the approved T-SEC-01 R1–R3, T-MCH-10 R4 and applicable T-FLW-01 R5 receipts
and installed main-pinned runtime are available. Branch bytes never run at root.
