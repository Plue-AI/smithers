import { Action, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import { Journal } from "@smthrs/journal"
import { Jj } from "@smthrs/kernel"
import { Node } from "@smthrs/plan"
import { RunStore } from "@smthrs/run-store"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { TestClock } from "effect/testing"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as EngineStore from "../src/EngineStore.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { withCrypto } from "./Sha256.ts"

const Recover = Action.make("PendingAdmissionRecovery/Recover", { payload: {}, success: Schema.String })
const Child = Flow.make("PendingAdmissionRecovery/Child", {
  payload: {},
  success: Schema.String,
  body: () => Recover.call({})
})
// These flows perform no filesystem effects; deterministic Jj only supplies
// the unused host port. Durable recovery and sweep tests use real SQLite.
const jj = Layer.succeed(
  Jj.Jj,
  Jj.make({
    snapshot: () => Effect.succeed({ commitId: "pending" as never, changeId: "pending" as never }),
    restore: () => Effect.void,
    diff: () => Effect.succeed(""),
    workspaceAdd: () => Effect.void,
    workspaceForget: () => Effect.void,
    status: () => Effect.succeed("")
  })
)

it.each([false, true])(
  "recovers a detached admission without resubmission (initially refused: %s)",
  async (initiallyRefused) => {
    const directory = await mkdtemp(join(tmpdir(), "pending-admission-"))
    const filename = join(directory, "engine.sqlite")
    try {
      // Admission envelope before claim/activation: hard crashes cannot run finalizers.
      await Effect.runPromise(withCrypto(Effect.scoped(
        Effect.gen(function*() {
          const runs = yield* RunStore.RunStore
          yield* runs.create("dead-parent", JSON.stringify({ version: 1, flowName: "dead-parent", payload: {} }))
          yield* runs.create(
            "pending-child",
            JSON.stringify({
              version: 1,
              flowName: Child._tag,
              payload: {},
              parentExecutionId: "dead-parent",
              onParentExit: "detach",
              capabilityCeilings: [[]]
            }),
            { parentRunId: "dead-parent" }
          )
          yield* (yield* DurableEngineState.DurableEngineState).recordRunParent("pending-child", "dead-parent")
          expect((yield* runs.get("pending-child")).status).toBe("pending")
        }).pipe(Effect.provide(TestStores.layerAt(filename)), Effect.provide(TestClock.layer()))
      )))
      let calls = 0
      let allowed = !initiallyRefused
      const host = EngineStore.layer({
        owner: { hostId: "replacement" },
        journalSource: "pending-recovery",
        canExecute: () => Effect.succeed(allowed)
      }).pipe(
        Layer.provideMerge(Layer.mergeAll(TestStores.layerAt(filename), StepBoundary.layerTest(), jj))
      )
      const registration = Interpreter.layer(Child).pipe(
        Layer.provideMerge(Recover.toLayer(() =>
          Effect.sync(() => {
            calls++
            return "recovered"
          })
        )),
        Layer.provideMerge(Action.layerImplementations),
        Layer.provideMerge(host)
      )
      await Effect.runPromise(withCrypto(Effect.scoped(
        Effect.gen(function*() {
          const runtime = yield* FlowRuntime.FlowRuntime
          if (initiallyRefused) {
            expect((yield* (yield* RunStore.RunStore).get("pending-child")).status).toBe("pending")
            expect(calls).toBe(0)
            allowed = true
          }
          yield* TestClock.adjust("31 seconds")
          let result = yield* runtime.poll(Child, "pending-child")
          for (let turn = 0; turn < 300 && Option.isNone(result); turn++) {
            yield* Effect.yieldNow
            result = yield* runtime.poll(Child, "pending-child")
          }
          expect(Option.isSome(result)).toBe(true)
          expect((yield* (yield* RunStore.RunStore).get("pending-child")).status).toBe("completed")
          expect(calls).toBe(1)
        }).pipe(Effect.provide(registration), Effect.provide(TestClock.layer()))
      )))
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
)

it("reopens a real ensure admission and its created/spawn receipts without resubmission", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pending-real-admission-"))
  const filename = join(directory, "engine.sqlite")
  const Launch = Action.make("PendingAdmissionRecovery/Launch", {
    payload: {},
    success: Schema.String,
    error: Schema.Unknown
  })
  const Parent = Flow.make("PendingAdmissionRecovery/Parent", {
    payload: {},
    success: Schema.String,
    error: Schema.Unknown,
    body: Node.capture({ action: Launch.name }, () => Launch.call({}))
  })
  let calls = 0
  const host = (first: boolean) =>
    EngineStore.layer({
      owner: { hostId: first ? "first-admission-host" : "replacement-admission-host" },
      journalSource: "actual-admission-recovery",
      canExecute: (row) => Effect.succeed(!first || row.runId === "pending-real-parent")
    }).pipe(Layer.provideMerge(Layer.mergeAll(TestStores.layerAt(filename), StepBoundary.layerTest(), jj)))
  const implementation = Recover.toLayer(() =>
    Effect.sync(() => {
      calls++
      return "recovered"
    })
  )
  try {
    const first = Effect.gen(function*() {
      const id = yield* Parent.execute({}, { executionId: "pending-real-parent" })
      const runs = yield* RunStore.RunStore
      expect((yield* runs.get(id)).status).toBe("pending")
      expect((yield* Child.poll(id))._tag).toBe("None")
      expect(calls).toBe(0)
      const journal = yield* Journal.Journal
      yield* journal.flush
      const created = (yield* journal.entries({ runId: id as never, limit: 100 })).entries
      expect(created.some((entry) =>
        entry.eventType === "flows.engine.run-decision" &&
        (entry.payload as { decision?: string }).decision === "created"
      )).toBe(true)
      const spawned = (yield* journal.entries({ runId: "pending-real-parent" as never, limit: 100 })).entries
        .map((entry) =>
          entry.payload as {
            effect?: { kind?: string; status?: string; output?: { childRunId?: string; attached?: boolean } }
          }
        )
        .find((payload) => payload.effect?.kind === "flows/engine-store/child-spawn")
      expect(spawned?.effect?.status).toBe("succeeded")
      expect(spawned?.effect?.output).toEqual({ childRunId: id, flowName: Child._tag, attached: false })
      return id
    })
    const firstStack = Layer.mergeAll(
      Interpreter.layer(Parent),
      Interpreter.layer(Child),
      Launch.toLayer(() => Child.ensure({}, { key: "worker" })).pipe(Layer.provideMerge(implementation))
    ).pipe(Layer.provideMerge(Action.layerImplementations), Layer.provideMerge(host(true)))
    const id = await Effect.runPromise(
      withCrypto(Effect.scoped(first.pipe(Effect.provide(firstStack), Effect.provide(TestClock.layer()))))
    )
    const second = Effect.gen(function*() {
      yield* TestClock.adjust("31 seconds")
      let result = yield* Child.poll(id)
      for (let turn = 0; turn < 300 && Option.isNone(result); turn++) {
        yield* Effect.yieldNow
        result = yield* Child.poll(id)
      }
      expect(Option.getOrThrow(result)._tag).toBe("Complete")
      expect((yield* (yield* RunStore.RunStore).get(id)).status).toBe("completed")
      expect(calls).toBe(1)
    })
    const secondStack = Layer.mergeAll(Interpreter.layer(Child), implementation).pipe(
      Layer.provideMerge(Action.layerImplementations),
      Layer.provideMerge(host(false))
    )
    await Effect.runPromise(
      withCrypto(Effect.scoped(second.pipe(Effect.provide(secondStack), Effect.provide(TestClock.layer()))))
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
