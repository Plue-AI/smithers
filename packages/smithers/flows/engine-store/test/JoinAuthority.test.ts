/**
 * The durable driver admits a join only when the caller's capability ceiling
 * covers the authority the run row persisted (#2852), the same
 * `FlowEngine.joinable` rule the in-memory engine applies. A join answers the
 * result that authority produced, so a narrower caller never reads it.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { describe, expect, it } from "@effect/vitest"
import { Capability, CapabilityPattern } from "@smthrs/capability/Capability"
import * as CapabilitySet from "@smthrs/capability/CapabilitySet"
import { FlowEngine } from "@smthrs/engine"
import { Action, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import { Jj } from "@smthrs/kernel"
import { RunStore } from "@smthrs/run-store"
import { Cause, Effect, Exit, Layer, Schema } from "effect"
import * as EngineStore from "../src/EngineStore.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"

const secret = new Capability({ action: "fs:read", resource: "secret/key" })
const readSource = [new CapabilityPattern({ action: "fs:read", resource: "src/**" })]

const jj = Layer.succeed(
  Jj.Jj,
  Jj.make({
    snapshot: () => Effect.succeed({ commitId: "join" as never, changeId: "join" as never }),
    restore: () => Effect.void,
    diff: () => Effect.succeed(""),
    workspaceAdd: () => Effect.void,
    workspaceForget: () => Effect.void,
    status: () => Effect.succeed("")
  })
)

const conflictOf = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? exit.cause.reasons.find(Cause.isDieReason)?.defect : undefined

describe("durable joins under a capability ceiling", () => {
  it.effect("refuses a narrower caller and admits the same or a wider one", () =>
    Effect.gen(function*() {
      let runs = 0
      const Read = Action.make("durable-join-authority/read", { payload: {}, success: Schema.String })
      const flow = Flow.make("durable-join-authority/flow", {
        payload: { id: Schema.String },
        success: Schema.String,
        body: () => Read.call({})
      })
      const engine = yield* EngineStore.make({
        owner: { hostId: "durable-join-authority" },
        journalSource: "durable-join-authority",
        isAlive: () => Effect.succeed(false)
      })
      const layer = Layer.mergeAll(
        Read.toLayer(() =>
          Effect.map(CapabilitySet.current, (set) => {
            runs++
            return CapabilitySet.allows(set, secret) ? "secret contents" : "denied"
          })
        ),
        Interpreter.layer(flow)
      ).pipe(
        Layer.provideMerge(Action.layerImplementations),
        Layer.provideMerge(Layer.succeed(FlowRuntime.FlowRuntime, engine))
      )
      yield* Effect.gen(function*() {
        expect(yield* flow.execute({ id: "a" }, { executionId: "wide" })).toBe("secret contents")
        for (const discard of [false, true]) {
          const exit = yield* Effect.exit(
            CapabilitySet.attenuate(readSource)(flow.execute({ id: "a" }, { executionId: "wide", discard }))
          )
          expect(conflictOf(exit)).toBeInstanceOf(FlowEngine.ExecutionIdentityConflict)
          expect(conflictOf(exit)).toMatchObject({ executionId: "wide", field: "capabilities" })
        }
        // The refused joins left the admitted row and its result untouched.
        const row = yield* RunStore.RunStore.pipe(Effect.flatMap((store) => store.get("wide")))
        expect(row.status).toBe("completed")
        expect(yield* flow.execute({ id: "a" }, { executionId: "wide" })).toBe("secret contents")

        expect(yield* CapabilitySet.attenuate(readSource)(flow.execute({ id: "b" }, { executionId: "narrow" })))
          .toBe("denied")
        expect(yield* CapabilitySet.attenuate(readSource)(flow.execute({ id: "b" }, { executionId: "narrow" })))
          .toBe("denied")
        expect(yield* flow.execute({ id: "b" }, { executionId: "narrow" })).toBe("denied")
        expect(runs).toBe(2)
      }).pipe(Effect.provide(layer))
    }).pipe(
      Effect.scoped,
      Effect.provide(jj),
      Effect.provide(StepBoundary.layerTest()),
      Effect.provide(TestStores.layerAt(":memory:")),
      Effect.provide(NodeCrypto.layer)
    ))
})
