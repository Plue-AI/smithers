/** Native call facts written by the action owner, never a harness stream consumer.
 * @since 1.0.0
 */

import { CallFact, JournalEvent } from "@smthrs/journal"
import { DerivedKey, digest } from "@smthrs/keys"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"

const maxBytes = 65_536
const encoder = new TextEncoder()
const bounded = (value: Schema.Json) =>
  Effect.gen(function*() {
    const bytes = encoder.encode(typeof value === "string" ? value : JSON.stringify(value)).byteLength
    return bytes <= maxBytes ? value : {
      truncated: true,
      bytes,
      digest: digest(yield* Schema.decodeUnknownEffect(DerivedKey)(value).pipe(Effect.orDie))
    }
  })

/** No new action identity, callback, table or delivery queue is introduced.
 * @category constructors
 * @since 1.0.0
 */
export const make = (action: unknown, runId: string) => {
  const annotations = typeof action === "object" && action !== null && "annotations" in action
    ? action.annotations as Context.Context<never>
    : undefined
  const annotation = annotations === undefined ? Option.none() : Context.getOption(annotations, CallFact.Annotation)
  const resultSchema =
    typeof action === "object" && action !== null && "successSchema" in action && Schema.isSchema(action.successSchema)
      ? action.successSchema as Schema.Codec<unknown, unknown>
      : undefined
  const record = (phase: "invoked" | "settled", outcome?: unknown) =>
    Effect.gen(function*() {
      if (Option.isNone(annotation) || annotation.value.phase !== phase) return undefined
      const call = yield* Schema.decodeUnknownEffect(CallFact.Call)(annotation.value.call).pipe(Effect.orDie)
      // Production record boundaries carry a service-free success codec. Check
      // it before publishing an older encoded row as a deliverable result: the
      // reader would refuse a corrupt row even when its broad JSON shape fits.
      if (phase === "settled" && resultSchema !== undefined) {
        yield* Schema.decodeUnknownEffect(Schema.toCodecJson(resultSchema))(outcome).pipe(Effect.orDie)
      }
      const result = phase === "settled"
        ? yield* Schema.decodeUnknownEffect(CallFact.Result)(outcome).pipe(Effect.orDie)
        : undefined
      const coordinates = {
        version: 1 as const,
        callId: call.callId,
        identity: call.identity,
        flowName: call.flowName
      }
      const payload: CallFact.Fact = result === undefined
        ? {
          ...coordinates,
          phase: "invoked",
          input: yield* bounded(call.input),
          // Never bounded: the display projection is four short fields its
          // owner already validated, and a truncation marker in its place
          // would read as a declaration that claimed something unreadable.
          ...(call.descriptor === undefined ? {} : { descriptor: call.descriptor })
        }
        : {
          ...coordinates,
          phase: "settled",
          outcome: result.outcome,
          value: yield* bounded(result.value),
          ...(result.message === undefined ? {} : { message: yield* bounded(result.message) }),
          ...(result.code === undefined ? {} : { code: result.code })
        }
      return new JournalEvent.Input({
        runId: JournalEvent.RunId.make(runId),
        sourceId: JournalEvent.SourceId.make(`call-fact-v1:${call.callId}:${phase}`),
        sourceSeq: JournalEvent.SourceSeq.make(0),
        eventType: CallFact.eventType,
        payload
      })
    })
  return {
    settles: Option.isSome(annotation) && annotation.value.phase === "settled",
    invoked: record("invoked"),
    settled: (outcome: unknown) => record("settled", outcome)
  }
}
