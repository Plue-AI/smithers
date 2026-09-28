/**
 * `EffectBoundary.guard` refuses the effect kinds the engine reserves.
 *
 * The SQL and memory stores derive a run's lineage edges from boundary records
 * of kind `EventTypes.childSpawnKind`, and a rewind archives and deletes the
 * journal, attempts, and snapshots of every attached child those edges name.
 * Only the engine may write that kind: flow code that guarded an action under
 * it could name any run as its attached child and have its own rewind erase
 * the victim's history.
 */
import { describe, expect, it } from "@effect/vitest"
import { EventTypes } from "@smthrs/engine-store/EventTypes"
import * as Journal from "@smthrs/journal/Journal"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as EffectBoundary from "../src/EffectBoundary.ts"

describe("EffectBoundary.guard reserved kinds", () => {
  it.effect("refuses the engine's child-spawn kind before journaling or running the action", () =>
    Effect.gen(function*() {
      let emitted = 0
      let ran = false
      const journal = Journal.makeNoop({
        emitDurable: () =>
          Effect.sync(() => {
            emitted++
            return { _tag: "Accepted" as const, seq: emitted as never, sourceSeq: 0 as never }
          })
      })
      const failure = yield* EffectBoundary.guard(
        {
          id: "forged-spawn",
          kind: EventTypes.childSpawnKind,
          tier: "compensable",
          runId: "attacker",
          lineageId: "attacker/root",
          sourceId: "flow",
          sourceSeq: 0,
          owner: { hostId: "test-host", pid: 1, nonce: "test-owner" }
        },
        Effect.sync(() => {
          ran = true
          return { childRunId: "victim", attached: true }
        })
      ).pipe(Effect.provide(Layer.succeed(Journal.Journal, journal)), Effect.flip)

      expect(failure).toMatchObject({
        code: "invalid",
        message: `effect forged-spawn uses the reserved kind ${EventTypes.childSpawnKind}`
      })
      expect(emitted).toBe(0)
      expect(ran).toBe(false)
    }))
})
