/**
 * Injectable target-flow execution boundary.
 *
 * A suite says what to run; this service says how. Keeping it injectable is
 * what lets the same suite run against a real flow, a scripted host, or nothing
 * at all, and it is the only place a target's failure is converted into a typed
 * evaluation failure.
 *
 * @since 0.1.0
 */

import type { Flow } from "@smthrs/core"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { EvalError } from "./EvalError.ts"
import type { Case } from "./Suite.ts"

/**
 * The result of executing one target-flow case.
 *
 * `target` is the flow value the case actually executed. A run matches it
 * against each binding's `appliesTo` by reference identity, so it has to be the
 * declared flow itself rather than a copy of it.
 *
 * @category models
 * @since 0.1.0
 */
export interface Execution {
  readonly output: unknown
  readonly stepKey: string
  readonly latencyMs: number
  readonly target: Pick<Flow.Any, "name">
}

/**
 * The one callback a case executor is.
 *
 * @category models
 * @since 0.1.0
 */
export type Run = (suiteCase: Case) => Effect.Effect<Execution, EvalError>

/**
 * Runtime shape for an injectable target-flow executor.
 *
 * @category services
 * @since 0.1.0
 */
export interface Service {
  readonly run: Run
}

/**
 * Injectable execution boundary for a target flow.
 *
 * @category services
 * @since 0.1.0
 */
export class CaseExecutor extends Context.Service<CaseExecutor, Service>()("flows/evals/CaseExecutor") {}

/**
 * Builds an executor from its one callback.
 *
 * Throws a `TypeError` when there is no callback. An executor that silently
 * degraded to {@link makeNoop} turned one wiring mistake into a whole suite of
 * cases failing with `executor`, which reads as a broken target rather than a
 * missing one.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (run: Run): Service => {
  if (typeof run !== "function") {
    throw new TypeError("CaseExecutor.make needs a callback")
  }
  return CaseExecutor.of({ run })
}

/**
 * Builds an executor that fails every case with a typed executor error.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeNoop = (): Service =>
  CaseExecutor.of({
    run: (suiteCase) =>
      Effect.fail(
        new EvalError({
          code: "executor",
          message: `No executor is available for case '${suiteCase.name}'`,
          path: `cases['${suiteCase.name}']`
        })
      )
  })

/**
 * Provides the unavailable executor.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerNoop: Layer.Layer<CaseExecutor> = Layer.succeed(CaseExecutor)(makeNoop())
