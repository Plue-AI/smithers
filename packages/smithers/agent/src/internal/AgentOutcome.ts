/**
 * The terminal outcome of a successfully drained agent stream.
 * @since 1.0.0
 */

import * as Fault from "@smthrs/flow/Fault"
import type * as AgentEvent from "@smthrs/harness/AgentEvent"
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"

type Outcome =
  | { readonly _tag: "Completed"; readonly output: string }
  | { readonly _tag: "FramesExhausted"; readonly frames: number }

// Frames spent with no completed answer is the plan not converging: a replan's.
Fault.register("FramesExhausted", "factory")

/**
 * Keep completion separate from the stream's successful transport exit.
 * @category destructors
 * @since 1.0.0
 */
export const agentOutcome = <E, R, E2, R2>(
  stream: Stream.Stream<AgentEvent.AgentEvent, E, R>,
  record: (event: AgentEvent.AgentEvent) => Effect.Effect<void, E2, R2>
): Effect.Effect<Outcome, E | E2, R | R2> =>
  Effect.gen(function*() {
    let frames = 0
    let output: string | undefined
    yield* stream.pipe(Stream.runForEach((event) =>
      Effect.suspend(() => {
        if (event._tag === "turn-opened") {
          frames += 1
          // A completion bounced by the controller is not the next frame's answer.
          output = undefined
        }
        if (event._tag === "transition-applied") {
          output = event.transition._tag === "complete" ? event.transition.output : undefined
        }
        return record(event)
      })
    ))
    return output === undefined ? { _tag: "FramesExhausted", frames } : { _tag: "Completed", output }
  })
