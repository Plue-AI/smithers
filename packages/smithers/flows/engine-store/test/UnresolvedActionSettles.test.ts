/**
 * N-06 on the real SQLite engine-store: a plan action with no implementation
 * settles its run instead of stranding the row.
 *
 * The interpreter's refusal is a wiring defect, not a body outcome, so no flow
 * declares it. That makes the channel the refusal travels on load-bearing
 * here in a way no in-memory engine can show: the durable driver encodes the
 * settled exit through `Flow.Result({ success, error: flow.errorSchema })`
 * (`internal/RunDriver.ts`, `encodeResult`), and a flow declaring no error
 * encodes its error channel as `Schema.Never`. A refusal delivered as a typed
 * FAILURE therefore cannot be encoded at all: `encodeResult` dies with
 * `Expected never at ["exit"]["cause"]["failures"][0]["error"]`, the run row
 * stays `running` and owned with no `finishedAtMs`, and the stale sweep
 * re-drives it into the same defect forever. The refusal is a DEFECT carrying
 * the `InterpreterError` itself, which `Schema.Defect` encodes, so the run
 * settles `failed` and the persisted cause still names the action.
 *
 * `packages/smithers/flows/engine/test/DurableLogEngine.ts` cannot pin this: it keeps
 * `Flow.Result` objects in a `Map` and never runs the flow codec.
 */
import { describe, expect, it } from "@effect/vitest"
import { Action, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import { Jj } from "@smthrs/kernel"
import { RunStore } from "@smthrs/run-store"
import * as Cause from "effect/Cause"
import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as EngineStore from "../src/EngineStore.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { withCrypto } from "./Sha256.ts"

const jj = Jj.make({
  snapshot: () => Effect.succeed({ commitId: "unresolved-action" as never, changeId: "unresolved-action" as never }),
  restore: () => Effect.void,
  diff: () => Effect.succeed(""),
  workspaceAdd: () => Effect.void,
  workspaceForget: () => Effect.void,
  status: () => Effect.succeed("")
})

type Services =
  | Layer.Success<ReturnType<typeof TestStores.layerAt>>
  | StepBoundary.Service
  | Jj.Jj
  | Crypto.Crypto

const provide = <A, E>(effect: Effect.Effect<A, E, Services>) =>
  withCrypto(
    effect.pipe(
      Effect.provideService(Jj.Jj, jj),
      Effect.provide(StepBoundary.layerTest()),
      Effect.provide(TestStores.layerAt(":memory:"))
    )
  )

const makeEngine = EngineStore.make({
  owner: { hostId: "unresolved-action-host" },
  journalSource: "unresolved-action-test",
  isAlive: () => Effect.succeed(false)
})

const Unimplemented = Action.make("UnresolvedActionSettles/Unimplemented", {
  payload: { id: Schema.String },
  success: Schema.Void
})

/** A flow declaring NO error: its durable error channel is `Schema.Never`. */
const Undeclared = Flow.make("UnresolvedActionSettles/undeclared", {
  payload: { id: Schema.String },
  success: Schema.Void,
  body: (payload) => Unimplemented.call(payload)
})

/** A flow whose declared error the refusal is still not an instance of. */
const Declared = Flow.make("UnresolvedActionSettles/declared", {
  payload: { id: Schema.String },
  success: Schema.Void,
  error: Schema.String,
  body: (payload) => Unimplemented.call(payload)
})

/**
 * Drives `flow` on one durable engine WITHOUT the action's implementation
 * layer, which is the composition mistake under test, and answers the settled
 * row beside what the second drive of the same execution did.
 */
interface Drivable {
  readonly execute: (
    payload: { readonly id: string },
    options: { readonly executionId: string }
  ) => Effect.Effect<unknown, unknown, FlowRuntime.FlowRuntime>
  readonly poll: (executionId: string) => Effect.Effect<Option.Option<any>, unknown, FlowRuntime.FlowRuntime>
}

const drive = <Error extends Schema.Top & { readonly DecodingServices: never; readonly EncodingServices: never }>(
  flow: Flow.Flow<string, typeof Undeclared.payloadSchema, typeof Schema.Void, Error, any>,
  executionId: string
) =>
  provide(Effect.scoped(Effect.gen(function*() {
    const driven = flow as unknown as Drivable
    const store = yield* RunStore.RunStore
    const engine = (yield* makeEngine) as FlowRuntime.FlowRuntime["Service"]
    const wired = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.provide(
          Interpreter.layer(flow).pipe(
            Layer.provideMerge(Action.layerImplementations),
            Layer.provideMerge(Layer.succeed(FlowRuntime.FlowRuntime, engine as never))
          )
        ),
        // A stranded row is a hang, not a failure: bound it so the case
        // reports the defect rather than the suite's own timeout.
        Effect.timeout("20 seconds")
      )
    // Awaited, not discarded: the caller's own channel is where the refusal
    // has to stay legible.
    const first = yield* Effect.exit(
      wired(driven.execute({ id: "x" }, { executionId }))
    )
    const row = yield* store.get(executionId)
    const second = yield* Effect.exit(
      wired(driven.execute({ id: "x" }, { executionId }))
    )
    const polled = yield* Effect.orDie(wired(driven.poll(executionId)))
    return { first, row, second, polled }
  })))

/** The defect the driver settled the run with, as the operator reads it. */
const settledDefect = (polled: Option.Option<any>): string => {
  if (Option.isNone(polled) || polled.value._tag !== "Complete") return "<no completion>"
  const exit = polled.value.exit
  return Exit.isFailure(exit) ? String(Cause.squash(exit.cause)) : "<succeeded>"
}

describe("a plan action with no implementation, on the durable SQLite engine", () => {
  it.live("settles the run failed and names the action, for a flow declaring no error", () =>
    Effect.gen(function*() {
      const { first, polled, row, second } = yield* drive(Undeclared, "undeclared-settles")

      // The refusal reaches the caller as a defect naming the action, not as
      // a schema issue about the flow's own error channel.
      expect(Exit.isFailure(first)).toBe(true)
      expect(String(Exit.isFailure(first) ? Cause.squash(first.cause) : "")).toContain(
        "has no implementation"
      )
      expect(row.status).toBe("failed")
      expect(row.owner).toBeNull()
      expect(row.finishedAtMs).not.toBeNull()
      // The persisted cause carries the same message: an operator reading the
      // settled run learns which action is unwired.
      expect(settledDefect(polled)).toContain(Unimplemented.name)
      // A settled run is re-drivable: the second call returns rather than
      // re-entering the row the first drive stranded.
      expect(Exit.isFailure(second)).toBe(true)
    }), 60_000)

  it.live("settles the run failed for a flow that declares an error schema of its own", () =>
    Effect.gen(function*() {
      const { polled, row } = yield* drive(Declared, "declared-settles")

      expect(row.status).toBe("failed")
      expect(row.owner).toBeNull()
      expect(settledDefect(polled)).toContain(Unimplemented.name)
    }), 60_000)
})
