# Smithers backend

This package owns Smithers' product backend, PostgreSQL schema, HTTP API and
ordinary local runtime. The app and terminal clients use the same services.
Private deployments compose the exported packages and provide deployment
adapters; product behavior stays here.

[TODOs](docs/todos.md) describes the stored TODO states, repository numbering,
creation and activity routes, and transactional projection events. The stack
service writes each TODO state and its event together. Live transport consumers
read committed projections and use snapshots when a cursor has expired.

See [package ownership](OWNERSHIP.md) for the exported boundaries and
[database ownership](db/ownership.csv) for the migration owner of every table.

Run the documentation gate from the repository root:

```sh
pnpm exec smthrs docs //packages/backend:docs
```
