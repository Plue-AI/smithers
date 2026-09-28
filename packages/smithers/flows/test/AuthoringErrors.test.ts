import { describe, expect, it } from "@effect/vitest"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as Context from "effect/Context"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import { createHash, webcrypto } from "node:crypto"
import {
  Action,
  EngineStore as EngineStorePackage,
  Flow,
  FlowRuntime,
  Interpreter,
  Journal as JournalPackage,
  Kernel,
  Plan as PlanPackage,
  PlanStore as PlanStorePackage,
  RunStore as RunStorePackage,
  StepCache
} from "../src/index.ts"

const { DurableEngineState, EngineStore, Migrations, OwnerIdentity, StepBoundary } = EngineStorePackage
const { SqlJournal } = JournalPackage
const { Jj } = Kernel
const { Node } = PlanPackage
const { PlanStore } = PlanStorePackage
const { AttemptStore, RunStore } = RunStorePackage
const { CacheStore } = StepCache

const hostCrypto: Layer.Layer<Crypto.Crypto> = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => webcrypto.getRandomValues(new Uint8Array(size)),
    digest: (algorithm, data) =>
      Effect.succeed(
        new Uint8Array(createHash(algorithm.replace("-", "").toLowerCase()).update(data).digest())
      )
  })
)

const jj = Jj.make({
  snapshot: () => Effect.succeed({ commitId: "authoring-errors" as never, changeId: "authoring-errors" as never }),
  restore: () => Effect.void,
  diff: () => Effect.succeed(""),
  workspaceAdd: () => Effect.void,
  workspaceForget: () => Effect.void,
  status: () => Effect.succeed("")
})

const services = Layer.mergeAll(
  SqlJournal.layer({ capacity: 128, overflow: "reject" }),
  RunStore.layer,
  AttemptStore.layer,
  CacheStore.layer,
  PlanStore.layer,
  DurableEngineState.layer
).pipe(
  Layer.provideMerge(Layer.provideMerge(Migrations.layer, TestDatabase.layer)),
  Layer.merge(OwnerIdentity.layer),
  Layer.merge(StepBoundary.layerTest()),
  Layer.merge(Layer.succeed(Jj.Jj, jj))
)

type DurableServices = Layer.Success<typeof services>

const durable = <A, E>(body: Effect.Effect<A, E, DurableServices | Crypto.Crypto | Scope.Scope>) =>
  Effect.scoped(body.pipe(Effect.provide(services), Effect.provide(hostCrypto)))

/** A flow registration provides nothing; its cast erases only schema inputs. */
type Registration = Layer.Layer<never, never, Action.Implementations | FlowRuntime.FlowRuntime>

const incarnation = (options: {
  readonly flows: ReadonlyArray<Flow.Any>
}) =>
  Effect.gen(function*() {
    const engine = yield* EngineStore.make({
      owner: { hostId: "authoring-errors" },
      journalSource: "authoring-errors",
      isAlive: () => Effect.succeed(false)
    })
    const wiring = options.flows.map((flow) => Interpreter.layer(flow as never) as Registration)
      .reduce<Registration>((left, right) => Layer.merge(left, right), Layer.empty).pipe(
      Layer.provideMerge(Action.layerImplementations),
      Layer.provideMerge(Layer.succeed(FlowRuntime.FlowRuntime, engine))
    )
    return { engine, wiring }
  })

describe("authoring input errors", () => {
  it.effect("surfaces a typed InterpreterError naming an action whose implementation layer is missing", () =>
    Effect.gen(function*() {
      const MissingAction = Action.make("authoring/missing-action", {
        payload: { value: Schema.Number },
        success: Schema.Number
      })
      const MissingFlow = Flow.make("authoring/missing-flow", {
        payload: { value: Schema.Number },
        success: Schema.Number,
        error: Interpreter.InterpreterError,
        body: ({ value }) => MissingAction.call({ value })
      })

      const observed = yield* durable(Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        const { wiring } = yield* incarnation({ flows: [MissingFlow] })
        const error = yield* MissingFlow.execute(
          { value: 1 },
          { executionId: "missing-action-run" }
        ).pipe(
          Effect.provideService(MissingAction.requirement, {
            name: MissingAction.name,
            action: () => Effect.die("compile-time requirement only")
          }),
          Effect.provide(wiring),
          Effect.flip
        )
        return { error, row: yield* store.get("missing-action-run") }
      }))

      expect(observed.error).toMatchObject({
        _tag: "@smthrs/flow/InterpreterError",
        code: "unresolved_action",
        flow: "authoring/missing-flow"
      })
      expect(observed.error).toBeInstanceOf(Interpreter.InterpreterError)
      const interpreterError = observed.error as Interpreter.InterpreterError
      expect(interpreterError.node).toContain("root.flow")
      expect(observed.error.message).toContain("Action \"authoring/missing-action\" has no implementation")
      expect(observed.error.message).toContain("Action.layerImplementations")
      expect(observed.row.status).toBe("failed")
    }))

  it.effect("fails an invalid execute payload with a typed SchemaError and field path", () =>
    Effect.gen(function*() {
      const Checked = Flow.make("authoring/schema-checked", {
        payload: { count: Schema.Number },
        success: Schema.Number,
        body: ({ count }) => Node.succeed(count)
      })

      const exit = yield* durable(Effect.gen(function*() {
        const { wiring } = yield* incarnation({ flows: [Checked] })
        return yield* Checked.execute(
          { count: "not-a-number" } as unknown as { readonly count: number },
          { executionId: "invalid-payload-run" }
        ).pipe(Effect.provide(wiring), Effect.exit)
      }))

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const reason = exit.cause.reasons[0]
        expect(reason?._tag).toBe("Fail")
        const error = reason?._tag === "Fail" ? reason.error : undefined
        expect(error).toMatchObject({ _tag: "SchemaError" })
        expect(String(error)).toContain("count")
      }
    }))

  it.each([0, -1])("rejects maxRounds: %i as a synchronous authoring RangeError", (maxRounds) => {
    expect(() =>
      Flow.make(`authoring/max-rounds-${maxRounds}`, {
        payload: {},
        maxRounds,
        body: () => Node.succeed(undefined)
      })
    ).toThrowError(
      new RangeError(`Flow.make: "authoring/max-rounds-${maxRounds}" maxRounds must be a positive safe integer`)
    )
  })

  it.effect("lets a later registration for the same flow tag replace the prior handler", () =>
    Effect.gen(function*() {
      const First = Flow.make("authoring/duplicate-tag", {
        payload: {},
        success: Schema.String,
        body: () => Node.succeed("first-body")
      })
      const Second = Flow.make("authoring/duplicate-tag", {
        payload: {},
        success: Schema.String,
        body: () => Node.succeed("second-body")
      })

      const observed = yield* durable(Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        const { engine } = yield* incarnation({ flows: [] })
        yield* engine.register(First, () => Effect.succeed("first-handler"))
        yield* engine.register(Second, () => Effect.succeed("second-handler"))
        const value = yield* engine.execute(First, {
          executionId: "duplicate-tag-run",
          payload: {}
        })
        return { row: yield* store.get("duplicate-tag-run"), value }
      }))

      expect(observed.value).toBe("second-handler")
      expect(observed.row.status).toBe("completed")
    }))

  it.effect("fails poll on an unknown execution id with typed not-found", () =>
    Effect.gen(function*() {
      const Pollable = Flow.make("authoring/pollable", {
        payload: {},
        success: Schema.String,
        body: () => Node.succeed("done")
      })

      const exit = yield* durable(Effect.gen(function*() {
        const { wiring } = yield* incarnation({ flows: [Pollable] })
        return yield* Pollable.poll("unknown-execution").pipe(
          Effect.provide(wiring),
          Effect.exit
        )
      }))

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const reason = exit.cause.reasons[0]
        expect(reason?._tag).toBe("Fail")
        const error = reason?._tag === "Fail" ? reason.error : undefined
        expect(error).toMatchObject({
          _tag: "@smthrs/flow/FlowExecutionNotFound",
          executionId: "unknown-execution"
        })
        expect(String(error)).toContain("unknown-execution")
      }
    }))
})

/** A service no harness layer provides. */
class Unprovided extends Context.Service<Unprovided, { readonly value: string }>()("test/AuthoringErrors/Unprovided") {}

/** Never called; tsc checks it (#2347). */
const unprovidedServiceProbe = () => {
  // @ts-expect-error the durable stores do not provide Unprovided
  durable(Effect.map(Unprovided, (service) => service.value))
  durable(Effect.succeed(1))
}

describe("unprovided service compile probe", () => {
  it("rejects a body that needs a service the durable harness does not provide", () => {
    // The assertion is the `@ts-expect-error` directive above.
    expect(unprovidedServiceProbe).toBeTypeOf("function")
  })
})
