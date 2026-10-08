/**
 * Classify durable waits from approval state and pending timers.
 * @since 1.0.0
 */

/**
 * Preserve a parked timer's earliest durable wake when an engine poll arrives
 * before a control resume. A named event retains its own gate when a child
 * question rolls up the control status. An approval stays an approval even
 * when a stale clock row remains, and a reason the park declared itself, such
 * as `budget` or `quota`, stays with its token rather than decaying into the
 * derived `event`. The token keeps its declared question, a decoded JSON
 * value written back as the `waiting_request` text: a re-park that dropped it
 * left an inbox gate nobody could read.
 *
 * @since 1.0.0-rc.1
 * @category utilities
 */
export const waitingAnnotation = (
  status: string,
  clocks: ReadonlyArray<{ readonly dueAtMs: number }>,
  prior?:
    | { readonly reason: string; readonly token: string | null; readonly request?: unknown }
    | undefined
): { readonly reason: string; readonly wakeAt?: number; readonly token?: string; readonly request?: string } => {
  const declared = prior === undefined || prior.reason === "released" ? undefined : prior
  // A child question rolls the control status up to waiting-approval.
  // Retain the root's named event gate; it is an independent checkpoint.
  const reason = declared?.reason === "event" && declared.token != null
    ? "event"
    : status === "waiting-approval"
    ? "approval"
    : declared?.reason ?? (clocks.length > 0 ? "timer" : "event")
  return {
    reason,
    ...(clocks.length > 0 ? { wakeAt: Math.min(...clocks.map((clock) => clock.dueAtMs)) } : {}),
    ...(declared !== undefined && declared.reason === reason
      ? {
        ...(declared.token == null ? {} : { token: declared.token }),
        ...(declared.request === undefined ? {} : { request: JSON.stringify(declared.request) })
      }
      : {})
  }
}
