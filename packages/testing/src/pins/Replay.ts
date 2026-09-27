/**
 * Deterministic replay and suspension conformance pins.
 *
 * Manifest: `packages/testing/test/support/ParityManifest.ts`.
 *
 * @since 0.0.0
 */

import * as Effect from "effect/Effect"
import type { ConformanceCase } from "../Conformance.ts"
import type { FlowSpec, JournalEntryLike } from "../EngineSubject.ts"
import { assert, invoke } from "../internal/Pin.ts"
import { same } from "../internal/Structural.ts"

const deterministicReplayPin = "replay/completed-prefix"
const suspensionReplayPin = "replay/suspended-frontier"

const entriesFor = (
  journal: ReadonlyArray<JournalEntryLike>,
  stepKey: string,
  outcome?: JournalEntryLike["outcome"]
): ReadonlyArray<JournalEntryLike> =>
  journal.filter((entry) => entry.stepKey === stepKey && (outcome === undefined || entry.outcome === outcome))

const completedPrefixReplay: ConformanceCase = {
  name: deterministicReplayPin,
  run: (engine) =>
    Effect.gen(function*() {
      let prefixInvocations = 0
      let terminalInvocations = 0
      const prefixKey = "replay/completed-prefix/prefix"
      const terminalKey = "replay/completed-prefix/terminal"
      const flow: FlowSpec = {
        name: "testing/replay/completed-prefix",
        steps: [
          {
            key: prefixKey,
            sealed: true,
            kind: "step",
            run: (input) =>
              Effect.sync(() => {
                prefixInvocations += 1
                return { input, decision: "prefix" }
              })
          },
          {
            key: terminalKey,
            sealed: true,
            kind: "step",
            run: (input) =>
              Effect.sync(() => {
                terminalInvocations += 1
                return { input, output: "completed" }
              })
          }
        ]
      }
      const executionId = "testing/replay/completed-prefix/execution"

      const fresh = yield* invoke(deterministicReplayPin, "run", () =>
        engine.run({
          flow,
          payload: { command: "deterministic" },
          executionId
        }))
      const freshJournal = yield* invoke(
        deterministicReplayPin,
        "journal(fresh)",
        () => engine.journal(executionId)
      )
      const replayed = yield* invoke(deterministicReplayPin, "resume", () => engine.resume(executionId))
      const replayedJournal = yield* invoke(
        deterministicReplayPin,
        "journal(replayed)",
        () => engine.journal(executionId)
      )

      yield* assert(
        deterministicReplayPin,
        fresh.status === "completed" && replayed.status === "completed",
        "Fresh execution and replay must both complete.",
        ["completed", "completed"],
        [fresh.status, replayed.status]
      )
      yield* assert(
        deterministicReplayPin,
        prefixInvocations === 1 && terminalInvocations === 1,
        "A fresh engine over the same execution journal must not re-execute the completed prefix.",
        { prefixInvocations: 1, terminalInvocations: 1 },
        { prefixInvocations, terminalInvocations }
      )
      yield* assert(
        deterministicReplayPin,
        same(fresh.value, replayed.value),
        "Replay must reconstruct the same flow output.",
        fresh.value,
        replayed.value
      )
      yield* assert(
        deterministicReplayPin,
        same(freshJournal, replayedJournal),
        "Replay must reconstruct identical decisions from the same journal.",
        freshJournal,
        replayedJournal
      )
      yield* assert(
        deterministicReplayPin,
        entriesFor(replayedJournal, prefixKey, "completed").length === 1 &&
          entriesFor(replayedJournal, terminalKey, "completed").length === 1,
        "Replay must preserve one completed entry per completed step.",
        { [prefixKey]: 1, [terminalKey]: 1 },
        {
          [prefixKey]: entriesFor(replayedJournal, prefixKey, "completed").length,
          [terminalKey]: entriesFor(replayedJournal, terminalKey, "completed").length
        }
      )
    })
}

const suspendedFrontierReplay: ConformanceCase = {
  name: suspensionReplayPin,
  run: (engine) =>
    Effect.gen(function*() {
      let prefixInvocations = 0
      let frontierInvocations = 0
      const prefixKey = "replay/suspended-frontier/prefix"
      const frontierKey = "replay/suspended-frontier/frontier"
      const flow: FlowSpec = {
        name: "testing/replay/suspended-frontier",
        steps: [
          {
            key: prefixKey,
            sealed: true,
            kind: "step",
            run: (input) =>
              Effect.sync(() => {
                prefixInvocations += 1
                return input
              })
          },
          {
            key: frontierKey,
            sealed: false,
            kind: "step",
            run: () =>
              Effect.suspend(() => {
                frontierInvocations += 1
                return frontierInvocations === 1
                  ? Effect.interrupt
                  : Effect.succeed({ resumedAt: frontierKey })
              })
          }
        ]
      }
      const executionId = "testing/replay/suspended-frontier/execution"

      const suspended = yield* invoke(suspensionReplayPin, "run", () =>
        engine.run({
          flow,
          payload: { command: "suspend-once" },
          executionId
        }))
      const suspendedJournal = yield* invoke(
        suspensionReplayPin,
        "journal(suspended)",
        () => engine.journal(executionId)
      )

      yield* assert(
        suspensionReplayPin,
        suspended.status === "suspended",
        "A self-interrupted frontier must be represented as a suspended execution.",
        "suspended",
        suspended.status
      )
      yield* assert(
        suspensionReplayPin,
        entriesFor(suspendedJournal, frontierKey, "suspended").length === 1,
        "The journal must identify the exact suspended frontier step key.",
        { stepKey: frontierKey, outcome: "suspended" },
        suspendedJournal
      )

      const resumed = yield* invoke(suspensionReplayPin, "resume", () => engine.resume(executionId))
      const resumedJournal = yield* invoke(
        suspensionReplayPin,
        "journal(resumed)",
        () => engine.journal(executionId)
      )

      yield* assert(
        suspensionReplayPin,
        resumed.status === "completed",
        "Resuming the suspended frontier must complete the flow.",
        "completed",
        resumed.status
      )
      yield* assert(
        suspensionReplayPin,
        prefixInvocations === 1,
        "Resuming a suspended flow must not re-run its completed prefix.",
        1,
        prefixInvocations
      )
      yield* assert(
        suspensionReplayPin,
        frontierInvocations === 2,
        "Resume must continue by executing the suspended frontier once.",
        2,
        frontierInvocations
      )
      yield* assert(
        suspensionReplayPin,
        entriesFor(resumedJournal, prefixKey, "completed").length === 1,
        "The completed prefix must remain a single journal entry after resume.",
        1,
        entriesFor(resumedJournal, prefixKey, "completed").length
      )
      yield* assert(
        suspensionReplayPin,
        entriesFor(resumedJournal, frontierKey, "suspended").length === 1 &&
          entriesFor(resumedJournal, frontierKey, "completed").length === 1,
        "The suspended and resumed outcomes must use the same frontier step key.",
        [
          { stepKey: frontierKey, outcome: "suspended" },
          { stepKey: frontierKey, outcome: "completed" }
        ],
        entriesFor(resumedJournal, frontierKey)
      )
    })
}

/**
 * Deterministic completion and suspended-frontier replay cases.
 *
 * @category conformance
 * @since 0.0.0
 */
export const cases: ReadonlyArray<ConformanceCase> = Object.freeze([
  completedPrefixReplay,
  suspendedFrontierReplay
])
