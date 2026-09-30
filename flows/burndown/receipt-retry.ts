import type { LandReport, Ready, ReceiptRetry } from "./schema.ts"

/** Three failed delivery/verification attempts, then an explicit operator retry. */
export const advanceReceiptRetries = (
  previous: ReadonlyArray<ReceiptRetry>,
  ready: ReadonlyArray<Ready>,
  report: Pick<LandReport, "landed" | "quarantined" | "refused" | "receiptsPending" | "incomplete" | "resumed">
): ReadonlyArray<ReceiptRetry> => {
  const pending = [...(report.receiptsPending ?? []), ...(report.incomplete ?? [])]
  const failed = new Set(pending.map((item) => item.key))
  const terminal = new Set([
    ...report.landed,
    ...report.quarantined.map((item) => item.key),
    ...(report.refused ?? []).map((item) => item.key)
  ])
  const records = previous.filter((item) => !terminal.has(item.key) || failed.has(item.key))
  const next = new Map(records.map((item) => [item.key, item]))
  for (const failure of pending) {
    const member = ready.find((item) => item.assignment.key === failure.key)
    if (member === undefined) continue
    const prior = next.get(failure.key)
    const attempts = Math.min(3, (report.resumed?.includes(failure.key) ? 0 : prior?.attempts ?? 0) + 1)
    const receipt = prior?.receipt ?? report.receiptsPending?.find((item) => item.key === failure.key)?.receipt
    next.set(failure.key, {
      key: failure.key,
      ready: prior?.ready ?? member,
      attempts,
      status: attempts >= 3 || report.incomplete?.some((item) => item.key === failure.key) ||
          failure.error.includes("REVIEW_INPUT_INCOMPLETE") ?
        "parked" :
        "retry",
      error: failure.error,
      ...(receipt === undefined ? {} : { receipt })
    })
  }
  return [...next.values()]
}
