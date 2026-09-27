---
title: "Add a backend driver"
description: "What a new SqlClient layer must guarantee before consumers can use it, and the conformance suite it has to pass before the work counts as done."
sidebar:
  order: 6
---

`DurableWriter.make` accepts any Effect `SqlClient`, so adding a backend is
mostly a matter of supplying a client layer. What is not optional is the
guarantee that layer makes, and the suite that proves it.

## What your layer must guarantee

**Write transactions must be mutually serialized.** Two concurrent `write`
transactions may not both commit results computed from snapshots that exclude
each other's writes. Consumers depend on this for correctness, not for
isolation hygiene: the engine store's cycle detector inserts an edge and walks
the ancestor graph inside one `write`, and its safety argument holds only under
serialized writers.

- SQLite satisfies the contract with its single-writer transaction lock.
- PostgreSQL must run write transactions at `SERIALIZABLE` and retry `40001`.
  Plain `READ COMMITTED` does not satisfy the contract, and adopting it
  silently reintroduces the cycle race.

**Your errors must reach the classifier.** The retry policy recognizes SQLite
codes, the Postgres SQLSTATEs `40001`, `40P01`, and `55P03`, and the canonical
server texts for drivers that surface no code. It walks `cause` chains,
including a `SqlError`'s reason cause. A driver that buries its code where
neither a `code` property nor a `message` reaches is invisible to the retry.

**Your raw result must carry an affected-row count.** `affectedRows` reads an
own `changes` or `rowCount` property. Anything else fails with `unsupported`,
which is loud on purpose: reading zero instead would turn a successful
compare-and-swap into a reported no-op.

## Pass the conformance suite

Those guarantees are executable. The suite that checks them is
[`test/contract/DatabaseWriteContract.ts`](../../test/contract/DatabaseWriteContract.ts)
in this package's source repository, which exports `describeContract(harness)`
and runs under Vitest. A new backend layer is not done until it passes.

The suite ships with the repository rather than with the npm package, and it
imports this package's internal retry classifier, which the export map blocks.
So run it where it lives: clone
[smithersai/smithers](https://github.com/smithersai/smithers), add a harness
file for your backend beside the two that are already there, and run the
package's tests. A driver you maintain outside the repository can still read
the suite as the specification and reproduce its assertions in your own tests.

A harness builds two client and writer pairs over one freshly created store:

```ts
import { describeContract, type Harness } from "./contract/DatabaseWriteContract.ts"

const harness: Harness = {
  label: "MyBackend, two connections over one store",
  realDriver: true,
  crossConnection: true,
  run: (body) => /* build both sides, run body, tear the store down */
}

describeContract(harness)
```

Two flags say what your backend can demonstrate, and each gates a group of
assertions:

- `realDriver` enables savepoint nesting, rollback on a defect or an interrupt,
  and a byte-exact blob round trip at four megabytes and at zero length: the
  payload is written on one side and every returned byte is compared after a
  read on the other. An implementation whose isolation only exists in process
  cannot show any of them.
- `crossConnection` enables the assertion that needs two genuine connections
  over one store: a backend that owns exactly one connection has no peer to
  contend with and cannot produce the lock error.

The suite always checks that a committed write is visible to a transaction
another connection starts afterwards, that a failed write transaction rolls
back whole with no partial effect for a peer to read, and that an affected-row
count is readable for a delete that matches and one that does not.

## Two worked harnesses

Two harnesses are already written, and between them they show both settings of
each flag. Read both before you write a third.

[`test/DatabaseWriteContract.test.ts`](../../test/DatabaseWriteContract.test.ts)
runs the suite against the shared in-memory `TestDatabase` connection, where
`realDriver` and `crossConnection` are both false and serialization comes from
the client's in-process transaction mutex, a weaker mechanism that must still
satisfy the same contract.
[`test/DatabaseWriteContractIntegration.test.ts`](../../test/DatabaseWriteContractIntegration.test.ts)
runs it against two `NodeDatabase` connections over one file, where
serialization can only come from SQLite's cross-connection lock.

## Supplied backends

SQLite and PostgreSQL ship adapters and one composed migration ladder with
small dialect-specific fragments. The PostgreSQL adapter serializes writes
across pools with schema-scoped advisory locks. Its independent-pool contract
tests live in `test/PostgresDatabase.test.ts`. See
[SQLite and PostgreSQL](../concepts/sqlite-only.md).
