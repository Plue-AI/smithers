/** Timing and retention shared by persisted GUI and projected terminal notices.
 * @since 0.1.0
 */

/** Delay before unfinished work appears in either client's toast stack.
 * @category constants
 * @since 0.1.0
 */
export const WORK_NOTICE_DELAY_MS = 300

/** How long a successful or cancelled notice remains after settlement.
 * @category constants
 * @since 0.1.0
 */
export const NOTICE_SETTLE_MS = 4000

/** A failed notice needs a human dismissal unless its caller explicitly overrides it.
 * @category timing
 * @since 0.1.0
 */
export const noticeDismissDelay = (status: string, settleMs = NOTICE_SETTLE_MS, overrideMs?: number): number | undefined =>
  overrideMs ?? (status === "failed" ? undefined : settleMs)

/** A failure is always visible; successful work below the debounce never flashes.
 * @category predicates
 * @since 0.1.0
 */
export const shouldShowSettlement = (failed: boolean, shown: boolean): boolean => failed || shown

/** Project work through launch, execution and real settlement; failures have no expiry.
 * @category predicates
 * @since 0.1.0
 */
export const workNoticeVisible = (work: {
  readonly startedAt: number
  readonly endedAt?: number
  readonly status: string
}, now: number): boolean => {
  if (work.status === "failed") return shouldShowSettlement(true, false)
  if (work.endedAt === undefined) return now - work.startedAt >= WORK_NOTICE_DELAY_MS
  return shouldShowSettlement(false, work.endedAt - work.startedAt >= WORK_NOTICE_DELAY_MS) &&
    now - work.endedAt < NOTICE_SETTLE_MS
}
