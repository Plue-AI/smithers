---
title: "Test memory"
description: "Run the package tests against SQLite and the PostgreSQL full-text search regression."
sidebar:
  order: 6
---

From the package directory, run `npx vitest run --maxWorkers=2`. The default
unit suite uses SQLite and needs no PostgreSQL installation or service. The
PostgreSQL FTS regression skips when `SMITHERS_TEST_PG_URL` is unset.

Run `smthrs test '//packages/smithers/agent/memory:postgresFts'` on Linux for the
regression against its declared PostgreSQL service. To use an existing test
server, set `SMITHERS_TEST_PG_URL` and run from the package directory:

```sh
npx vitest run --maxWorkers=2 test/PostgresFts.test.ts --coverage.enabled=false
```

The regression creates a unique test schema and drops it when the Effect scope
closes. The database user needs permission to create and drop schemas. It checks
fact and note backfill, namespace isolation, phrase and AND matching, bounded
results, legacy fold migration, and search index restoration.

The unit coverage floors remain unchanged. PostgreSQL-only FTS statements and
functions are excluded from unit coverage and exercised by the `postgresFts`
target. The existing `test:matrix` command exercises the broader adapter matrix.
