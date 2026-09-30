/**
 * The model usage a recorded boundary paid for, summed over its readings.
 *
 * @since 1.0.0-rc.1
 * @private
 */

import type * as EngineLike from "../EngineLike.ts"

/**
 * One reading's metered usage and the model that read it; absent when the
 * transport reported none.
 *
 * @since 1.0.0-rc.1
 * @private
 */
export type Metered =
  | { readonly inputTokens: number; readonly outputTokens: number; readonly modelId?: string | undefined }
  | undefined

/**
 * Sums the readings that were metered, one share per model in the order each
 * model first read. `undefined` when none was: a reading the transport did not
 * meter is not a reading that cost zero.
 *
 * @since 1.0.0-rc.1
 * @private
 */
export const paidUsage = (readings: ReadonlyArray<Metered>): ReadonlyArray<EngineLike.Paid> | undefined => {
  const shares = new Map<string | undefined, { inputTokens: number; outputTokens: number }>()
  for (const reading of readings) {
    if (reading === undefined) continue
    const share = shares.get(reading.modelId)
    shares.set(reading.modelId, {
      inputTokens: (share?.inputTokens ?? 0) + reading.inputTokens,
      outputTokens: (share?.outputTokens ?? 0) + reading.outputTokens
    })
  }
  if (shares.size === 0) return undefined
  return [...shares].map(([modelId, usage]) => modelId === undefined ? { usage } : { usage, modelId })
}
