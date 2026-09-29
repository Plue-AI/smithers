/**
 * One `CacheStore.put` against a real file-backed database, in a process that
 * either commits it or dies inside the write transaction.
 *
 * `node test/fixtures/crash-put.ts <database> <commit|crash>`
 *
 * The crash is taken from inside `DurableWriter.write`, after the effect that
 * inserts the ledger row and the head row has produced its outcome and before
 * the transaction commits. That is the window `CacheStoreCrash.test.ts` asks
 * about: exactly the moment at which a half-written cache entry would become
 * durable if the two inserts were not one transaction.
 */
import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { writeSync } from "node:fs"
import * as CacheStoreLive from "../../src/CacheStore.ts"
import * as Migrations from "../../src/Migrations.ts"

const [filename, mode] = process.argv.slice(2)
if (filename === undefined || (mode !== "commit" && mode !== "crash")) {
  throw new Error("usage: crash-put.ts <database> <commit|crash>")
}
if (mode === "crash") process.on("exit", () => writeSync(1, "unexpected clean exit\n"))

const entry: CacheStoreLive.CacheEntry = {
  keyDigest: "crash-digest",
  result: { output: "recorded" },
  meta: { source: "fixture" },
  createdAtMs: 11,
  recordedRunId: "run-1",
  recordedEventSeq: 5
}

const database = Layer.provideMerge(DurableWriter.layer(), NodeDatabase.layer({ filename }))

/** The real writer, with the process death spliced inside the transaction. */
const dying = (real: DurableWriter.Service): DurableWriter.Service => ({
  write: (effect) =>
    real.write(
      Effect.tap(effect, () =>
        Effect.sync(() => {
          writeSync(1, "transaction written\n")
          process.kill(process.pid, "SIGKILL")
        }))
    )
})

await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function*() {
      yield* Migrations.run
      const real = yield* DurableWriter.DurableWriter
      const store = yield* CacheStoreLive.make.pipe(
        Effect.provideService(DurableWriter.DurableWriter, mode === "crash" ? dying(real) : real)
      )
      const outcome = yield* store.put(entry)
      console.log(outcome._tag)
    }).pipe(Effect.provide(database))
  )
)
