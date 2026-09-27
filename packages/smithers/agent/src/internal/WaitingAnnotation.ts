/**
 * Classify durable waits from approval state and pending timers.
 * @since 1.0.0
 */

/**
 * Preserve a parked timer's earliest durable wake when an engine poll arrives
 * before a control resume. An approval stays classified as an approval even
 * when a stale clock row remains.
 *
 * @since 1.0.0-rc.1
 * @category utilities
 */
export const waitingAnnotation = (
  status: string,
  clocks: ReadonlyArray<{ readonly dueAtMs: number }>
): { readonly reason: "approval" | "timer" | "event"; readonly wakeAt?: number } => ({
  reason: status === "waiting-approval" ? "approval" : clocks.length > 0 ? "timer" : "event",
  ...(clocks.length > 0 ? { wakeAt: Math.min(...clocks.map((clock) => clock.dueAtMs)) } : {})
})
