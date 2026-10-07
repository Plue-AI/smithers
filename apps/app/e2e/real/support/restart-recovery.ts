import { isDeepStrictEqual } from "node:util"
/** Read-only release oracle. It neither retries work nor emits check receipts. */
export type RecoveryEvent = {
  readonly seq: number
  readonly eventType: string
  readonly payload: Readonly<Record<string, unknown>>
}
export function assertRestartRecovery(before: readonly RecoveryEvent[], after: readonly RecoveryEvent[]) {
  const validOrder = (events: readonly RecoveryEvent[]) => events.every((event, index) =>
    Number.isSafeInteger(event.seq) && event.seq >= 0 && (index === 0 || event.seq > events[index - 1]!.seq))
  if (!validOrder(before) || !validOrder(after)) throw new Error("Restart journal is unordered or repeats an event")
  if (!before.length || after.length <= before.length) throw new Error("Restart has no retained prefix or new recovery evidence")
  if (!isDeepStrictEqual(after.slice(0, before.length), before)) throw new Error("Restart changed the completed journal prefix")
  const completed = new Set(before.filter(event => event.eventType === "flows.engine.attempt-finished" && event.payload.state === "succeeded")
    .map(event => event.payload.stepKeyDigest))
  if (!completed.size || [...completed].some(key => typeof key !== "string" || !key)) throw new Error("Restart requires identifiable completed steps")
  const later = after.slice(before.length)
  if (later.some(event => event.eventType === "flows.engine.attempt-started" && completed.has(event.payload.stepKeyDigest))) {
    throw new Error("Restart re-ran a completed step")
  }
  const recovered = later.find(event => event.eventType === "flows.engine.run-decision" &&
    ["stolen-and-activated", "claimed-and-activated"].includes(String(event.payload.decision)) &&
    (event.payload.evidence === "same-host-pid-dead" || typeof event.payload.recoveredClaim === "object" && event.payload.recoveredClaim !== null))
  if (!recovered) throw new Error("Restart has no owner-loss recovery decision")
  return { completed: [...completed], recovery: recovered }
}
