/**
 * Source checkpoints for one native agent dispatch.
 * @since 1.0.0
 */

import * as Digest from "@smthrs/core/Digest"
import { Action, FlowRuntime } from "@smthrs/flow"
import type * as AgentEvent from "@smthrs/harness/AgentEvent"
import { HarnessError } from "@smthrs/harness/HarnessError"
import { type Journal, JournalEvent, StepFact } from "@smthrs/journal"
import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import type * as Schema from "effect/Schema"
import { maxTracedBytes, traceIdentity, tracer } from "../AgentSession.ts"
import type * as EventSink from "../EventSink.ts"

interface Cursor {
  frame: number
  ordinal: number
  cell: string
  occurrences: Map<string, number>
  // A request fact is written against the step's last one. Kept with the
  // step's position because it has the same life: one dispatch, replayed from
  // its first frame, so the facts a replay regenerates are the facts it wrote.
  project: ReturnType<typeof tracer>
}

const boundCallFields = (payload: Record<string, Schema.Json>): Record<string, Schema.Json> =>
  Object.fromEntries(
    Object.entries(payload).map(([key, value]) => {
      if (key === "callId" || key === "outcome") return [key, value]
      const json = JSON.stringify(value)
      const bytes = new TextEncoder().encode(json).byteLength
      return [key, bytes <= maxTracedBytes ? value : { truncated: true, bytes, digest: Digest.digest(json) }]
    })
  )

/**
 * Every source event owns a small durable checkpoint. Its saved outcome and
 * public fact commit together in ActionPersistence. No writer outlives the
 * event, and the enclosing agent dispatch cannot settle ahead of its facts.
 * @category constructors
 * @since 1.0.0
 */
export const make = (journal: Journal.Service) =>
  Effect.gen(function*() {
    const runtime = yield* FlowRuntime.FlowRuntime
    const instance = yield* FlowRuntime.FlowInstance
    const crypto = yield* Crypto.Crypto
    const cursors = new WeakMap<StepFact.Step, Cursor>()
    const emit = (event: AgentEvent.AgentEvent, step?: StepFact.Step): Effect.Effect<void> =>
      Effect.gen(function*() {
        if (step === undefined || step.executionId !== instance.executionId) {
          return yield* Effect.die(
            new HarnessError({
              code: "engine_failed",
              message: "An agent trace requires its owning dispatch identity"
            })
          )
        }
        let cursor = cursors.get(step)
        if (cursor === undefined) {
          cursor = { frame: -1, ordinal: 0, cell: "", occurrences: new Map(), project: tracer() }
          cursors.set(step, cursor)
        }
        const projected = cursor.project(event)
        if (projected === undefined) return
        if (event._tag === "turn-opened") {
          cursor.frame++
          cursor.ordinal = 0
          cursor.cell = ""
          cursor.occurrences.clear()
        }
        if (event._tag === "cell-produced") cursor.cell = event.cell.digest
        const json = JSON.stringify(projected.payload)
        const bytes = new TextEncoder().encode(json).byteLength
        const original = JSON.parse(json) as Record<string, Schema.Json>
        const payload = bytes <= 262_144
          ? original
          : projected.eventType === "control.agent.cell-call-started"
              || projected.eventType === "control.agent.cell-call-settled"
          ? boundCallFields(original)
          : { truncated: true, bytes, digest: Digest.digest(json) }
        // Concurrent calls may replay in a different completion order. Their
        // checkpoint addresses use call identity, not consumer arrival order.
        const position = JSON.stringify([projected.eventType, original.callId ?? ""])
        const occurrence = cursor.occurrences.get(position) ?? 0
        cursor.occurrences.set(position, occurrence + 1)
        const { cell, frame, ordinal } = cursor
        cursor.ordinal++
        const identity = Digest.digest(JSON.stringify([step, frame, cell, position, occurrence]))
        yield* Action.make({
          name: "agent/trace/checkpoint",
          success: StepFact.Fact,
          tier: "sealed",
          idempotencyKey: identity,
          annotations: Context.make(StepFact.Annotation, {}),
          execute: Effect.gen(function*() {
            if (journal.generation === undefined) {
              return yield* Effect.die(
                new HarnessError({ code: "engine_failed", message: "The trace journal has no generation reader" })
              )
            }
            const { generation } = yield* journal.generation(JournalEvent.RunId.make(step.executionId)).pipe(
              Effect.orDie
            )
            const at = yield* Clock.currentTimeMillis
            return {
              version: 1 as const,
              step,
              generation,
              frame,
              ordinal,
              cell,
              at,
              eventType: projected.eventType,
              // Arrival order can change around a retained prefix. The journal
              // identity follows the checkpoint address; ordinal only records
              // where this observation first arrived.
              sourceSequence: traceIdentity(frame, occurrence, cell, projected.eventType, { checkpoint: identity }),
              payload
            }
          })
        }).pipe(
          Effect.provideService(Action.CurrentAttempt, 1),
          Effect.provideService(FlowRuntime.FlowRuntime, runtime),
          Effect.provideService(FlowRuntime.FlowInstance, instance),
          Effect.provideService(Crypto.Crypto, crypto)
        )
      })
    return { emit, atSource: true } satisfies EventSink.Service
  })
