/** Model-backed judgments and transport-only fallback for an Evaluator. */

import { Effect, Stream } from "effect"
import * as Evaluator from "./Evaluator.ts"
import type * as Model from "./Model.ts"
import * as ModelEvent from "./ModelEvent.ts"
import { ModelRequest } from "./ModelRequest.ts"

/**
 * Judge through any Model using the same answer validation as a resolved seat.
 *
 * @category constructors
 * @since 1.0.0-rc.1
 */
export const fromModel = (model: Model.Model, modelId: string): Evaluator.Evaluator =>
  Evaluator.Evaluator.of({
    evaluate: (request) => {
      let emptyText = false
      const scriptedRequest: Model.Model = {
        stream: (judgeRequest) =>
          Stream.unwrap(
            model.stream(
              new ModelRequest({
                ...judgeRequest,
                tools: [],
                toolChoice: "none",
                params: { reasoningEffort: "low" }
              })
            ).pipe(
              Stream.runCollect,
              Effect.map((events) => {
                const { message } = ModelEvent.settledMessage(events)
                emptyText = !message.content.some((part) => part.type === "text" && part.text.trim() !== "")
                return Stream.fromIterable(events)
              })
            )
          )
      }
      return Effect.flatMap(Evaluator.Evaluator, (judge) => judge.evaluate(request)).pipe(
        Effect.provide(Evaluator.layerFromSeat({ model: scriptedRequest, modelId })),
        Effect.mapError((error) =>
          emptyText && error.code === "invalid_answer"
            ? new Evaluator.EvaluatorError({ code: "empty", message: "The model returned no judgment text." })
            : error
        )
      )
    }
  })

/**
 * Use the backup only when the primary is unavailable: unreachable, timed
 * out, or refusing with a server error or 429 after its own retries. A
 * refusal of the caller (4xx) or of the question never falls back.
 *
 * @category constructors
 * @since 1.0.0-rc.1
 */
export const withFallback = (primary: Evaluator.Evaluator, backup: Evaluator.Evaluator): Evaluator.Evaluator =>
  Evaluator.Evaluator.of({
    evaluate: (request) =>
      primary.evaluate(request).pipe(
        Effect.catch((error) =>
          error.code === "unreachable" || error.code === "timeout" ||
            (error.code === "refused" && error.status !== undefined && (error.status >= 500 || error.status === 429))
            ? backup.evaluate(request)
            : Effect.fail(error)
        )
      )
  })
