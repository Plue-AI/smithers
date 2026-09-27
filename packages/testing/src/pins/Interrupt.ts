/**
 * Fiber interruption conformance pins.
 *
 * Manifest: `packages/testing/test/support/ParityManifest.ts`.
 *
 * @since 0.0.0
 */

import { isRecord } from "@smthrs/canonical/Record"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import type * as Fiber from "effect/Fiber"
import * as Latch from "effect/Latch"
import * as Ref from "effect/Ref"
import type { ConformanceCase } from "../Conformance.ts"
import type { ExecutionResult, FlowSpec, JournalEntryLike } from "../EngineSubject.ts"
import * as Pin from "../internal/Pin.ts"

const interruptPin = "interrupt/fiber-abort"

// This module runs a single pin, so the shared helpers are bound to its name
// once instead of threading it through every call site.
const fail = (message: string, expected?: unknown, actual?: unknown) =>
  Pin.fail(interruptPin, message, expected, actual)

const assert = (condition: boolean, message: string, expected?: unknown, actual?: unknown) =>
  Pin.assert(interruptPin, condition, message, expected, actual)

const invoke = <A, E>(operation: string, evaluate: () => Effect.Effect<A, E>): Effect.Effect<A, E> =>
  Pin.invoke(interruptPin, operation, evaluate)

const waitUntil = (predicate: () => boolean, message: string) => Pin.waitUntil(interruptPin, predicate, message)

const awaitFiber = <A, E>(fiber: Fiber.Fiber<A, E>, message: string) => Pin.awaitFiber(interruptPin, fiber, message)

const isWellFormedEntry = (value: unknown): value is JournalEntryLike =>
  isRecord(value) &&
  typeof value.index === "number" &&
  Number.isInteger(value.index) && value.index >= 0 &&
  typeof value.stepKey === "string" && value.stepKey.length > 0 &&
  typeof value.kind === "string" && value.kind.length > 0 &&
  (value.outcome === "completed" || value.outcome === "aborted" ||
    value.outcome === "failed" || value.outcome === "suspended")

const isExecutionResult = (value: unknown): value is ExecutionResult =>
  isRecord(value) &&
  typeof value.executionId === "string" &&
  (value.status === "completed" || value.status === "aborted" ||
    value.status === "failed" || value.status === "suspended")

const isJournal = (value: unknown): value is ReadonlyArray<JournalEntryLike> =>
  Array.isArray(value) &&
  value.every((entry, index) => isWellFormedEntry(entry) && entry.index === index)

const interruptInFlight: ConformanceCase = {
  name: interruptPin,
  run: (engine) =>
    Effect.gen(function*() {
      const executionId = "testing/interrupt/in-flight/execution"
      const stepKey = "interrupt/in-flight/step"
      const started = yield* Latch.make()
      const release = yield* Latch.make()
      const observedInterruption = yield* Ref.make(false)
      const flow: FlowSpec = {
        name: "testing/interrupt/in-flight",
        steps: [{
          key: stepKey,
          sealed: false,
          kind: "step",
          run: () =>
            Effect.onInterrupt(
              Effect.andThen(started.open, release.await),
              () => Ref.set(observedInterruption, true)
            )
        }]
      }
      const virtualTimeBefore = yield* Clock.currentTimeMillis
      const runFiber = yield* invoke("run(fork)", () =>
        engine.run({
          flow,
          payload: { command: "wait" },
          executionId
        })).pipe(Effect.forkChild({ startImmediately: true }))

      yield* waitUntil(
        () => started.isOpen(),
        "The subject did not start the in-flight step promptly."
      )

      const interruptFiber = yield* invoke(
        "interrupt(fork)",
        () => engine.interrupt(executionId)
      ).pipe(Effect.forkChild({ startImmediately: true }))
      const interruptExit = yield* awaitFiber(
        interruptFiber,
        "Interrupt did not settle promptly; a retry-on-interrupt storm may be active."
      )
      yield* assert(
        Exit.isSuccess(interruptExit),
        "Interrupt failed instead of settling successfully.",
        "successful interrupt",
        interruptExit
      )

      const runExit = yield* awaitFiber(
        runFiber,
        "The interrupted execution did not settle promptly."
      )
      if (Exit.isFailure(runExit)) {
        return yield* fail(
          "The interrupted execution escaped as a failure or defect instead of an aborted result.",
          { executionId, status: "aborted" },
          runExit.cause
        )
      }
      const runResult: unknown = runExit.value
      if (!isExecutionResult(runResult)) {
        return yield* fail(
          "The interrupted execution returned a malformed result.",
          { executionId, status: "aborted" },
          runResult
        )
      }
      const storedResult: unknown = yield* invoke("result", () => engine.result(executionId))
      if (!isExecutionResult(storedResult)) {
        return yield* fail(
          "The interrupted execution stored a malformed result.",
          { executionId, status: "aborted" },
          storedResult
        )
      }
      const journal: unknown = yield* invoke("journal", () => engine.journal(executionId))
      if (!isJournal(journal)) {
        return yield* fail(
          "Interruption left a malformed journal transcript.",
          "contiguous, well-formed journal entries",
          journal
        )
      }
      const virtualTimeAfter = yield* Clock.currentTimeMillis
      const interruptionObserved = yield* Ref.get(observedInterruption)

      yield* assert(
        runResult.executionId === executionId && runResult.status === "aborted",
        "The in-flight run must settle as a well-formed aborted result.",
        { executionId, status: "aborted" },
        runResult
      )
      yield* assert(
        storedResult.executionId === executionId && storedResult.status === "aborted",
        "The stored result must remain a well-formed aborted result.",
        { executionId, status: "aborted" },
        storedResult
      )
      yield* assert(
        interruptionObserved,
        "EngineSubject.interrupt must interrupt the running step fiber.",
        true,
        interruptionObserved
      )
      yield* assert(
        journal.some((entry) => entry.stepKey === stepKey && entry.outcome === "aborted"),
        "The journal must record the interrupted step as an aborted outcome.",
        { stepKey, outcome: "aborted" },
        journal
      )
      yield* assert(
        virtualTimeAfter === virtualTimeBefore,
        "Interrupt handling must not advance TestClock through a retry storm.",
        virtualTimeBefore,
        virtualTimeAfter
      )
    })
}

/**
 * In-flight fiber interruption conformance cases.
 *
 * @category conformance
 * @since 0.0.0
 */
export const cases: ReadonlyArray<ConformanceCase> = Object.freeze([interruptInFlight])
