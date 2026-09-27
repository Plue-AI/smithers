/** Projects only the saved outcome of an annotated trace checkpoint.
 * @since 1.0.0
 */

import { JournalEvent, StepFact } from "@smthrs/journal"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"

/** Builds the storage-only projector for one action.
 * @category constructors
 * @since 1.0.0
 */
export const make = (action: unknown, runId: string) => {
  const annotations = typeof action === "object" && action !== null && "annotations" in action
    ? action.annotations as Context.Context<never>
    : undefined
  const annotated = annotations !== undefined && Option.isSome(Context.getOption(annotations, StepFact.Annotation))
  return {
    annotated,
    settled: (outcome: unknown) =>
      Effect.gen(function*() {
        if (!annotated) return undefined
        const fact = yield* Schema.decodeUnknownEffect(StepFact.Fact)(outcome).pipe(Effect.orDie)
        const step = fact.step
        return new JournalEvent.Input({
          runId: JournalEvent.RunId.make(runId),
          sourceId: JournalEvent.SourceId.make(`step-fact-v1:${step.stepId}:${step.attempt}:${step.ask}:${step.retry}`),
          sourceSeq: JournalEvent.SourceSeq.make(fact.sourceSequence),
          eventType: StepFact.eventType,
          payload: fact
        })
      })
  }
}
