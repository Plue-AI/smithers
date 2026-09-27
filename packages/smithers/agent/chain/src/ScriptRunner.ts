/**
 * The script interpreter port, and its in-process implementation.
 *
 * A script's only INTENDED exits are `ctx.call` and the outcome it returns.
 * Calls are settled one at a time by an Effect handler (the same pump shape
 * the QuickJS sandbox uses), so a hardened interpreter is a layer swap with
 * no chain change (https://chain.smithers.sh/contract/). Enforcing that the
 * intended exits are the ONLY exits is the sandbox's job, not this port's:
 * {@link layerInProcess} runs the script in the host realm. Everything the
 * two bindings must agree about byte for byte — the JSON boundary, its
 * limits, and the refusal messages — lives in `JsonBoundary.ts`.
 *
 * @since 0.1.0
 */

import { Context, Effect, Layer, Schema } from "effect"
import * as JsonBoundary from "./JsonBoundary.ts"
import * as Outcome from "./Outcome.ts"
import type * as Script from "./Script.ts"

/**
 * A script that did not reach an outcome: it failed to compile, threw at
 * runtime, returned something that is not an outcome, or the interpreter
 * itself is unavailable.
 *
 * @category errors
 * @since 0.1.0
 * @slop
 */
export class ScriptFailure extends Schema.TaggedError<ScriptFailure>()("/chain/ScriptFailure", {
  code: Schema.Literals(["compile", "runtime", "invalid_outcome", "runner_unavailable"]),
  message: Schema.String
}) {}

/**
 * One call a running script issued; ordinals are assigned by the chain's
 * handler, which owns the per-link call counter.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Request {
  readonly name: string
  readonly payload: unknown
}

/**
 * The interpreter's one operation: run a script to an outcome, settling
 * each call it issues through the given handler.
 *
 * @category services
 * @since 0.1.0
 * @slop
 */
export interface Service {
  readonly run: <E>(
    script: Script.Script,
    handler: (request: Request) => Effect.Effect<unknown, E>
  ) => Effect.Effect<Outcome.Outcome, ScriptFailure | E>
}

/**
 * The script interpreter service tag.
 *
 * @category services
 * @since 0.1.0
 * @slop
 */
export class ScriptRunner extends Context.Service<ScriptRunner, Service>()("/chain/ScriptRunner") {}

/**
 * Builds an interpreter from an implementation.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const make = (implementation: Service): Service => ScriptRunner.of(implementation)

/**
 * An interpreter whose every operation fails as unavailable, with
 * per-operation overrides — the default a test starts from.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const makeNoop = (overrides: Partial<Service> = {}): Service =>
  make({
    run: Effect.fn("ScriptRunner.run")(() =>
      Effect.fail(new ScriptFailure({ code: "runner_unavailable", message: "run is unavailable" }))
    ),
    ...overrides
  })

/**
 * The unavailable interpreter as a layer.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layerNoop = (overrides: Partial<Service> = {}): Layer.Layer<ScriptRunner> =>
  Layer.succeed(ScriptRunner)(makeNoop(overrides))

interface Pending {
  readonly name: string
  readonly payload: unknown
  readonly resolve: (value: unknown) => void
  readonly reject: (error: unknown) => void
}

type Settled = { readonly _tag: "value"; readonly value: unknown } | {
  readonly _tag: "thrown"
  readonly error: unknown
}

const abortError = (): Error => new Error(JsonBoundary.abortedLink)

const runInProcess = <E>(
  script: Script.Script,
  handler: (request: Request) => Effect.Effect<unknown, E>
): Effect.Effect<Outcome.Outcome, ScriptFailure | E> =>
  Effect.gen(function*() {
    let factory: (
      ctx: unknown,
      done: typeof Outcome.done,
      to: typeof Outcome.to,
      park: typeof Outcome.park
    ) => unknown
    try {
      // The Function constructor is the point of this layer: an in-process
      // interpreter whose body is the authored script. Sealing beyond the
      // ctx surface is the QuickJS layer's job.

      factory = new Function(
        "ctx",
        "done",
        "to",
        "park",
        `"use strict"\nreturn (async () => {\n${script.text}\n})()`
      ) as typeof factory
    } catch (error) {
      return yield* new ScriptFailure({ code: "compile", message: String(error) })
    }

    const pending: Array<Pending> = []
    let settled: Settled | undefined
    let aborted = false

    const ctx = Object.freeze({
      call: (name: unknown, payload?: unknown) =>
        new Promise((resolve, reject) => {
          if (aborted) {
            reject(abortError())
            return
          }
          // The same in-realm checks the QuickJS prelude performs: a
          // non-string name and a non-JSON payload reject identically, and
          // the payload crosses as a structural copy.
          if (typeof name !== "string") {
            reject(new TypeError(JsonBoundary.missingCallName))
            return
          }
          const payloadBoundary = JsonBoundary.jsonBoundary(payload)
          if (payloadBoundary._tag === "Refused") {
            reject(new TypeError(JsonBoundary.unserializableInput))
            return
          }
          pending.push({ name, payload: payloadBoundary.value, resolve, reject })
        })
    })

    // The factory body is `return (async () => {...})()`, so invoking it
    // never throws synchronously — every script error lands in the rejection.
    Promise.resolve(factory(ctx, Outcome.done, Outcome.to, Outcome.park)).then(
      (value) => {
        settled = { _tag: "value", value }
      },
      (error: unknown) => {
        settled = { _tag: "thrown", error }
      }
    )

    while (true) {
      const next = pending.shift()
      if (next !== undefined) {
        const result = yield* handler({ name: next.name, payload: next.payload }).pipe(
          Effect.tapError(() =>
            Effect.sync(() => {
              // A failed handler aborts the whole run: the script may not
              // catch its way past a gate. Later settlements are ignored.
              aborted = true
              next.reject(abortError())
              for (const stale of pending.splice(0)) stale.reject(abortError())
            })
          )
        )
        // A handler result crosses the same JSON boundary in every
        // binding; a host handler returning something unserializable is a
        // rejected call the script can observe, never a defect.
        const resultBoundary = JsonBoundary.jsonBoundary(result)
        if (resultBoundary._tag === "Refused") {
          next.reject(new Error(`the "${next.name}" call result is not JSON-serializable`))
        } else {
          next.resolve(resultBoundary.value)
        }
        continue
      }
      if (settled !== undefined) {
        if (settled._tag === "thrown") {
          return yield* new ScriptFailure({ code: "runtime", message: JsonBoundary.failureMessage(settled.error) })
        }
        // The outcome crosses the same boundary as a call payload, and it
        // crosses BEFORE decoding. The QuickJS binding validates in-realm
        // for the same reason: a value its own `JSON.stringify` would
        // rewrite — NaN, a function property, `undefined`, a `toJSON`
        // hook — must be refused here rather than laundered into a
        // different terminal result.
        const bounded = JsonBoundary.jsonBoundary(settled.value)
        if (bounded._tag === "Refused") {
          return yield* new ScriptFailure({
            code: "invalid_outcome",
            message: JsonBoundary.unserializableOutcome
          })
        }
        const outcome = JsonBoundary.decodeOutcome(bounded.value)
        if (outcome._tag === "None") {
          return yield* new ScriptFailure({
            code: "invalid_outcome",
            message: JsonBoundary.notAnOutcome
          })
        }
        return outcome.value
      }
      // Let every currently runnable host microtask finish. If that produces
      // neither a call nor a terminal result, the script is waiting on a
      // promise outside the only supported async door and cannot advance.
      yield* Effect.yieldNow
      if (pending.length === 0 && settled === undefined) {
        return yield* new ScriptFailure({
          code: "runtime",
          message: JsonBoundary.neverSettles
        })
      }
    }
  })

/**
 * The in-process runner: the script body runs as an async `Function` with
 * `ctx`, `done`, `to`, and `park` in scope.
 *
 * It provides NO isolation. The `Function` constructor builds its body in
 * GLOBAL scope, so the script reaches `globalThis`, `process`, and dynamic
 * `import()` — a fact `RunnerConformance.test.ts` pins deliberately, so
 * this sentence and the code cannot drift apart. Use it for trusted
 * fixtures. `QuickJsRunner.layer()` is the only sandbox for model-authored
 * scripts.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layerInProcess: Layer.Layer<ScriptRunner> = Layer.succeed(ScriptRunner)(
  make({ run: runInProcess })
)
