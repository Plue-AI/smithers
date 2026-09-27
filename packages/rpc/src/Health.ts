/**
 * Runtime-free mirror of @smthrs/control/Health.StatusRollup. Observations never grant authority.
 *
 * @since 1.0.0
 */
import { z } from "zod"

const counter = z.number().int().nonnegative()
/**
 * One subject's health observation: its lifecycle state, what it is doing, how
 * healthy and how fresh the observation is, and the monitor that recorded it.
 * `provenance` is absent when nothing has observed the subject yet.
 *
 * @since 1.0.0
 * @category schemas
 */
export const StatusRollupSchema = z.object({
  subjectId: z.string(),
  state: z.enum([
    "accepted",
    "running",
    "parked",
    "waiting-approval",
    "completed",
    "failed",
    "cancelled",
    "spawning",
    "exited"
  ]),
  activity: z.enum(["working", "idle", "needs-input", "unknown"]),
  health: z.enum(["healthy", "stalled", "wedged-node", "runaway-loop", "awaiting-human", "failing", "unknown"]),
  attention: z.enum(["none", "awaiting-approval", "needs-input", "unhealthy"]),
  freshness: z.enum(["fresh", "stale", "unobserved"]),
  reason: z.enum([
    "ok",
    "no-progress",
    "awaiting-reply",
    "prompt-detected",
    "quota-wait",
    "timer-wait",
    "event-wait",
    "unreachable",
    "probe-timeout",
    "probe-error",
    "owner-changed"
  ]).optional(),
  provenance: z.object({
    checkerId: z.string(),
    monitorId: z.string(),
    observedAt: counter,
    expiresAt: counter,
    evidenceSeq: counter,
    incarnation: z.string(),
    version: counter
  }).optional(),
  updatedAt: counter
})
/**
 * The decoded value accepted by {@link StatusRollupSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type StatusRollup = z.infer<typeof StatusRollupSchema>
