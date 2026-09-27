/**
 * Durable race conformance pins.
 *
 * Governing design: `packages/testing/docs/concepts/engine-subject.md`, "Race
 * semantics"; manifest: `packages/testing/test/support/ParityManifest.ts`.
 *
 * @since 0.0.0
 */

import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Latch from "effect/Latch"
import * as Ref from "effect/Ref"
import * as TestClock from "effect/testing/TestClock"
import type { ConformanceCase } from "../Conformance.ts"
import type { EngineSubject, ExecutionResult, FlowSpec, JournalEntryLike, StepSpec } from "../EngineSubject.ts"
import { assert, awaitFiber, fail, invoke, waitUntil } from "../internal/Pin.ts"
import { same } from "../internal/Structural.ts"
import type { ConformanceViolation, EngineSubjectError } from "../TestingError.ts"

const loserInterruptedPin = "race/loser-interrupted"
const recordedWinnerPin = "race/recorded-winner-replay"
const recordedLoserPin = "race/recorded-loser-interruption"

interface RaceObservation {
  /** The suspended outcome of the fresh run, parked at the step after the race. */
  readonly fresh: ExecutionResult
  readonly replayed: ExecutionResult
  readonly freshJournal: ReadonlyArray<JournalEntryLike>
  readonly replayedJournal: ReadonlyArray<JournalEntryLike>
  readonly winnerKey: string
  readonly loserKey: string
  readonly frontierKey: string
  readonly winnerRuns: number
  readonly loserRuns: number
  readonly loserInterruptions: number
  readonly frontierRuns: number
}

const entriesFor = (
  journal: ReadonlyArray<JournalEntryLike>,
  stepKey: string
): ReadonlyArray<JournalEntryLike> => journal.filter((entry) => entry.stepKey === stepKey)

const successfulFiber = <A, E>(
  pin: string,
  exit: Exit.Exit<A, E>,
  message: string
): Effect.Effect<A, ConformanceViolation> =>
  Exit.isSuccess(exit) ? Effect.succeed(exit.value) : fail(pin, message, "successful result", exit.cause)

/**
 * Races two branches, parks the flow on a step *after* the race, then resumes
 * that unfinished execution under inverted branch timing.
 *
 * The frontier step is what makes the replay assertions bite. A flow whose only
 * step is the race settles on the fresh run, and every subject short-circuits
 * `resume` on a terminal execution, so replaying one certified nothing beyond
 * terminal-result reuse: an engine that had lost recorded-winner lookup
 * entirely still passed. Suspending after the race forces resume to re-enter
 * the flow and rebuild the race from its journal, while the recorded loser is
 * the only branch that could win were it re-raced.
 */
const runRace = (
  pin: string,
  suffix: string,
  engine: EngineSubject
): Effect.Effect<RaceObservation, ConformanceViolation | EngineSubjectError> =>
  Effect.gen(function*() {
    const winnerKey = `race/${suffix}/recorded-winner`
    const loserKey = `race/${suffix}/recorded-loser`
    const freshWinnerStarted = yield* Latch.make()
    const freshLoserStarted = yield* Latch.make()
    const freshWinnerGate = yield* Latch.make()
    const freshLoserGate = yield* Latch.make()
    const replayWinnerGate = yield* Latch.make()
    const replayLoserGate = yield* Latch.make(true)
    const winnerRuns = yield* Ref.make(0)
    const loserRuns = yield* Ref.make(0)
    const loserInterruptions = yield* Ref.make(0)
    const frontierRuns = yield* Ref.make(0)
    let replayPhase = false

    const winner: StepSpec = {
      key: winnerKey,
      sealed: false,
      kind: "step",
      run: () =>
        Effect.suspend(() => {
          const gate = replayPhase ? replayWinnerGate : freshWinnerGate
          return Effect.andThen(
            Ref.update(winnerRuns, (count) => count + 1),
            Effect.andThen(
              freshWinnerStarted.open,
              Effect.as(
                Effect.andThen(
                  gate.await,
                  replayPhase ? Effect.void : Effect.sleep("1 second")
                ),
                "recorded-winner"
              )
            )
          )
        })
    }
    const loser: StepSpec = {
      key: loserKey,
      sealed: false,
      kind: "step",
      run: () =>
        Effect.suspend(() => {
          const gate = replayPhase ? replayLoserGate : freshLoserGate
          return Effect.onInterrupt(
            Effect.andThen(
              Ref.update(loserRuns, (count) => count + 1),
              Effect.andThen(freshLoserStarted.open, Effect.as(gate.await, "recorded-loser"))
            ),
            () => Ref.update(loserInterruptions, (count) => count + 1)
          )
        })
    }
    // Suspends on its first invocation and returns the race's output on its
    // second, so the flow's value stays the winner's value across the
    // suspension and a replay that re-raced would report the loser's instead.
    const frontierKey = `race/${suffix}/frontier`
    const frontier: StepSpec = {
      key: frontierKey,
      sealed: false,
      kind: "step",
      run: (input) =>
        Effect.flatMap(
          Ref.updateAndGet(frontierRuns, (count) => count + 1),
          (count) => count === 1 ? Effect.interrupt : Effect.succeed(input)
        )
    }
    const flow: FlowSpec = {
      name: `testing/race/${suffix}`,
      steps: [
        {
          key: `race/${suffix}/parent`,
          sealed: true,
          kind: "race",
          branches: [winner, loser]
        },
        frontier
      ]
    }
    const executionId = `testing/race/${suffix}/execution`
    const freshFiber = yield* invoke(pin, "run(fork)", () =>
      engine.run({
        flow,
        payload: { command: "race" },
        executionId
      })).pipe(Effect.forkChild({ startImmediately: true }))

    yield* waitUntil(
      pin,
      () => freshWinnerStarted.isOpen() && freshLoserStarted.isOpen(),
      "The subject did not start both race branches."
    )
    yield* freshWinnerGate.open
    yield* TestClock.adjust("1 second")

    const freshExit = yield* awaitFiber(
      pin,
      freshFiber,
      "The fresh race did not park at its frontier after the deterministic winner was released."
    )
    const fresh = yield* successfulFiber(
      pin,
      freshExit,
      "The fresh race escaped as a failure or defect instead of suspending at its frontier."
    )
    const freshJournal = yield* invoke(pin, "journal(fresh)", () => engine.journal(executionId))

    replayPhase = true
    const replayFiber = yield* invoke(pin, "resume(fork)", () => engine.resume(executionId)).pipe(
      Effect.forkChild({ startImmediately: true })
    )
    const replayExit = yield* awaitFiber(
      pin,
      replayFiber,
      "Race replay did not settle from its recorded outcomes."
    )
    const replayed = yield* successfulFiber(
      pin,
      replayExit,
      "Race replay escaped as a failure or defect."
    )
    const replayedJournal = yield* invoke(pin, "journal(replayed)", () => engine.journal(executionId))

    return {
      fresh,
      replayed,
      freshJournal,
      replayedJournal,
      winnerKey,
      loserKey,
      frontierKey,
      winnerRuns: yield* Ref.get(winnerRuns),
      loserRuns: yield* Ref.get(loserRuns),
      loserInterruptions: yield* Ref.get(loserInterruptions),
      frontierRuns: yield* Ref.get(frontierRuns)
    }
  })

/**
 * Pins loser fiber interruption and its journaled aborted outcome.
 *
 * Governing design: `packages/testing/docs/concepts/engine-subject.md`, "Race
 * semantics".
 */
const loserInterrupted: ConformanceCase = {
  name: loserInterruptedPin,
  run: (engine) =>
    Effect.gen(function*() {
      const observed = yield* runRace(loserInterruptedPin, "loser-interrupted", engine)
      const freshWinner = entriesFor(observed.freshJournal, observed.winnerKey)
      yield* assert(
        loserInterruptedPin,
        observed.fresh.status === "suspended" &&
          freshWinner.length === 1 &&
          freshWinner[0]?.outcome === "completed" &&
          freshWinner[0]?.value === "recorded-winner",
        "The released branch must deterministically win the fresh race, which then parks at its frontier.",
        {
          status: "suspended",
          winner: [{ stepKey: observed.winnerKey, outcome: "completed", value: "recorded-winner" }]
        },
        { status: observed.fresh.status, winner: freshWinner }
      )
      yield* assert(
        loserInterruptedPin,
        observed.loserRuns === 1 && observed.loserInterruptions === 1,
        "The losing branch must run once and observe fiber interruption.",
        { loserRuns: 1, loserInterruptions: 1 },
        {
          loserRuns: observed.loserRuns,
          loserInterruptions: observed.loserInterruptions
        }
      )
      yield* assert(
        loserInterruptedPin,
        observed.freshJournal.some((entry) => entry.stepKey === observed.loserKey && entry.outcome === "aborted"),
        "The loser interruption must be recorded as an aborted journal outcome.",
        { stepKey: observed.loserKey, outcome: "aborted" },
        observed.freshJournal
      )
    })
}

/**
 * Pins recorded-winner reconstruction under adversarially inverted timing.
 *
 * Governing design: `packages/testing/docs/concepts/engine-subject.md`, "Race
 * semantics".
 */
const recordedWinnerReplay: ConformanceCase = {
  name: recordedWinnerPin,
  run: (engine) =>
    Effect.gen(function*() {
      const observed = yield* runRace(recordedWinnerPin, "recorded-winner-replay", engine)
      yield* assert(
        recordedWinnerPin,
        observed.fresh.status === "suspended" && observed.frontierRuns === 2,
        "Replay must re-enter the suspended flow rather than hand back a terminal result, so the race is rebuilt from its journal.",
        { freshStatus: "suspended", frontierRuns: 2 },
        { freshStatus: observed.fresh.status, frontierRuns: observed.frontierRuns }
      )
      yield* assert(
        recordedWinnerPin,
        observed.replayed.status === "completed" && observed.replayed.value === "recorded-winner",
        "Replay must reconstruct the journaled winner instead of re-racing; the recorded loser is timed to win replay.",
        { status: "completed", value: "recorded-winner" },
        observed.replayed
      )
      yield* assert(
        recordedWinnerPin,
        observed.winnerRuns === 1 && observed.loserRuns === 1,
        "Replaying a recorded race must not invoke either branch closure again.",
        { winnerRuns: 1, loserRuns: 1 },
        {
          winnerRuns: observed.winnerRuns,
          loserRuns: observed.loserRuns
        }
      )
      const replayedPrefix = observed.replayedJournal.slice(0, observed.freshJournal.length)
      yield* assert(
        recordedWinnerPin,
        same(replayedPrefix, observed.freshJournal),
        "Replay must preserve the recorded decision and every journal entry the fresh race wrote.",
        observed.freshJournal,
        replayedPrefix
      )
      const resumedTail = observed.replayedJournal.slice(observed.freshJournal.length)
      yield* assert(
        recordedWinnerPin,
        resumedTail.length === 1 &&
          resumedTail[0]?.stepKey === observed.frontierKey &&
          resumedTail[0]?.outcome === "completed" &&
          same(resumedTail[0]?.value, observed.replayed.value),
        "Replay must journal only the resumed frontier, carrying the recorded winner it was handed.",
        [{ stepKey: observed.frontierKey, outcome: "completed", value: observed.replayed.value }],
        resumedTail
      )
    })
}

/**
 * Pins replay of the loser's recorded interruption.
 *
 * Governing design: `packages/testing/docs/concepts/engine-subject.md`, "Race
 * semantics".
 */
const recordedLoserInterruption: ConformanceCase = {
  name: recordedLoserPin,
  run: (engine) =>
    Effect.gen(function*() {
      const observed = yield* runRace(recordedLoserPin, "recorded-loser-interruption", engine)
      const freshLoser = observed.freshJournal.filter((entry) => entry.stepKey === observed.loserKey)
      const replayedLoser = observed.replayedJournal.filter((entry) => entry.stepKey === observed.loserKey)

      yield* assert(
        recordedLoserPin,
        freshLoser.length === 1 && freshLoser[0]?.outcome === "aborted",
        "The fresh loser must have one recorded interruption outcome.",
        [{ stepKey: observed.loserKey, outcome: "aborted" }],
        freshLoser
      )
      yield* assert(
        recordedLoserPin,
        same(freshLoser, replayedLoser),
        "Replaying the loser must yield its recorded interruption rather than executing it again.",
        freshLoser,
        replayedLoser
      )
      yield* assert(
        recordedLoserPin,
        observed.loserRuns === 1 && observed.loserInterruptions === 1,
        "Loser replay must not invoke or interrupt the branch closure a second time.",
        { loserRuns: 1, loserInterruptions: 1 },
        {
          loserRuns: observed.loserRuns,
          loserInterruptions: observed.loserInterruptions
        }
      )
    })
}

/**
 * Race interruption and deterministic replay conformance cases.
 *
 * Every case pins the contract in
 * `packages/testing/docs/concepts/engine-subject.md`, "Race semantics".
 *
 * @category conformance
 * @since 0.0.0
 */
export const cases: ReadonlyArray<ConformanceCase> = Object.freeze([
  loserInterrupted,
  recordedWinnerReplay,
  recordedLoserInterruption
])
