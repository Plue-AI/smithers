import { describe, expect, it } from "@effect/vitest"
import { Flow, FlowRuntime } from "@smthrs/flow"
import { Jj } from "@smthrs/kernel"
import { Ownership, RunStore } from "@smthrs/run-store"
import { Deferred, Duration, Effect, Exit, Schema } from "effect"
import { TestClock } from "effect/testing"
import * as EngineStore from "../src/EngineStore.ts"
import { AttemptEvidenceQuarantined } from "../src/Errors.ts"
import * as ExecutionSnapshot from "../src/ExecutionSnapshot.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { fixture, onFile } from "./ExecutionSnapshotFixture.ts"
import { opaqueHandlerBody } from "./fixtures/OpaqueHandlerBody.ts"
import { withCrypto } from "./Sha256.ts"

const CancelFlow = Flow.make("SnapshotAcknowledgement", {
  payload: {},
  success: Schema.String,
  body: opaqueHandlerBody
})
const jj = Jj.make({
  snapshot: () => Effect.succeed({ commitId: "acknowledgement" as never, changeId: "acknowledgement" as never }),
  restore: () => Effect.void,
  diff: () => Effect.succeed(""),
  workspaceAdd: () => Effect.void,
  workspaceForget: () => Effect.void,
  status: () => Effect.succeed("")
})

describe("driver cancellation acknowledgement", () => {
  it.effect("observes a driver-quarantined run durably without inventing cancellation acknowledgement", () =>
    fixture((file) =>
      Effect.gen(function*() {
        yield* withCrypto(
          Effect.scoped(
            Effect.gen(function*() {
              const engine = (yield* EngineStore.make({
                owner: { hostId: "quarantine-snapshot" },
                journalSource: "quarantine-snapshot"
              })) as FlowRuntime.FlowRuntime["Service"]
              yield* engine.register(CancelFlow, () =>
                Effect.die(
                  new AttemptEvidenceQuarantined({
                    code: "attempt_evidence_quarantined",
                    keyDigest: "quarantine-key",
                    attempt: 1,
                    path: "output",
                    recordedDigest: "before",
                    measuredDigest: "after"
                  })
                ))
              yield* engine.execute(CancelFlow, { executionId: "quarantined", payload: {}, discard: true })
            }).pipe(Effect.provide(StepBoundary.layerTest()), Effect.provideService(Jj.Jj, jj))
          )
            .pipe(Effect.provide(TestStores.layerAt(file)))
        )
        yield* onFile(
          file,
          Effect.gen(function*() {
            const reader = yield* ExecutionSnapshot.make()
            expect((yield* reader.read(["quarantined"])).snapshots[0]).toMatchObject({
              status: "suspended",
              waiting: { kind: "other", reason: "quarantine", token: "quarantine-key" },
              cancellation: { requestedAtMs: null, acknowledgement: null }
            })
          })
        )
      })
    ))

  it.effect("acknowledges under the live owner before user cleanup finishes, and survives reopening", () =>
    fixture((file) =>
      Effect.gen(function*() {
        yield* withCrypto(
          Effect.scoped(
            Effect.gen(function*() {
              const store = yield* RunStore.RunStore
              const reader = yield* ExecutionSnapshot.make()
              const engine = (yield* EngineStore.make({
                owner: { hostId: "ack-driver" },
                journalSource: "ack-driver"
              })) as FlowRuntime.FlowRuntime["Service"]
              const entered = yield* Deferred.make<void>()
              const cleaning = yield* Deferred.make<void>()
              const finishCleanup = yield* Deferred.make<void>()
              yield* engine.register(CancelFlow, () =>
                Effect.gen(function*() {
                  yield* Deferred.succeed(entered, undefined)
                  return yield* Effect.never.pipe(
                    Effect.ensuring(
                      Deferred.succeed(cleaning, undefined).pipe(Effect.andThen(Deferred.await(finishCleanup)))
                    )
                  )
                }))
              const caller = yield* Effect.forkChild(
                Effect.exit(
                  engine.execute(CancelFlow, { executionId: "cancel", payload: {} })
                ),
                { startImmediately: true }
              )
              yield* Deferred.await(entered)
              const owner = (yield* store.get("cancel")).owner
              expect(owner).not.toBeNull()
              yield* onFile(
                file,
                Effect.gen(function*() {
                  const peer = yield* RunStore.make
                  yield* peer.requestCancel("cancel", 2)
                })
              )
              expect((yield* reader.read(["cancel"])).snapshots[0]).toMatchObject({
                cancellation: { requestedAtMs: 2, acknowledgement: null }
              })
              yield* TestClock.adjust(Duration.toMillis(Ownership.heartbeatInterval))
              yield* Deferred.await(cleaning)
              const observed = (yield* reader.read(["cancel"])).snapshots[0]!
              expect(observed).toMatchObject({
                status: "running",
                cancellation: { requestedAtMs: 2, acknowledgement: { owner } }
              })
              yield* Deferred.succeed(finishCleanup, undefined)
              for (let tick = 0; tick < 20 && caller.pollUnsafe() === undefined; tick++) {
                yield* TestClock.adjust(Duration.toMillis(Ownership.heartbeatInterval))
                yield* Effect.yieldNow
              }
              expect(caller.pollUnsafe()).toBeDefined()
              expect((yield* reader.read(["cancel"])).snapshots[0]).toMatchObject({
                status: "cancelled",
                cancellation: { acknowledgement: { owner } }
              })
            }).pipe(
              Effect.provide(StepBoundary.layerTest()),
              Effect.provideService(Jj.Jj, jj)
            )
          ).pipe(Effect.provide(TestStores.layerAt(file)), Effect.provide(TestClock.layer()))
        )
        yield* onFile(
          file,
          Effect.gen(function*() {
            const reader = yield* ExecutionSnapshot.make()
            const snapshot = (yield* reader.read(["cancel"])).snapshots[0]!
            expect(snapshot).toMatchObject({
              status: "cancelled",
              cancellation: { acknowledgement: { owner: { hostId: "ack-driver" } } }
            })
          })
        )
      })
    ))
})
