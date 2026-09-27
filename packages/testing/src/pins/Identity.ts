/**
 * Execution and step identity conformance pins.
 *
 * Manifest: `packages/testing/test/support/ParityManifest.ts`.
 *
 * @since 0.0.0
 */

import * as Effect from "effect/Effect"
import type { ConformanceCase } from "../Conformance.ts"
import type { FlowSpec, JournalEntryLike, StepSpec } from "../EngineSubject.ts"
import { assert, invoke } from "../internal/Pin.ts"
import { same } from "../internal/Structural.ts"

const distinctExecutionsPin = "identity/distinct-executions"
const idempotencyPin = "identity/idempotency-key"
const digestPin = "identity/digest-key-stability"

const completedFor = (
  journal: ReadonlyArray<JournalEntryLike>,
  stepKey: string
): ReadonlyArray<JournalEntryLike> =>
  journal.filter((entry) => entry.stepKey === stepKey && entry.outcome === "completed")

const distinctExecutions: ConformanceCase = {
  name: distinctExecutionsPin,
  run: (engine) =>
    Effect.gen(function*() {
      let invocations = 0
      const stepKey = "identity/distinct/step"
      const flow: FlowSpec = {
        name: "testing/identity/distinct",
        steps: [{
          key: stepKey,
          sealed: false,
          kind: "step",
          run: () =>
            Effect.sync(() => {
              invocations += 1
              return `invocation-${invocations}`
            })
        }]
      }
      const payload = { command: "same-payload" }

      const first = yield* invoke(distinctExecutionsPin, "run(first)", () => engine.run({ flow, payload }))
      const firstJournal = yield* invoke(
        distinctExecutionsPin,
        "journal(first)",
        () => engine.journal(first.executionId)
      )
      const second = yield* invoke(distinctExecutionsPin, "run(second)", () => engine.run({ flow, payload }))
      const secondJournal = yield* invoke(
        distinctExecutionsPin,
        "journal(second)",
        () => engine.journal(second.executionId)
      )

      yield* assert(
        distinctExecutionsPin,
        first.executionId !== second.executionId,
        "Runs with the same payload and no idempotency key must receive distinct execution ids.",
        "two distinct execution ids",
        [first.executionId, second.executionId]
      )
      yield* assert(
        distinctExecutionsPin,
        invocations === 2,
        "Runs without an idempotency key must execute independently.",
        2,
        invocations
      )
      const firstEntries = completedFor(firstJournal, stepKey)
      const secondEntries = completedFor(secondJournal, stepKey)
      yield* assert(
        distinctExecutionsPin,
        firstEntries.length === 1 && secondEntries.length === 1,
        "Each execution must own a completed journal entry for the step.",
        [1, 1],
        [firstEntries.length, secondEntries.length]
      )
      yield* assert(
        distinctExecutionsPin,
        !same(firstJournal, secondJournal),
        "Distinct executions must retain distinct behavior-bearing journals.",
        "different journal values",
        [firstJournal, secondJournal]
      )
    })
}

const idempotentExecutions: ConformanceCase = {
  name: idempotencyPin,
  run: (engine) =>
    Effect.gen(function*() {
      let invocations = 0
      const flow: FlowSpec = {
        name: "testing/identity/idempotent",
        steps: [{
          key: "identity/idempotent/step",
          sealed: false,
          kind: "step",
          run: () =>
            Effect.sync(() => {
              invocations += 1
              return { invocations }
            })
        }]
      }
      const options = {
        flow,
        payload: { command: "same-payload" },
        idempotencyKey: "identity/idempotent/shared"
      }

      const first = yield* invoke(idempotencyPin, "run(first)", () => engine.run(options))
      const firstJournal = yield* invoke(idempotencyPin, "journal(first)", () => engine.journal(first.executionId))
      const second = yield* invoke(idempotencyPin, "run(second)", () => engine.run(options))
      const secondJournal = yield* invoke(idempotencyPin, "journal(second)", () => engine.journal(second.executionId))

      yield* assert(
        idempotencyPin,
        first.executionId === second.executionId,
        "Runs with the same idempotency key must join the same execution.",
        first.executionId,
        second.executionId
      )
      yield* assert(
        idempotencyPin,
        invocations === 1,
        "Joining an idempotent execution must not re-execute its steps.",
        1,
        invocations
      )
      yield* assert(
        idempotencyPin,
        same(first, second),
        "Joined runs must expose the same execution result.",
        first,
        second
      )
      yield* assert(
        idempotencyPin,
        same(firstJournal, secondJournal),
        "Joined runs must expose the same journal.",
        firstJournal,
        secondJournal
      )
    })
}

const digestKeyStability: ConformanceCase = {
  name: digestPin,
  run: (engine) =>
    Effect.gen(function*() {
      let sealedInvocations = 0
      let unsealedInvocations = 0
      const sealedDigest = "identity/digest/sealed-content"
      const unsealedKey = "identity/digest/unsealed-call"
      const sealedAlias = (): StepSpec => ({
        key: sealedDigest,
        sealed: true,
        kind: "step",
        run: (input) =>
          Effect.sync(() => {
            sealedInvocations += 1
            return input
          })
      })
      const unsealedDuplicate = (): StepSpec => ({
        key: unsealedKey,
        sealed: false,
        kind: "step",
        run: (input) =>
          Effect.sync(() => {
            unsealedInvocations += 1
            return input
          })
      })
      const flow: FlowSpec = {
        name: "testing/identity/digest-key-stability",
        // The sealed aliases intentionally share a content digest despite
        // their separated positions. The unsealed calls intentionally share
        // a declared key and rely on occurrence identity.
        steps: [
          sealedAlias(),
          unsealedDuplicate(),
          sealedAlias(),
          unsealedDuplicate()
        ]
      }

      const result = yield* invoke(digestPin, "run", () =>
        engine.run({
          flow,
          payload: { command: "digest-tripwire" },
          executionId: "testing/identity/digest-key-stability/execution"
        }))
      const journal = yield* invoke(digestPin, "journal", () => engine.journal(result.executionId))
      const sealedEntries = completedFor(journal, sealedDigest)
      const unsealedEntries = completedFor(journal, unsealedKey)

      yield* assert(
        digestPin,
        result.status === "completed",
        "The digest-key flow must complete.",
        "completed",
        result.status
      )
      yield* assert(
        digestPin,
        sealedInvocations === 1,
        "Renamed or reordered sealed aliases with the same digest must reuse the recorded result.",
        1,
        sealedInvocations
      )
      yield* assert(
        digestPin,
        sealedEntries.length === 1,
        "A sealed digest must produce one behavior-relevant journal identity.",
        1,
        sealedEntries.length
      )
      yield* assert(
        digestPin,
        unsealedInvocations === 2,
        "Duplicate unsealed steps must execute separately.",
        2,
        unsealedInvocations
      )
      yield* assert(
        digestPin,
        unsealedEntries.length === 2,
        "Duplicate unsealed steps must retain separate journal outcomes.",
        2,
        unsealedEntries.length
      )
    })
}

/**
 * Execution identity, idempotency, and digest-key conformance cases.
 *
 * @category conformance
 * @since 0.0.0
 */
export const cases: ReadonlyArray<ConformanceCase> = Object.freeze([
  distinctExecutions,
  idempotentExecutions,
  digestKeyStability
])
