---
title: "SQLite and PostgreSQL"
description: "Choose a local SQLite file or an injected PostgreSQL client for the same durable stores."
sidebar:
  order: 3
---

Smithers uses Effect SQL's `SqlClient` and one `DurableWriter` for both SQLite
and PostgreSQL. Journal, run and attempt state, plans, engine projections,
step cache, time travel, control, memory, scores, triggers, and integration
records use the same services and migration identities.

## Configuration

SQLite is the local default. `NodeDatabase.layer({ filename })` and
`BunDatabase.layer({ filename })` select PostgreSQL when given a
`postgres://` or `postgresql://` connection string, or when
`SMITHERS_POSTGRES_URL` is set. A generic `DATABASE_URL` selects PostgreSQL
only with `SMITHERS_BACKEND=postgres`, which requires one of the two. Set
`SMITHERS_BACKEND=sqlite` to keep filename opens on SQLite despite
`SMITHERS_POSTGRES_URL`. An explicit PostgreSQL URL still selects PostgreSQL.
`:memory:` and `file:` URI opens always stay on SQLite.

Install the optional adapter alongside the database package:

```sh
pnpm add @effect/sql-pg@4.0.0-rc.115
```

Direct injection makes the schema explicit:

```ts
import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as PostgresDatabase from "@smthrs/database/postgres/PostgresDatabase"
import { Layer } from "effect"

const database = Layer.provideMerge(
  DurableWriter.layer(),
  PostgresDatabase.layer({
    url: process.env.SMITHERS_POSTGRES_URL!,
    schema: "my_workspace_engine"
  })
)
```

Provide this layer to the existing composed migrations and stores. Run the
composed migration ladder before constructing services; do not launch separate
package migrations concurrently. No PostgreSQL-specific store is needed.

The adapter creates the schema if absent. Its database role needs permission
to create the schema, tables, indexes, and trigger functions. The tested server
is PostgreSQL 18 with UTF-8 encoding. Connection credentials stay in host
configuration; do not put them into flow payloads or journals.

## Store identity

Direct injection defaults to `smithers_flows`. An explicit connection-string
open can set `?schema=my_schema`. Environment-selected opens preserve the
filename's store identity: without a configured prefix, the schema is
`smithers_` plus a SHA-256 digest of the absolute filename. Moving that path
therefore selects another schema.

For stable deployment identity, set `SMITHERS_POSTGRES_SCHEMA`. The adapter
appends the sanitized filename basename, so `control.db` and `engine.db`
remain separate stores. The directory is not part of the name, so two
workspaces with the same prefix and a `smithers.db` each share one schema. Use a
distinct prefix per workspace. PostgreSQL stores
SQL records; artifacts, native process state, and workspaces still need durable
host storage.

The self-hosted Go backend accepts `SMITHERS_DATABASE_URL` or its
`DATABASE_URL` fallback, with the prefixed variable taking precedence. That
credential stays in the backend: flow hosts share their workspace with
repository commands, so they never receive it. By default a host keeps its
stores on SQLite in the workspace state directory.

Set `SMITHERS_FLOW_JOURNAL_POSTGRES_URL` to keep each workspace coding host's
control and engine stores on the backend's PostgreSQL server instead. The value
is the server address as the host reaches it (for a microVM guest, a routable
host rather than loopback); its user, password and database are replaced, and
its query may carry only `sslmode`, `sslrootcert`, `connect_timeout` and
`application_name`.
Before a host starts, the backend creates or repairs that workspace's own login
role and a database it owns, named `smithers_flows_<workspace>`. The role has
no server privileges and a connection limit of 32, and only it may connect to
its database. The host receives only that role's `SMITHERS_POSTGRES_URL` and the
`flows` schema prefix, so its stores are `flows_control_db` and
`flows_engine_db`. Every backend replica derives the same password from the
webhook secret encryption key, so a live host keeps reconnecting across backend
restarts. Only the SCRAM verifier reaches the server.

A journal lives as long as its workspace. Stopping or suspending a workspace,
including when its client lease lapses, keeps the journal. Deleting the
workspace drops its database, ending any open session, and then its role.
This includes a delete after a lease lapse. The workspace cleaner also drops
the journal of a workspace whose row is gone or tombstoned, such as after a
repository deletion or a failed drop. Each journal role is tagged with the
backend's database name. The sweep lists only roles with that tag and names
that match `smithers_flows_<workspace>` exactly, so it never drops another
backend's journals on a shared server.

The backend role needs `CREATEROLE` and `CREATEDB`, or superuser. It revokes
`CONNECT` on its own database from `PUBLIC` at startup. If it does not own that
database, revoke the grant yourself; until then every host start is refused. A
repository can read or damage only its own journals, as it could with the
SQLite files beside it. Artifacts and native process state stay in the state
directory. Turning the setting on or off changes each host's identity, like a
catalog change. A host already running under the other setting is refused
until it stops, and its replacement starts with an empty journal.

## Transactions and SQL behavior

SQLite retains its WAL/open guards and bounded busy retries. PostgreSQL uses
READ COMMITTED transactions with a transaction-scoped advisory lock keyed by
schema. The lock is acquired before domain reads, serializing durable writes
across pools and processes. Nested writes use savepoints. Existing lease
compare-and-swap, owner fencing, and retry classification remain in the shared
stores. A custom injected SQL client must provide this serialization contract;
a bare PostgreSQL READ COMMITTED client is insufficient.

This deliberately permits one durable writer per schema, matching the current
SQLite contract. Different schemas can write concurrently. A larger connection
pool does not increase writer throughput within one schema. No throughput claim
is made by the conformance suite.

Integer-valued columns use PostgreSQL `NUMERIC` with integer/range checks where
the SQLite schema has those checks; this rejects fractional writes rather than
rounding them. Reads retain JavaScript numbers within the safe range. Binary
vectors use `BYTEA`. JSON remains encoded text with backend-specific validation
and extraction. PostgreSQL identity columns replace implicit SQLite insertion
ordinals where reads require them.

Memory keyword recall uses SQLite FTS5 or PostgreSQL `tsvector`/GIN with the
`simple` configuration and `websearch_to_tsquery`. Ranking and advanced query
syntax are backend-specific; ordinary keyword recall shares the memory API.

## Recovery and tests

Recovery reconstructs the same stores and migration ladder over the retained
file or schema. Local SQLite backup bundles (`VACUUM INTO`) remain a SQLite
maintenance format. PostgreSQL operators must back up and restore the schema
with PostgreSQL tooling and retain the associated artifact objects and host
state. A SQLite bundle is not a PostgreSQL export/import format.

Each owning package runs the matrix through `pnpm coverage`,
`pnpm test:matrix`, and its factory test target; plain `pnpm test` runs SQLite only. It runs the existing suite once
on SQLite and once on a real PostgreSQL server. Set `SMITHERS_TEST_PG_URL` to a
scratch database, or let the runner create and remove a temporary local cluster.
`PG_BIN` selects the PostgreSQL 17+ binaries; a factory target inherits only
`PATH`, so `initdb` and `pg_ctl` must be on it there (CI declares
`CiToolchain.Postgres`). Tests use isolated schemas and remove
them when their scopes close. Native file-format and historical SQLite-only
corruption fixtures stay on SQLite; PostgreSQL-specific adapter tests exercise
independent pools and exact storage types. Coverage from both runs is merged
and checked against each package's unchanged thresholds (100% in ten packages,
with existing measured floors in memory and integrations). Process tests exercise
PostgreSQL hard-kill recovery and Node/Bun replay; native history resolves
workspaces, forks, and rewind receipts through the same injected stores.

The SQLite file guard still refuses a populated pre-1.0 file without
`flows_migrations`. PostgreSQL selection does not convert such a file; choose a
fresh schema or an explicitly managed migration of application data.
