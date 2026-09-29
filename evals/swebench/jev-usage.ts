/**
 * Where a journal keeps what a Jev reading cost, and who asked for it.
 *
 * Four callers meter Jev: `claim-demanded` for the completion brake,
 * `supervisor-settled` for the per-frame supervisor, a `cell-call-settled` of
 * the `jev` flow for an agent's own call, whose usage sits inside the recorded
 * call result, and a `decision-settled` of a gate classifier, which carries
 * its own usage. The brake's and the supervisor's `decision-settled` repeat a
 * reading already metered above and are never priced. `scorecard.ts` and
 * `lib/run-cost.mjs` both read through here, so the scorecard and the full
 * benchmark's ledger cannot disagree about what a reading cost.
 *
 * @since 0.1.0
 */

/**
 * The event types that can carry Jev usage.
 *
 * @category constants
 * @since 0.1.0
 */
export const jevSources: ReadonlySet<string> = new Set([
  "control.agent.claim-demanded",
  "control.agent.supervisor-settled",
  "control.agent.cell-call-settled",
  "control.agent.decision-settled"
])

/**
 * The classifier ids whose `decision-settled` is the only record of a gate's
 * Jev reading.
 *
 * @category constants
 * @since 0.1.0
 */
export const jevGateClassifiers: ReadonlySet<string> = new Set([
  "relevance/unnecessary",
  "compaction/marks",
  "seat/route"
])

/**
 * Who took one Jev reading.
 *
 * @category models
 * @since 0.1.0
 */
export type JevCaller = "cell" | "brake" | "supervisor" | "gate"

/**
 * One Jev reading's token counts.
 *
 * @category models
 * @since 0.1.0
 */
export interface JevUsage {
  readonly inputTokens: number
  readonly outputTokens: number
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined

const count = (value: unknown): number => typeof value === "number" ? value : 0

/**
 * The caller one journal row is a Jev reading for, or nothing when the row is
 * not one. A `decision-settled` of any classifier but a gate repeats a
 * reading another row already records.
 *
 * @category conversions
 * @since 0.1.0
 */
export const jevCaller = (eventType: string, payload: Record<string, unknown>): JevCaller | undefined => {
  switch (eventType) {
    case "control.agent.cell-call-settled":
      return payload.flowName === "jev" ? "cell" : undefined
    case "control.agent.claim-demanded":
      return "brake"
    case "control.agent.supervisor-settled":
      return "supervisor"
    case "control.agent.decision-settled":
      return typeof payload.classifier === "string" && jevGateClassifiers.has(payload.classifier) ? "gate" : undefined
    default:
      return undefined
  }
}

/**
 * The Jev usage one journal row records, or nothing when the row is not a
 * Jev reading. A `jev` flow call that failed records no usage and is not a
 * call Jev answered; one that settled without usage is a call the transport
 * did not meter, counted but priced at zero tokens. A malformed count is
 * handed back as it stands so the caller can refuse it rather than read it
 * as zero.
 *
 * @category conversions
 * @since 0.1.0
 */
export const jevUsageOf = (eventType: string, payload: Record<string, unknown>): JevUsage | undefined => {
  const caller = jevCaller(eventType, payload)
  if (caller === undefined) return undefined
  if (caller === "cell") {
    if (payload.outcome !== "success") return undefined
    const value = record(payload.value)
    if (value?.truncated === true) return undefined
    const usage = record(value?.usage)
    return { inputTokens: count(usage?.inputTokens), outputTokens: count(usage?.outputTokens) }
  }
  const usage = record(payload.usage)
  return { inputTokens: count(usage?.inputTokens), outputTokens: count(usage?.outputTokens) }
}

/**
 * How many questions a successful `jev` call's recorded result answered, or
 * nothing when the journal bounded that result to a marker and the count is
 * unknown.
 *
 * @category conversions
 * @since 0.1.0
 */
export const jevCellQuestionsOf = (payload: Record<string, unknown>): number | undefined => {
  const answers = record(record(payload.value)?.answers)
  return answers === undefined ? undefined : Object.keys(answers).length
}
