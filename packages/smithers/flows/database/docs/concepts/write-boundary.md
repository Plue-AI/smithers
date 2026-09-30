---
title: "The write boundary"
description: "Why writes go through one combinator: the serialization contract consumers depend on for correctness, savepoint nesting, and the dialect-blind retry classification that decides what replays."
sidebar:
  order: 1
---

`DurableWriter.write(effect)` runs `effect` inside one transaction with
transaction-scoped retries. It is one combinator, not a decorated client:
queries still use Effect's plain `SqlClient`. The combinator exists because
several storage packages share transaction policy that has to live at exactly
one boundary, and a store above it depends on each of the three properties
below for correctness.

## Serialization is contract, not incidental

An implementation must guarantee that two concurrent `write` transactions are
mutually serialized: they may not both commit results computed from snapshots
that exclude each other's writes.

This is not isolation hygiene. The engine store closes a run-parent edge by
inserting into a table whose primary key supplies the uniqueness and then
walking the ancestor graph inside the same `write`. Its safety argument, "of
two edges that jointly close a cycle, exactly the later one fails", holds only
under serialized writers. Under a weaker level both inserts see a graph without
the other's edge, both walks find no cycle, and both commit.

SQLite satisfies the contract with its single-writer transaction lock. A
PostgreSQL implementation must run write transactions at `SERIALIZABLE` and
retry `40001`. Plain `READ COMMITTED` does not satisfy it, and adopting it
would silently reintroduce the cycle race.

The contract is executable. The package ships a conformance suite that a new
client layer has to pass, and runs it both against two `NodeDatabase`
connections over one file and against the shared in-memory `TestDatabase`
connection. See [Add a backend driver](../guides/add-a-backend.md).

Outermost writes on the shared `DurableWriter` queue for one process-local
permit, and they queue at the caller's own interruptibility. Effect SQL masks
connection acquisition, so the permit must be taken before that boundary: an
interruptible caller that is cancelled or times out while queued returns at
once, without entering SQL, running the body, or touching the holder's permit.
A caller that masked interruption keeps waiting, so a cleanup write in a
shutdown finalizer is queued rather than dropped. Share one writer across
stores using the same client. Nested writes already own the connection and
bypass the permit. The outer write holds it through all retries and releases it
when SQL finishes, before commit publication, which may itself open a new
write.

## Nesting joins, and only the outermost transaction retries

A `write` inside the client's open transaction joins it as a savepoint and does
not retry. The reason is not economy: a transient conflict dooms the enclosing
transaction's snapshot, so replaying the savepoint alone can never resolve it.
Only the outermost `write` retries, replaying the whole transaction body
verbatim against committed state.

The classification follows `cause` chains, so a nested store that has already
wrapped a savepoint failure in its own domain error still keeps the outermost
transaction replaying, as long as that domain error preserves `cause`. This is
what makes a state projection and its journal entry retryable as one unit.

Stores that redact driver diagnostics may replace the original database cause
with `new DatabaseError({ code })` in the domain error's `cause` chain. Preserve
the code returned by `fromSqlError` or the writer. This tagged, payload-free
classification retains retry provenance without SQL text or bound values.

## Process-local state follows the outer commit

Do not update a cache or notify subscribers from a transaction body. Even
after an inner `write` succeeds, its enclosing transaction can still roll back.
Use `DurableWriter.afterCommit(update)` inside the managed write to register a
short, non-failing process-local update. It runs once, after the outermost
commit, outside the SQL retry loop. Failed attempts discard their updates;
a caught savepoint failure discards only that savepoint's updates.

Store implementations should pass their captured SQL client as the second
argument: `DurableWriter.afterCommit(update, sql)`. This prevents an unrelated
database's nested transaction from publishing an update before its own
database commits.

The helper returns `false` without running the update if no managed write owns
the current transaction. This includes a raw `sql.withTransaction` or raw
savepoint. Skip optional cache publication in that case and read authoritative
state from SQL; `false` is **not** permission to publish immediately. Use the
shared writer for transactions that need commit notifications.

Publication is uninterruptible, so updates must be short and non-blocking.
This hook is not a durable outbox: a crash after SQL commits can lose local
publication. External deliveries need their own durable records and retries.

## Retry classification is domain policy

Classification is dialect blind by construction. `DurableWriter.make` accepts
any `SqlClient`, so keying only off SQLite codes made the retry silently inert
for other drivers, and a serialization failure, which is the normal outcome of
two drivers fencing one run, surfaced as a hard write error. Both vocabularies
are recognized, and a code from the wrong dialect never matches.

| Category     | Recognized as                                                                                                                                                                                                                 | Replayed |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `busy`       | `SQLITE_BUSY*`, `SQLITE_LOCKED*`, SQLSTATE `40001`, `40P01`, `55P03`, and the texts `database is locked`, `database is busy`, `could not serialize access`, `deadlock detected`, `cannot rollback - no transaction is active` | yes      |
| `io`         | `SQLITE_IOERR*` and the text `disk i/o error`                                                                                                                                                                                 | no       |
| `constraint` | Effect SQL's `ConstraintError` and `UniqueViolation`                                                                                                                                                                          | no       |
| `unknown`    | anything else                                                                                                                                                                                                                 | no       |

A unique violation is deliberately absent from the busy set. It is the
first-writer-wins signal the stores decide on, not a transient fault.

Three properties of the classifier are load bearing:

- **One function decides both answers.** The code `fromSqlError` reports and
  the decision to replay come from the same call, so the category a caller is
  told is always the category the retry budget was spent on. Split across two
  functions the two answers drift: an `SQLITE_IOERR` whose own cause carries
  `SQLITE_BUSY` gets reported as `io` and retried anyway.
- **I/O outranks a busy cause beneath it.** The write did reach the disk, so an
  I/O failure is never replayed even when a lock error hides in its cause
  chain.
- **Provenance is required.** A failure must carry an Effect `SqlError` or a
  tagged `DatabaseError` somewhere in its cause chain to qualify as retryable, so an application error
  whose message happens to quote database text is not replayed. Defects are
  held to the same rule. The defect channel is read at all because a
  transaction whose `BEGIN` or `ROLLBACK` fails reaches the caller through
  Effect's own `Effect.orDie`, which dies carrying the `SqlError` that step
  failed with.

A cause that carries several reasons is scanned in full rather than by first
match, because a write that raced two effects produces exactly that shape.

## Retries are bounded

| Option        | Default | Meaning                                     |
| ------------- | ------- | ------------------------------------------- |
| `maxAttempts` | `10`    | total attempts, including the initial write |
| `baseDelayMs` | `50`    | initial exponential backoff delay           |
| `maxDelayMs`  | `10000` | upper bound for a single retry delay        |

Jitter is applied before the cap, so `maxDelayMs` bounds the delay that is
actually slept. Any value that is not a safe integer of at least 1 clamps to 1,
so a mis-tuned option degrades into a single attempt rather than an unbounded
one. Delays use Effect's `Clock`, so a test drives them with `TestClock`
instead of waiting.

Every scheduled replay increments the `flows_db_write_retries` counter. The
attempt that finally fails past the budget is not counted: it surfaces on the
error channel instead, so a quiet system reads zero and a rising rate reads as
write contention.

## One error vocabulary

`fromSqlError` maps a structured SQL error to a `DatabaseError` carrying one of
`busy`, `constraint`, `io`, `schema`, `unsupported`, or `unknown`, and `write`
normalizes every `SqlError` in a failed cause the same way. Store logic
therefore branches on six stable codes rather than on a driver's own. `affectedRows` closes the
matching hole on the success side: SQLite drivers report `changes` and
node-postgres reports `rowCount`, so a consumer that casts to one shape reads
`undefined` on the other backend and turns a successful compare-and-swap delete
into a reported no-op.

For the failure-handling recipes, see
[Handle a failed write](../guides/handle-a-failed-write.md).
