/**
 * What the fork-overridden record says about a fork override.
 *
 * The record names which edit the child was created with, never the edited
 * value itself: the journal is observability, while the value is executable
 * state that lives on the child's run row or attempt row. Both stores refuse
 * an override through the same rule.
 *
 * @since 1.0.0
 */

import type { Frame } from "../Frame.ts"
import { error, type TimeTravelError } from "../TimeTravelError.ts"
import { forkOverrideMessage } from "../TimeTravelStore.ts"
import type * as TimeTravelStore from "../TimeTravelStore.ts"

/**
 * The fork-overridden payload for an override.
 *
 * @since 1.0.0
 * @category constructors
 */
export const payload = (childRunId: string, override: TimeTravelStore.ForkOverride) =>
  override._tag === "SealedResult"
    ? { childRunId, _tag: override._tag, stepKeyDigest: override.stepKeyDigest }
    : { childRunId, _tag: override._tag }

/**
 * One attempt lifecycle record in the prefix a fork copies.
 *
 * @since 1.0.0
 * @category models
 */
export interface AttemptRecord {
  readonly seq: number
  readonly payload: unknown
}

const digestOf = (payload: unknown): unknown =>
  typeof payload === "object" && payload !== null ? (payload as { stepKeyDigest?: unknown }).stepKeyDigest : undefined

/**
 * Refuses an input override once any step has started at the frame.
 *
 * @since 1.0.0
 * @category constructors
 */
export const inputRefusal = (parentRunId: string, startedAttempts: number): TimeTravelError | undefined =>
  startedAttempts === 0
    ? undefined
    : error("invalid", `an input override needs a frame of ${parentRunId} before its first step started`)

/**
 * Refuses an override the copied prefix would contradict.
 *
 * Step keys are ordinal: they name a dispatch site, not the value it read.
 * A step that started after the overridden step finished may have read the
 * old result, and a child would replay its recorded outcome as if it had read
 * the new one. Likewise every step already started at the frame ran against
 * the old input. Both are refused, so a child never mixes an edit with
 * results computed without it; the frame the step finished at, or a frame
 * before any step started, is always admissible.
 *
 * @since 1.0.0
 * @category constructors
 */
export const refusal = (
  parentRunId: string,
  frame: Frame,
  override: TimeTravelStore.ForkOverride,
  started: ReadonlyArray<AttemptRecord>,
  finished: ReadonlyArray<AttemptRecord>
): TimeTravelError | undefined => {
  if (override._tag === "Input") return inputRefusal(parentRunId, started.length)
  const settled = finished.find((record) =>
    digestOf(record.payload) === override.stepKeyDigest &&
    (record.payload as { state?: unknown }).state === "succeeded"
  )
  if (settled === undefined) {
    return error("not_found", forkOverrideMessage(parentRunId, frame, override.stepKeyDigest))
  }
  const later = started.find((record) =>
    record.seq > settled.seq && digestOf(record.payload) !== override.stepKeyDigest
  )
  return later === undefined
    ? undefined
    : error(
      "invalid",
      `step ${override.stepKeyDigest} was followed by a step at seq ${later.seq}; fork at seq ${settled.seq} to override it`
    )
}
