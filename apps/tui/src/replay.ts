/**
 * A seat that replays a recorded run's model stream instead of calling a
 * provider.
 *
 * `SMITHERS_TUI_REPLAY=run.jsonl` (recorded with `SMITHERS_TUI_RECORD`) makes
 * the n-th model call stream the n-th recorded reply at its recorded pace.
 * The cells it carries run for real against the working directory, so a
 * replay reproduces a whole turn offline: demos, bug reports, and the
 * terminal end-to-end suite. `SMITHERS_TUI_REPLAY_HOLD_MS` holds every reply
 * before its first delta, which keeps a turn running long enough to stop it;
 * `SMITHERS_TUI_REPLAY_SPEED` divides every recorded delay.
 */
import type * as FlowEngineLike from "@smthrs/agent/FlowEngineLike"
import * as Seat from "@smthrs/agent/Seat"
import * as Model from "@smthrs/model/Model"
import type * as ModelEvent from "@smthrs/model/ModelEvent"
import { ModelError, type ModelErrorCode } from "@smthrs/model/ModelError"
import type * as Route from "@smthrs/model/Route"
import { Duration, Effect, Stream } from "effect"
import { readFileSync } from "node:fs"

interface Timed {
  readonly after: number
  readonly delta: ModelEvent.ModelEvent
  readonly failure?: ModelError
}

/** One recorded reply per model call, each delta with its delay from the previous one. */
export const replies = (recorded: string): ReadonlyArray<ReadonlyArray<Timed>> => {
  const out: Array<Array<Timed>> = []
  let last = 0
  for (const line of recorded.split("\n")) {
    if (line.trim() === "") continue
    const { at, event } = JSON.parse(line) as {
      at: number
      event: { _tag: string; delta?: ModelEvent.ModelEvent; message?: { stopReason?: string } | string; code?: string }
    }
    if (event._tag === "model-requested") {
      out.push([])
      last = at
    }
    if (event._tag === "model-delta" && event.delta !== undefined && out.length > 0) {
      out.at(-1)!.push({ after: Math.max(0, at - last), delta: event.delta })
      last = at
    }
    if (event._tag === "replay-failure" && out.length > 0) {
      out.at(-1)!.push({ after: Math.max(0, at - last), delta: { type: "settle", stopReason: "error" }, failure: new ModelError({
        code: (event.code ?? "unknown") as ModelErrorCode,
        message: typeof event.message === "string" ? event.message : "Recorded model failure"
      }) })
      last = at
    }
    // The harness journals the reply's end as `model-settled`, not as a delta.
    if (event._tag === "model-settled" && out.length > 0) {
      out.at(-1)!.push({
        after: Math.max(0, at - last),
        delta: { type: "settle", stopReason: typeof event.message === "object" ? event.message?.stopReason ?? "stop" : "stop" } as ModelEvent.ModelEvent
      })
      last = at
    }
  }
  return out
}

const prepared: Route.PreparedRequest = {
  routeId: "replay",
  protocolId: "replay",
  method: "POST",
  url: "https://replay.invalid/",
  publicHeaders: {},
  body: new Uint8Array(),
  bodyText: ""
}

const route: FlowEngineLike.RouteResolver = { prepare: () => Effect.succeed(prepared) }

export const seat = (options: { readonly file: string; readonly holdMs?: number; readonly speed?: number }): Seat.Seat => {
  const speed = options.speed !== undefined && options.speed > 0 ? options.speed : 1
  const recorded = replies(readFileSync(options.file, "utf8"))
  let call = 0
  const model = Model.make({
    stream: () =>
      Stream.suspend(() => {
        const reply = recorded[Math.min(call++, recorded.length - 1)] ?? []
        const hold = Stream.fromEffect(Effect.sleep(Duration.millis(options.holdMs ?? 0))).pipe(Stream.drain)
        const paced = Stream.fromIterable(reply).pipe(
          Stream.mapEffect(({ after, delta, failure }) => Effect.sleep(Duration.millis(after / speed)).pipe(
            Effect.flatMap(() => failure === undefined ? Effect.succeed(delta) : Effect.fail(failure))))
        )
        return Stream.concat(hold, paced)
      })
  })
  return Seat.make({ id: `replay:${options.file}`, modelId: "replay", model, route, contextWindowTokens: 200_000 })
}
