/** A live SQLite writer parked inside a transaction, then after its public acknowledgment. */
import { DurableWriter, layer as writerLayer } from "@smthrs/database/DurableWriter"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import { Effect, Layer } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import type * as Statement from "effect/unstable/sql/Statement"
import { writeFileSync } from "node:fs"
import { Journal } from "../../src/Journal.ts"
import { Input, type RunId, type Seq, type SourceId, type SourceSeq } from "../../src/JournalEvent.ts"
import * as Migrations from "../../src/Migrations.ts"
import * as SqlJournal from "../../src/SqlJournal.ts"
import * as Leases from "./leases.ts"

const [filename, operation] = process.argv.slice(2)
if (filename === undefined || (operation !== "append" && operation !== "compact")) {
  throw new Error("usage: recovery-child.ts <filename> <append|compact>")
}
const runId = "process-death" as RunId
const owner = { hostId: "test", pid: process.pid, nonce: "child" }
const input = (sequence: number) =>
  new Input({
    runId,
    sourceId: "driver" as SourceId,
    sourceSeq: sequence as SourceSeq,
    eventType: `event-${sequence}`,
    payload: { sequence }
  })

// Keep the process and scoped journal fibers alive until the parent kills it.
process.stdin.resume()
const signal = (phase: string) => Effect.sync(() => process.stdout.write(`${phase}\n`))
const beforeCommit = Effect.callback<void>((resume) => {
  const continueCommit = () => resume(Effect.void)
  process.stdin.once("data", continueCommit)
  process.stdout.write("pre-commit\n")
  return Effect.sync(() => process.stdin.removeListener("data", continueCommit))
})

let armed = false
const marker = operation === "append" ? "INSERT INTO flows_journal_events" : "DELETE FROM flows_journal_events"
const barrier = Layer.merge(
  Layer.effect(
    SqlClient.SqlClient,
    Effect.map(Effect.service(SqlClient.SqlClient), (base) =>
      new Proxy(base, {
        apply(target, thisArgument, argumentsList) {
          const statement = Reflect.apply(target, thisArgument, argumentsList) as Statement.Statement<unknown>
          if (!armed || !statement.compile()[0].includes(marker)) return statement
          return statement.pipe(Effect.tap(() => beforeCommit))
        }
      }) as SqlClient.SqlClient)
  ),
  Layer.effect(DurableWriter, Effect.service(DurableWriter))
)
const database = Layer.provideMerge(
  Migrations.layer,
  Layer.provideMerge(writerLayer(), NodeDatabase.layer({ filename }))
)
const layer = SqlJournal.layer({ capacity: 64, overflow: "reject" }).pipe(
  Layer.provide(barrier),
  Layer.provideMerge(database)
)

await Effect.runPromise(Effect.scoped(
  Effect.gen(function*() {
    // This finalizer must never run in a successful process-death test.
    yield* Effect.addFinalizer(() => Effect.sync(() => writeFileSync(`${filename}.finalized`, "scope closed")))
    const journal = yield* Journal
    const sql = yield* SqlClient.SqlClient
    yield* Leases.hold(sql, runId, owner)
    yield* journal.emitDurableUnfenced(input(0))
    yield* journal.emitDurableUnfenced(input(1))
    if (operation === "append") {
      armed = true
      const receipt = yield* journal.emitDurableUnfenced(input(2))
      if (receipt._tag !== "Accepted" || receipt.seq !== 2) return yield* Effect.die("unexpected append receipt")
    } else {
      yield* journal.emitDurableUnfenced(input(2))
      yield* journal.checkpoint({ runId, seq: 0 as Seq, state: { sequence: 0 } }, owner)
      yield* journal.checkpoint({ runId, seq: 2 as Seq, state: { sequence: 2 } }, owner)
      armed = true
      const receipt = yield* journal.compact({ runId, upTo: 2 as Seq }, owner)
      if (receipt.deleted !== 2 || receipt.checkpointSeq !== 2) return yield* Effect.die("unexpected compact receipt")
    }
    yield* signal("post-ack")
    yield* Effect.never
  }).pipe(Effect.provide(layer))
))
