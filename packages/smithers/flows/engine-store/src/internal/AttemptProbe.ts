/**
 * Survivor discovery for an action key's attempt rows.
 *
 * Two implementations answer the same question — the durable state's single
 * ordered range read (issue #77) and the point-probe walk against
 * `AttemptStore` for storage that cannot range-scan. They are kept here
 * together, behind one entry point, because their answers must agree: a run
 * that resumes under SQL state and under the fallback must restore the same
 * retry origin and the same attempt counter (issue #96).
 *
 * @since 0.1.0
 */

import type { AttemptStore } from "@smthrs/run-store"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import type * as DurableEngineState from "../DurableEngineState.ts"

/**
 * How long a pruned leading run of attempt numbers the survivor scan
 * tolerates before it reports "no attempt row survives".
 *
 * A retention/prune job removes attempts oldest-first, so a surviving
 * sequence is contiguous once its first row is found; the bound caps the
 * pruned prefix walk (issue #69). It is a *semantic* bound, not merely a
 * cost bound: the point-probe fallback cannot distinguish "nothing ever ran"
 * from "the first 33 attempts were pruned" without a range read, so both
 * paths apply the same tolerance and a key whose earliest survivor sits past
 * it restarts its expiration budget and attempt numbering on either backend
 * (issue #96). Restarting is safe — the pruned numbers are gone, so the
 * fresh counter cannot collide — and, unlike the previous split, it is the
 * same behaviour on every backend.
 *
 * @since 0.1.0
 * @category constants
 */
export const prunedPrefixScanLimit = 32

/**
 * Finds the surviving attempt rows for an action key: the earliest row's
 * start time — the durable retry origin when attempt 1 itself was pruned
 * (issue #69) — and the highest attempt number contiguous from it, from
 * which the engine resumes the attempt counter (issue #59). `Option.none()`
 * means no attempt row survives within `prunedPrefixScanLimit`.
 *
 * When the durable state can range-scan attempts, one ordered SELECT answers
 * both questions (issue #77); otherwise the point-read scan against
 * `AttemptStore` answers them, paying up to `prunedPrefixScanLimit`
 * sequential gets for a key that never ran. Both answers pass through the
 * same tolerance check, so the two paths cannot diverge (issue #96).
 *
 * @since 0.1.0
 * @category combinators
 */
export const probeAttempts = (
  attemptStore: AttemptStore.Service,
  survivors: DurableEngineState.Service["attemptSurvivors"],
  runId: string,
  stepKeyDigest: string
): Effect.Effect<Option.Option<DurableEngineState.AttemptSurvivors>> =>
  Effect.gen(function*() {
    if (survivors !== undefined) {
      const found = yield* survivors(runId, stepKeyDigest)
      if (Option.isNone(found)) return Option.none()
      return found.value.earliestAttempt > prunedPrefixScanLimit
        ? Option.none()
        : found
    }
    let earliest = Option.none<AttemptStore.Attempt>()
    let attempt = 1
    for (; attempt <= prunedPrefixScanLimit; attempt++) {
      const row = yield* attemptStore.get({ runId, stepKeyDigest, attempt }).pipe(Effect.orDie)
      if (Option.isSome(row)) {
        earliest = row
        break
      }
    }
    if (Option.isNone(earliest)) return Option.none()
    let latest = attempt
    for (let next = attempt + 1;; next++) {
      const row = yield* attemptStore.get({ runId, stepKeyDigest, attempt: next }).pipe(Effect.orDie)
      if (Option.isNone(row)) break
      latest = next
    }
    return Option.some({
      earliestAttempt: attempt,
      earliestStartedAtMs: earliest.value.startedAtMs,
      latest
    })
  })
