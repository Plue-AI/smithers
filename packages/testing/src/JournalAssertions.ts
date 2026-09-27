/**
 * Effect-valued assertions over a flow journal.
 *
 * @since 0.0.0
 */

import { isRecord } from "@smthrs/canonical/Record"
import * as Effect from "effect/Effect"
import type { JournalEntryLike } from "./EngineSubject.ts"
import { ExactlyOnceUnsupportedError, type JournalAssertionCode, JournalAssertionError } from "./TestingError.ts"

/**
 * A terminal outcome recorded by an engine journal.
 *
 * @category models
 * @since 0.0.0
 */
export type TerminalStatus = JournalEntryLike["outcome"]

/**
 * Fluent effect assertions for one journal.
 *
 * @category models
 * @since 0.0.0
 */
export interface JournalExpectations {
  readonly executed: (stepKey: string) => Effect.Effect<void, JournalAssertionError>
  /**
   * Asserts the keys appear as a **subsequence** of the journal: every key in
   * turn, in this relative order, with any other entries allowed between and
   * around them. It is not a contiguous or an exhaustive match.
   */
  readonly executedInOrder: (keys: ReadonlyArray<string>) => Effect.Effect<void, JournalAssertionError>
  /** Asserts the outcome of the entry with the highest `index`. */
  readonly terminal: (status: TerminalStatus) => Effect.Effect<void, JournalAssertionError>
  /**
   * Assertions about the journaled external **effect** entries under `key`.
   * An ordinary step entry sharing the key never satisfies them: it fails with
   * `effect_kind_mismatch`.
   */
  readonly effect: (key: string) => EffectExpectations
  /** The entries whose `index` is at most `untilIndex`, in index order. */
  readonly prefix: (untilIndex: number) => ReadonlyArray<JournalEntryLike>
}

/**
 * Fluent effect assertions for one effect key in a journal.
 *
 * @category models
 * @since 0.0.0
 */
export interface EffectExpectations {
  readonly atLeastOnce: () => Effect.Effect<void, JournalAssertionError>
  readonly journaledAtMostOnce: () => Effect.Effect<void, JournalAssertionError>
  readonly idempotencyKey: (key: string) => Effect.Effect<void, JournalAssertionError>
  /**
   * Always fails: an engine can prove at-least-once delivery and at-most-once
   * journaling, but it cannot prove exactly-once external effect execution.
   * Keeping this method deliberately failing prevents test vocabulary from
   * claiming a guarantee the engine does not provide.
   *
   * @since 0.0.0
   * @category assertions
   */
  readonly exactlyOnce: () => Effect.Effect<void, ExactlyOnceUnsupportedError>
}

const failure = (
  code: JournalAssertionCode,
  message: string,
  expected: unknown,
  actual?: unknown
): Effect.Effect<never, JournalAssertionError> =>
  Effect.fail(
    new JournalAssertionError({
      code,
      message,
      expected,
      ...(actual === undefined ? {} : { actual })
    })
  )

const idempotencyKeyOf = (entry: JournalEntryLike): unknown =>
  isRecord(entry.value) ? entry.value.idempotencyKey : undefined

/**
 * A journaled external effect, as distinct from an ordinary step. The
 * `EffectExpectations` vocabulary answers about these entries only, so an
 * engine that journaled no effect can never satisfy an at-most-once claim.
 */
const isEffectEntry = (entry: JournalEntryLike): boolean => entry.kind === "effect"

/**
 * Builds fluent, Effect-valued assertions over journal entries.
 *
 * Entries are read in `entry.index` order rather than in the order the caller
 * supplied them. `JournalEntryLike` carries an explicit `index` precisely
 * because ordering is data: an engine that reads its journal from a store with
 * no `ORDER BY`, or a caller that filtered and re-concatenated, hands over the
 * same entries in another order, and every assertion here must still answer
 * about the same entry.
 *
 * @category assertions
 * @since 0.0.0
 */
export const expectJournal = (unordered: ReadonlyArray<JournalEntryLike>): JournalExpectations => {
  const entries = [...unordered].sort((left, right) => left.index - right.index)
  const presentKeys = entries.map((entry) => entry.stepKey)
  const effect = (key: string): EffectExpectations => {
    const named = entries.filter((entry) => entry.stepKey === key)
    const matching = named.filter(isEffectEntry)
    const notAnEffect = () =>
      failure(
        "effect_kind_mismatch",
        `expected ${JSON.stringify(key)} to be journaled as an effect; found ${
          named.map((entry) => JSON.stringify(entry.kind)).join(", ")
        }`,
        "effect",
        named.map((entry) => entry.kind)
      )
    const notExecuted = () =>
      failure(
        "effect_not_executed",
        `expected effect ${JSON.stringify(key)} to execute at least once`,
        key,
        presentKeys
      )
    return {
      atLeastOnce: () =>
        matching.length > 0
          ? Effect.void
          : named.length > 0
          ? notAnEffect()
          : notExecuted(),
      // A journal that carries the key only as an ordinary step is refused
      // here too. It used to answer `Success`, because zero effect entries is
      // trivially "at most once", so a test could claim an at-most-once
      // external effect was journaled when the engine journaled no effect at
      // all under that key -- the exact claim this vocabulary exists to make.
      // A key that appears nowhere still satisfies the claim: nothing was
      // journaled more than once.
      journaledAtMostOnce: () =>
        matching.length === 0 && named.length > 0
          ? notAnEffect()
          : matching.length <= 1
          ? Effect.void
          : failure(
            "effect_journaled_more_than_once",
            `expected effect ${JSON.stringify(key)} to be journaled at most once; found ${matching.length}`,
            1,
            matching.length
          ),
      // Three outcomes, three codes. `missing_idempotency_key` used to fire
      // when the effect never ran, which is `effect_not_executed`, and an
      // entry that carried no key at all reported a mismatch against a key it
      // never had. A consumer matching on codes could separate none of them.
      idempotencyKey: (idempotencyKey) => {
        if (matching.length === 0) return named.length > 0 ? notAnEffect() : notExecuted()
        const absent = matching.find((entry) => idempotencyKeyOf(entry) === undefined)
        if (absent !== undefined) {
          return failure(
            "missing_idempotency_key",
            `expected effect ${JSON.stringify(key)} to carry idempotency key ${
              JSON.stringify(idempotencyKey)
            }; the entry carries none`,
            idempotencyKey,
            presentKeys
          )
        }
        const mismatch = matching.find((entry) => idempotencyKeyOf(entry) !== idempotencyKey)
        return mismatch === undefined
          ? Effect.void
          : failure(
            "idempotency_key_mismatch",
            `expected effect ${JSON.stringify(key)} to have idempotency key ${JSON.stringify(idempotencyKey)}`,
            idempotencyKey,
            idempotencyKeyOf(mismatch)
          )
      },
      exactlyOnce: () =>
        Effect.fail(
          new ExactlyOnceUnsupportedError({
            message: `exactly-once is unsupported for effect ${JSON.stringify(key)}`
          })
        )
    }
  }

  return {
    executed: (stepKey) =>
      entries.some((entry) => entry.stepKey === stepKey)
        ? Effect.void
        : failure("step_not_executed", `expected step ${JSON.stringify(stepKey)} to execute`, stepKey, presentKeys),
    executedInOrder: (keys) => {
      let cursor = 0
      for (const entry of entries) {
        if (entry.stepKey === keys[cursor]) {
          cursor += 1
        }
      }
      return cursor === keys.length
        ? Effect.void
        : failure(
          "execution_order_mismatch",
          `expected steps to execute in order: ${keys.map((key) => JSON.stringify(key)).join(", ")}`,
          keys,
          entries.map((entry) => entry.stepKey)
        )
    },
    terminal: (status) => {
      const entry = entries.at(-1)
      return entry?.outcome === status
        ? Effect.void
        : failure(
          "terminal_status_mismatch",
          `expected terminal status ${JSON.stringify(status)}, received ${JSON.stringify(entry?.outcome)}`,
          status,
          entry?.outcome
        )
    },
    effect,
    prefix: (untilIndex) => entries.filter((entry) => entry.index <= untilIndex)
  }
}
