import { executeUntilParked } from "./ExecuteUntilParked.ts"
import { opaqueHandlerBody } from "./fixtures/OpaqueHandlerBody.ts"
/**
 * What the driver writes for a settlement the flow's own codec rejects.
 *
 * release validation found the terminal transition guarded by
 * `Effect.orDie` around that encode: `engine-store: coordinated drain failed
 * for run-1 SchemaError: Expected JSON value at ["exit"]["cause"][0]["error"]`,
 * with the run row left `running` under an owner that had exited. A flow
 * declaring `Schema.Unknown` for its error channel — which is what
 * `@smthrs/agent`'s `agent/run` declares — encodes that channel through
 * `Schema.Json`, and `Schema.Json` rejects every class instance, so every
 * tagged error an agent body fails with lands here.
 *
 * The release policy allows one terminal write per run. These pin that the
 * write happens.
 */
import { describe, expect, it } from "@effect/vitest"
import type { FlowRuntime } from "@smthrs/flow"
import { Flow } from "@smthrs/flow"
import { Jj } from "@smthrs/kernel"
import { RunStore } from "@smthrs/run-store"
import type * as Cause from "effect/Cause"
import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import type * as Layer from "effect/Layer"
import * as Logger from "effect/Logger"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as EngineStore from "../src/EngineStore.ts"
import * as ExitEncoding from "../src/internal/ExitEncoding.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { withCrypto } from "./Sha256.ts"

const jj = Jj.make({
  snapshot: () =>
    Effect.succeed({ commitId: "unencodable-snapshot" as never, changeId: "unencodable-snapshot" as never }),
  restore: () => Effect.void,
  diff: () => Effect.succeed(""),
  workspaceAdd: () => Effect.void,
  workspaceForget: () => Effect.void,
  status: () => Effect.succeed("")
})

type Services =
  | Layer.Success<ReturnType<typeof TestStores.layer>>
  | StepBoundary.Service
  | DurableEngineState.DurableEngineState
  | Jj.Jj
  | Crypto.Crypto
  | Scope.Scope

const withEngine = <A, E>(
  body: (
    engine: FlowRuntime.FlowRuntime["Service"],
    store: RunStore.Service
  ) => Effect.Effect<A, E, Services>
) => {
  const state = DurableEngineState.makeMemory()
  return withCrypto(
    Effect.scoped(
      Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        const engine = (yield* EngineStore.make({
          owner: { hostId: "unencodable-host" },
          journalSource: "unencodable-test",
          isAlive: () => Effect.succeed(false)
        })) as FlowRuntime.FlowRuntime["Service"]
        return yield* body(engine, store)
      }).pipe(
        Effect.provideService(DurableEngineState.DurableEngineState, state),
        Effect.provideService(Jj.Jj, jj)
      )
    ).pipe(
      Effect.provide(StepBoundary.layerTest()),
      Effect.provide(TestStores.layer()),
      // The projection logs a warning; the suite reads the row, not the log.
      Effect.provide(Logger.layer([]))
    )
  )
}

/** The shape `agent/run` declares: an error channel that carries anything. */
const UnencodableFlow = Flow.make("Unencodable/Settlement", {
  payload: {},
  success: Schema.Unknown,
  error: Schema.Unknown,
  body: opaqueHandlerBody
})

/** A tagged error, which `Schema.Json` refuses because it is a class instance. */
class SeatRejected extends Schema.TaggedError<SeatRejected>()("test/SeatRejected", {
  code: Schema.String,
  message: Schema.String
}) {}

describe("a run whose failure the flow's own codec cannot encode", () => {
  it.effect("settles `failed` with the cause projected onto its row", () =>
    Effect.gen(function*() {
      const row = yield* withEngine((engine, store) =>
        Effect.gen(function*() {
          yield* engine.register(
            UnencodableFlow,
            () =>
              Effect.fail(
                new SeatRejected({ code: "quota_exceeded", message: "You have no credits remaining" })
              )
          )
          yield* executeUntilParked(engine, UnencodableFlow, {
            executionId: "unencodable-settlement",
            payload: {},
            discard: true
          })
          return yield* store.get("unencodable-settlement")
        })
      )

      // The transition the drain used to die before reaching.
      expect(row.status).toBe("failed")
      expect(row.finishedAtMs).not.toBeNull()
      const state = JSON.parse(row.stateJson) as {
        result: { exit: { cause: ReadonlyArray<{ defect: ExitEncoding.ResultProjection }> } }
      }
      const projected = state.result.exit.cause[0]?.defect
      expect(projected?._tag).toBe(ExitEncoding.projectionTag)
      expect(projected?.note).toBe("the flow result codec rejected the settlement")
      expect(projected?.reasons[0]?.error?.tag).toBe("test/SeatRejected")
      expect(projected?.reasons[0]?.error?.code).toBe("quota_exceeded")
      expect(projected?.reasons[0]?.error?.message).toBe("You have no credits remaining")
    }))

  it("redacts credentials in the projected message and stack", () => {
    const token = "ghs_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"
    const remote = `https://x-access-token:${token}@github.com/acme/private.git/`
    const projected = ExitEncoding.projectValue({
      _tag: "GitCloneFailed",
      message: `fatal: unable to access '${remote}': 403`,
      stack: `GitCloneFailed: fatal\n    at clone (${remote})`
    })

    expect(JSON.stringify(projected)).not.toContain(token)
    expect(projected.message).toBe(
      "fatal: unable to access 'https://x-access-token:[REDACTED]@github.com/acme/private.git/': 403"
    )
    expect(ExitEncoding.projectValue(`clone ${remote}`).message).not.toContain(token)
  })

  it.effect("answers the waiting caller the projected failure rather than a suspension", () =>
    Effect.gen(function*() {
      // Before the fix the drain died, `poll` found no result on the row, and
      // the caller was told `Suspended` — told to wait for a run that was over.
      const exit = yield* withEngine((engine) =>
        Effect.gen(function*() {
          yield* engine.register(
            UnencodableFlow,
            () => Effect.fail(new SeatRejected({ code: "authentication", message: "no key" }))
          )
          return yield* Effect.exit(engine.execute(UnencodableFlow, {
            executionId: "unencodable-answer",
            payload: {}
          }))
        })
      )

      expect(Exit.isFailure(exit)).toBe(true)
      const reason = (exit as Exit.Failure<unknown, unknown>).cause.reasons[0]
      expect(reason?._tag).toBe("Die")
      expect((reason as Cause.Die).defect).toMatchObject({
        _tag: ExitEncoding.projectionTag,
        reasons: [{ _tag: "Fail", error: { tag: "test/SeatRejected", code: "authentication" } }]
      })
    }))
})
