/**
 * A durable engine built under a restricted capability ceiling records that
 * host ceiling with every run it admits and compares joins, polls, and
 * resumes under it (#3233), whichever context calls its service. Each case
 * restarts: a second, independently constructed engine over the same
 * database (SQLite here, PostgreSQL under the storage matrix) answers from
 * the recorded authority, not from its own host.
 */
import { describe, expect, it } from "@effect/vitest"
import { Capability, CapabilityPattern } from "@smthrs/capability/Capability"
import * as CapabilitySet from "@smthrs/capability/CapabilitySet"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { FlowEngine } from "@smthrs/engine"
import { DurableDeferred, Flow, FlowRuntime } from "@smthrs/flow"
import { Jj } from "@smthrs/kernel"
import { RunStore } from "@smthrs/run-store"
import { Cause, type Crypto, Effect, Exit, Option, Schema, Scope } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as EngineStore from "../src/EngineStore.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { executeUntilParked } from "./ExecuteUntilParked.ts"
import { opaqueHandlerBody } from "./fixtures/OpaqueHandlerBody.ts"
import * as PersistentDatabase from "./fixtures/PersistentDatabase.ts"
import { withCrypto } from "./Sha256.ts"

const secret = new Capability({ action: "fs:read", resource: "secret/key" })
const readSource = [new CapabilityPattern({ action: "fs:read", resource: "src/**" })]
const sourceGroup = [{ action: "fs:read", resource: "src/**" }]

const jj = Jj.make({
  snapshot: () => Effect.succeed({ commitId: "host" as never, changeId: "host" as never }),
  restore: () => Effect.void,
  diff: () => Effect.succeed(""),
  workspaceAdd: () => Effect.void,
  workspaceForget: () => Effect.void,
  status: () => Effect.succeed("")
})

const conflictOf = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? exit.cause.reasons.find(Cause.isDieReason)?.defect : undefined

const sees = Effect.map(
  CapabilitySet.current,
  (set) => CapabilitySet.allows(set, secret) ? "secret contents" : "denied"
)

const Reader = Flow.make("host-ceiling/reader", {
  payload: {},
  success: Schema.String,
  body: opaqueHandlerBody
})
const gate = DurableDeferred.make("host-ceiling/gate", { success: Schema.String })
const Gated = Flow.make("host-ceiling/gated", {
  payload: {},
  success: Schema.String,
  body: opaqueHandlerBody
})

/**
 * Runs `body` with `start`, which closes the previous engine and builds the
 * next one over the same database, under `host` when given — a restart.
 */
const withRestarts = <A, E>(
  body: (
    start: (host?: ReadonlyArray<CapabilityPattern>) => Effect.Effect<FlowRuntime.FlowRuntime["Service"]>
  ) => Effect.Effect<A, E, Crypto.Crypto | RunStore.RunStore | SqlClient.SqlClient>
) => {
  const filename = PersistentDatabase.filename(":memory:")
  return Effect.gen(function*() {
    const context = yield* Effect.context<never>()
    let previous: Scope.Closeable | undefined
    const start = (host?: ReadonlyArray<CapabilityPattern>) =>
      Effect.gen(function*() {
        if (previous !== undefined) yield* Scope.close(previous, Exit.void)
        const scope = yield* Scope.make()
        previous = scope
        const make = EngineStore.make({
          owner: { hostId: "host-ceiling" },
          journalSource: "host-ceiling",
          isAlive: () => Effect.succeed(false)
        })
        const engine = yield* Scope.provide(host === undefined ? make : CapabilitySet.attenuate(host)(make), scope)
        yield* engine.register(Reader, () => sees).pipe(Scope.provide(scope))
        yield* engine.register(Gated, () => Effect.andThen(DurableDeferred.await(gate), sees)).pipe(
          Scope.provide(scope)
        )
        return engine
      }).pipe(Effect.provideContext(context as never)) as Effect.Effect<FlowRuntime.FlowRuntime["Service"]>
    return yield* body(start).pipe(
      Effect.ensuring(Effect.suspend(() => previous === undefined ? Effect.void : Scope.close(previous, Exit.void)))
    )
  }).pipe(
    Effect.provideService(Jj.Jj, jj),
    Effect.provide(StepBoundary.layerTest()),
    Effect.provide(TestStores.layerAt(filename)),
    withCrypto,
    Effect.ensuring(Effect.promise(() => PersistentDatabase.remove(filename)))
  )
}

const recorded = (executionId: string) =>
  Effect.gen(function*() {
    const store = yield* RunStore.RunStore
    const row = yield* store.get(executionId)
    return (JSON.parse(row.stateJson) as { capabilityCeilings?: unknown }).capabilityCeilings
  })

const run = (engine: FlowRuntime.FlowRuntime["Service"], executionId: string) =>
  Reader.execute({}, { executionId }).pipe(Effect.provideService(FlowRuntime.FlowRuntime, engine))

describe("durable admission under the engine's host ceiling", () => {
  it.effect("records the host ceiling for an unrestricted caller and keeps it across a restart", () =>
    withRestarts((start) =>
      Effect.gen(function*() {
        const narrow = yield* start(readSource)
        // The caller is unrestricted; the engine's host is not.
        expect(yield* run(narrow, "admitted-narrow")).toBe("denied")
        expect(yield* recorded("admitted-narrow")).toEqual([sourceGroup])

        // A parked run records the same, and a broader engine that recovers
        // it after a restart drives it under the recorded authority.
        yield* executeUntilParked(narrow, Gated, { executionId: "parked-narrow", payload: {}, discard: true })
        expect(yield* recorded("parked-narrow")).toEqual([sourceGroup])
        const broad = yield* start()
        expect(yield* run(broad, "admitted-narrow")).toBe("denied")
        yield* broad.deferredDone(gate, {
          flowName: Gated._tag,
          executionId: "parked-narrow",
          deferredName: gate.name,
          exit: Exit.succeed("opened") as never
        })
        const store = yield* RunStore.RunStore
        yield* TestDatabase.until(Effect.map(store.get("parked-narrow"), (row) => row.status === "completed"))
        expect(
          yield* Gated.execute({}, { executionId: "parked-narrow" }).pipe(
            Effect.provideService(FlowRuntime.FlowRuntime, broad)
          )
        ).toBe("denied")
        expect(yield* recorded("parked-narrow")).toEqual([sourceGroup])
      })
    ))

  it.effect("refuses a narrower replacement engine's join, poll, and resume of a broader run", () =>
    withRestarts((start) =>
      Effect.gen(function*() {
        const broad = yield* start()
        expect(yield* run(broad, "admitted-broad")).toBe("secret contents")
        yield* executeUntilParked(broad, Gated, { executionId: "parked-broad", payload: {}, discard: true })

        // Every call below comes from an unrestricted caller: only the
        // replacement engine's host is narrower.
        const narrow = yield* start(readSource)
        const joined = yield* Effect.exit(run(narrow, "admitted-broad"))
        expect(conflictOf(joined)).toBeInstanceOf(FlowEngine.ExecutionIdentityConflict)
        expect(conflictOf(joined)).toMatchObject({ executionId: "admitted-broad", field: "capabilities" })
        const polled = yield* Effect.exit(narrow.poll(Reader, "admitted-broad"))
        expect(conflictOf(polled)).toMatchObject({ executionId: "admitted-broad", field: "capabilities" })
        const resumed = yield* Effect.exit(narrow.resume(Gated, "parked-broad"))
        expect(conflictOf(resumed)).toMatchObject({ executionId: "parked-broad", field: "capabilities" })
        const store = yield* RunStore.RunStore
        expect((yield* store.get("parked-broad")).status).toBe("suspended")

        // A wake the narrower engine drives runs under its host as well as
        // the recorded authority.
        yield* narrow.deferredDone(gate, {
          flowName: Gated._tag,
          executionId: "parked-broad",
          deferredName: gate.name,
          exit: Exit.succeed("opened") as never
        })
        yield* TestDatabase.until(Effect.map(store.get("parked-broad"), (row) => row.status === "completed"))

        // The broader run's own host still answers both after another restart.
        const again = yield* start()
        expect(yield* run(again, "admitted-broad")).toBe("secret contents")
        expect(Option.isSome(yield* again.poll(Reader, "admitted-broad"))).toBe(true)
        expect(
          yield* Gated.execute({}, { executionId: "parked-broad" }).pipe(
            Effect.provideService(FlowRuntime.FlowRuntime, again)
          )
        ).toBe("denied")
      })
    ))

  it.effect("refuses a restricted host a legacy row that recorded no ceiling", () =>
    withRestarts((start) =>
      Effect.gen(function*() {
        const broad = yield* start()
        expect(yield* run(broad, "legacy")).toBe("secret contents")
        // A row written before admission recorded authority.
        const sql = yield* SqlClient.SqlClient
        const rows = yield* sql<{ state_json: string }>`SELECT state_json FROM flows_runs WHERE run_id = ${"legacy"}`
        const { capabilityCeilings: _, ...legacy } = JSON.parse(rows[0]!.state_json) as Record<string, unknown>
        yield* sql`UPDATE flows_runs SET state_json = ${JSON.stringify(legacy)} WHERE run_id = ${"legacy"}`
        expect(yield* recorded("legacy")).toBeUndefined()

        const narrow = yield* start(readSource)
        expect(conflictOf(yield* Effect.exit(run(narrow, "legacy")))).toMatchObject({ field: "capabilities" })
        expect(conflictOf(yield* Effect.exit(narrow.poll(Reader, "legacy")))).toMatchObject({ field: "capabilities" })
        expect(conflictOf(yield* Effect.exit(narrow.resume(Reader, "legacy")))).toMatchObject({
          field: "capabilities"
        })
      })
    ))
})
