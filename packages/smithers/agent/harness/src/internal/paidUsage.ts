/**
 * The model usage a recorded boundary paid for, summed over its readings.
 *
 * @since 1.0.0-rc.1
 * @private
 */

import type * as ModelEvent from "@smthrs/model/ModelEvent"

/**
 * One reading's metered usage; absent when the transport reported none.
 *
 * @since 1.0.0-rc.1
 * @private
 */
export type Metered = { readonly inputTokens: number; readonly outputTokens: number } | undefined

/**
 * Sums the readings that were metered. `undefined` when none was: a reading
 * the transport did not meter is not a reading that cost zero.
 *
 * @since 1.0.0-rc.1
 * @private
 */
export const paidUsage = (readings: ReadonlyArray<Metered>): ModelEvent.Usage | undefined => {
  let paid: { inputTokens: number; outputTokens: number } | undefined
  for (const reading of readings) {
    if (reading === undefined) continue
    paid = {
      inputTokens: (paid?.inputTokens ?? 0) + reading.inputTokens,
      outputTokens: (paid?.outputTokens ?? 0) + reading.outputTokens
    }
  }
  return paid
}
