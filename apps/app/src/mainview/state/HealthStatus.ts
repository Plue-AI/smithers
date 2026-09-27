import type { StatusRollup } from "@smthrs/rpc/Health"

export const terminalStatus = (status: StatusRollup): boolean =>
  ["completed", "failed", "cancelled", "exited"].includes(status.state)
const knownWait = (status: StatusRollup): boolean => status.state === "waiting-approval" ||
  status.state === "parked" && (status.health === "awaiting-human" ||
    ["awaiting-reply", "quota-wait", "timer-wait", "event-wait"].includes(status.reason ?? ""))

/** Presentation expiry cannot change execution, release a wait, or turn an exit into success. */
export const expireStatus = (status: StatusRollup, now: number): StatusRollup => {
  if (status.freshness !== "fresh" || status.provenance !== undefined &&
    now >= status.provenance.observedAt && now < status.provenance.expiresAt) return status
  if (terminalStatus(status) || knownWait(status)) return { ...status, activity: "unknown", freshness: "stale" }
  return { ...status, activity: "unknown", health: "unknown", attention: "none", freshness: "stale" }
}

