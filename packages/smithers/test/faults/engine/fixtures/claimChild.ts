import * as DatabaseMigrations from "@smthrs/database/Migrations"
/**
 * A control plane with an identity of its own, for the claim-fence race.
 *
 * Two control runtimes reaching for one abandoned run is a cross-process event, so each
 * host here is a real process with its own `SqlControlRuntime`, its own
 * connection to the shared control database, and its own `OwnerId`. The
 * identity is on the command line because that is the thing under test: the
 * fence admits one claimant and refuses the other, and it can only tell them
 * apart if they are not the same owner.
 *
 * Two roles:
 *
 * - `setup` plans, approves, launches, and then parks a run, leaving it
 *   suspended and unowned — the state a swept run is in — and prints
 *   `RUN=<runId>`.
 * - `resume <runId> <barrier>` waits for the barrier file to appear, then claims
 *   through the shared runtime, and prints `CLAIM=won:<claimed status>` or `CLAIM=lost:<tag>`. The
 *   barrier is what makes it a race: both processes have paid their startup
 *   cost and are sitting on the same instant before either one touches the row.
 *   Public operator resume delegates another host's park and does not claim it.
 *   Claimed or not, the racer then makes the fenced write a driver makes —
 *   with the claim's fence if it holds one, and otherwise with the fence its
 *   own identity would carry — and prints `WRITE=ok:<status>` or
 *   `WRITE=lost:<tag>`, after the `FENCE=<json>` it presented. A loser that never wrote would prove nothing about the
 *   fence.
 * - `inspect <runId>` prints the persisted `STATUS=<status>` and
 *   `OWNER=<json>`.
 *
 * Usage:
 *   node claimChild.ts <controlDbFile> <hostId> <pid> setup
 *   node claimChild.ts <controlDbFile> <hostId> <pid> resume <runId> <barrier>
 *   node claimChild.ts <controlDbFile> <hostId> <pid> inspect <runId>
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { Control, ControlExecutor, ControlLive, ControlRuntime, SqlControlRuntime } from "@smthrs/control"
import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import { Migrations as JournalMigrations, SqlJournal } from "@smthrs/journal"
import { NotificationQueue } from "@smthrs/notifications"
import { Registry } from "@smthrs/registry"
import { Migrations as RunStoreMigrations, RunStore } from "@smthrs/run-store"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import { existsSync } from "node:fs"

const [filename, hostId, pidArg, role, runIdArg, barrier] = process.argv.slice(2)
if (filename === undefined || hostId === undefined || pidArg === undefined || role === undefined) {
  process.stderr.write("usage: claimChild.ts <file> <hostId> <pid> <setup|resume> [runId] [barrier]\n")
  process.exit(2)
}

const owner = { hostId, pid: Number(pidArg), nonce: `${hostId}-boot` }

const database = Layer.provideMerge(DurableWriter.layer(), NodeDatabase.layer({ filename }))
const migrated = Layer.provideMerge(
  DatabaseMigrations.layer([JournalMigrations.set, RunStoreMigrations.set]),
  database
)
const stores = Layer.mergeAll(
  SqlJournal.layer({ capacity: 1024, overflow: "reject" }),
  RunStore.layer
).pipe(Layer.provideMerge(migrated))

const stack = ControlLive.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      SqlControlRuntime.layer({ owner }).pipe(Layer.orDie),
      NotificationQueue.layer,
      ControlExecutor.layer(ControlExecutor.makeNoop()),
      Registry.layerNoop()
    )
  ),
  Layer.provideMerge(Layer.merge(stores, NodeCrypto.layer))
)

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))

const setup = Effect.gen(function*() {
  const control = yield* Control.Control
  const card = yield* control.plan({ flowId: "system/test", input: { case: "case06-fence" } })
  yield* control.approve({
    target: { _tag: "Plan", planId: card.planId, digest: card.digest, envelope: card.envelope },
    scope: card.approval.scope,
    idempotencyKey: `approve:${card.planId}`
  })
  const receipt = yield* control.run({
    _tag: "Plan",
    planId: card.planId,
    digest: card.digest,
    envelope: card.envelope,
    idempotencyKey: `run:${card.planId}`
  })
  if (receipt._tag !== "Accepted" || receipt.runId === undefined) {
    return yield* Effect.die(new Error(`expected an accepted run, got ${receipt._tag}`))
  }
  // Parked and unowned: the state a run is left in when its driver is gone.
  //
  // `Control.pause` is gone at rc.0 (the release policy), so the
  // park is written through the runtime the way a driver writes its own: claim
  // the run, then move the row to `parked`, which `SqlControlRuntime`'s
  // `storeStatus` projects onto the store's `suspended`. The `flows_runs`
  // CHECK constraint clears the owner columns for every status but `running`,
  // so that one write both parks the run and releases it, which is the state a
  // swept run is in.
  //
  // The setup-only no-op executor releases pending admission; take a real
  // runtime claim before writing the fenced park.
  const runtime = yield* ControlRuntime.ControlRuntime
  yield* runtime.resume(receipt.runId)
  const fence = yield* runtime.claimFence(receipt.runId)
  yield* runtime.writeStatus(receipt.runId, fence, "parked")
  return receipt.runId
})

const resume = (runId: string) =>
  Effect.gen(function*() {
    const runtime = yield* ControlRuntime.ControlRuntime
    return yield* runtime.resume(runId)
  })

const tagOf = (cause: Cause.Cause<unknown>): string => {
  const failure = Cause.squash(cause) as { readonly _tag?: string }
  return failure._tag ?? String(failure)
}

const race = (runId: string) =>
  Effect.gen(function*() {
    const claim = yield* Effect.exit(resume(runId))
    const runtime = yield* ControlRuntime.ControlRuntime
    const held = yield* Effect.exit(runtime.claimFence(runId))
    const fence = Exit.isSuccess(held) ? held.value : JSON.stringify(owner)
    const write = yield* Effect.exit(runtime.writeStatus(runId, fence, "running"))
    return {
      fence,
      claim: Exit.isSuccess(claim) ? `won:${claim.value.status}` : `lost:${tagOf(claim.cause)}`,
      write: Exit.isSuccess(write) ? `ok:${write.value.status}` : `lost:${tagOf(write.cause)}`
    }
  })

const inspect = (runId: string) =>
  Effect.gen(function*() {
    const row = yield* (yield* RunStore.RunStore).get(runId)
    return { status: row.status, owner: row.owner }
  })

if (role === "setup") {
  const exit = await Effect.runPromise(
    setup.pipe(Effect.provide(stack), Effect.scoped, Effect.exit)
  )
  if (Exit.isFailure(exit)) {
    process.stderr.write(`${String(exit.cause)}\n`)
    process.exit(1)
  }
  process.stdout.write(`RUN=${exit.value}\n`)
  process.exit(0)
}

if (role === "inspect" && runIdArg !== undefined) {
  const exit = await Effect.runPromise(
    inspect(runIdArg).pipe(Effect.provide(stack), Effect.scoped, Effect.exit)
  )
  if (Exit.isFailure(exit)) {
    process.stderr.write(`${String(exit.cause)}\n`)
    process.exit(1)
  }
  process.stdout.write(`STATUS=${exit.value.status}\nOWNER=${JSON.stringify(exit.value.owner)}\n`)
  process.exit(0)
}

if (role !== "resume" || runIdArg === undefined || barrier === undefined) {
  process.stderr.write("usage: claimChild.ts <file> <hostId> <pid> resume <runId> <barrier>\n")
  process.exit(2)
}

// Hold the same scoped connection and control runtime through readiness and
// the barrier. Closing it at READY and rebuilding after go would race startup.
const outcome = await Effect.runPromise(
  Effect.gen(function*() {
    yield* Control.Control
    yield* Effect.sync(() => process.stdout.write("READY\n"))
    for (let waited = 0; !existsSync(barrier); waited += 10) {
      if (waited > 60_000) return yield* Effect.die(new Error("claimChild: the barrier never appeared"))
      yield* Effect.promise(() => sleep(10))
    }
    return yield* race(runIdArg)
  }).pipe(Effect.provide(stack), Effect.scoped, Effect.exit)
)
if (Exit.isFailure(outcome)) {
  process.stderr.write(`${String(outcome.cause)}
`)
  process.exit(1)
}
process.stdout.write(`CLAIM=${outcome.value.claim}
FENCE=${outcome.value.fence}
WRITE=${outcome.value.write}
`)
process.exit(0)
