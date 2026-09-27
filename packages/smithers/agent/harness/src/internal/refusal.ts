/**
 * The one constructor for a refusal a cell observes as a resolved envelope.
 *
 * A failed call **resolves** with a `failure` `Cell.CallResult`; it does not
 * throw, and `Cell.callFailure` renders it as `{ ok: false, error }`. The shape
 * is fixed — `value` is always `null`, because a refusal has no value to hand
 * back — so every boundary that refuses a call builds it here rather than
 * repeating the literal. An absent `code` is left absent rather than written as
 * `undefined`: the encoded result is the durable wire contract used in sealed
 * keys, and it means {@link Cell.defaultCallFailureCode}.
 *
 * @since 1.0.0-rc.0
 * @private
 */

import { type CallFailureCode, CallResult } from "../Cell.ts"

/**
 * A refusal the cell observes as a resolved `{ ok: false, error }` envelope.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const refusal = (code: CallFailureCode | undefined, message: string): CallResult =>
  code === undefined
    ? new CallResult({ outcome: "failure", value: null, message })
    : new CallResult({ outcome: "failure", value: null, code, message })
