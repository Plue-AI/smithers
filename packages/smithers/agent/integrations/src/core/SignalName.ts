/**
 * The reserved `integration:` signal namespace, and the mapping onto the
 * control plane and the notification queue.
 *
 * Every event an integration delivers is named
 * `integration:<service>:<event>`. Reserving the prefix keeps a workflow's own
 * signal names from colliding with delivered ones, and makes the origin of a
 * signal readable in the journal without a lookup.
 *
 * @since 1.0.0
 */

import type { SignalPayload } from "@smthrs/control/ControlSchema"
import { SmithersError } from "@smthrs/errors/SmithersError"
import type { Notification } from "@smthrs/notifications/Notification"
import type { ExternalEvent } from "./ExternalEvent.ts"

/**
 * The reserved prefix. A workflow's own signals must not use it.
 *
 * @category constants
 * @since 1.0.0
 */
export const INTEGRATION_SIGNAL_PREFIX = "integration:"

/**
 * Whether `value` is a segment {@link eventName} accepts verbatim: a non-empty
 * string with no surrounding whitespace and no `:`.
 *
 * One refinement serves the constructor and {@link parse}, so a name the
 * constructor refuses to build is also a name the parser refuses to read.
 *
 * @category refinements
 * @since 1.0.0
 */
export const isSegment = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.trim() === value && !value.includes(":")

/**
 * Whether `value` is a complete integration signal name.
 *
 * The same refinement the constructor and {@link parse} agree on, exported so
 * `ExternalEvent` can demand it too: a name that reaches persistence but that
 * nothing can rebuild is a routing identity with no owner.
 *
 * @category refinements
 * @since 1.0.0
 */
export const isEventName = (value: unknown): value is string => parse(value as string) !== null

const requireSegment = (value: string, label: string): string => {
  const normalized = typeof value === "string" ? value.trim() : ""
  if (normalized.length === 0) {
    throw new SmithersError("INVALID_INPUT", `Integration signal ${label} must be a non-empty string.`, {
      [label]: value
    })
  }
  if (normalized.includes(":")) {
    throw new SmithersError("INVALID_INPUT", `Integration signal ${label} must not contain ":".`, { [label]: value })
  }
  return normalized
}

/**
 * The signal name for one integration event.
 *
 * The `event` segment may contain dots, which is how per-action variants are
 * spelled (`pull_request.opened`). Neither segment may contain `:`, because
 * that is the separator {@link parse} splits on. Both are trimmed.
 *
 * Throws `SmithersError` with code `INVALID_INPUT` when either segment is
 * empty after trimming or contains a `:`.
 *
 * @category constructors
 * @since 1.0.0
 */
export const eventName = (service: string, event: string): string =>
  `${INTEGRATION_SIGNAL_PREFIX}${requireSegment(service, "service")}:${requireSegment(event, "event")}`

/**
 * Whether `name` is in the reserved namespace.
 *
 * @category refinements
 * @since 1.0.0
 */
export const isIntegrationSignalName = (name: unknown): name is string =>
  typeof name === "string" && name.startsWith(INTEGRATION_SIGNAL_PREFIX)

/**
 * Splits an `integration:<service>:<event>` name back into its parts, or
 * `null` when `name` is not one.
 *
 * The round trip is closed in both directions: a name {@link eventName} could
 * not have produced, such as one whose event segment carries a second `:` or
 * whose service segment is padded with whitespace, parses as `null` rather
 * than becoming an identity nothing can rebuild.
 *
 * @category getters
 * @since 1.0.0
 */
export const parse = (name: string): { readonly service: string; readonly event: string } | null => {
  if (!isIntegrationSignalName(name)) return null
  const rest = name.slice(INTEGRATION_SIGNAL_PREFIX.length)
  const separator = rest.indexOf(":")
  if (separator <= 0 || separator === rest.length - 1) return null
  const service = rest.slice(0, separator)
  const event = rest.slice(separator + 1)
  if (!isSegment(service) || !isSegment(event)) return null
  return { service, event }
}

/**
 * The attribution stamped on a signal an integration delivered:
 * `integration:<service>`.
 *
 * Throws `SmithersError` with code `INVALID_INPUT` for an empty or
 * colon-bearing service.
 *
 * @category constructors
 * @since 1.0.0
 */
export const receivedBy = (service: string): string =>
  `${INTEGRATION_SIGNAL_PREFIX}${requireSegment(service, "service")}`

/**
 * The control-plane signal for an event.
 *
 * @category conversions
 * @since 1.0.0
 */
export const toSignalPayload = (event: ExternalEvent): SignalPayload => ({
  name: event.eventName,
  payload: event.payload
})

/**
 * What {@link toNotification} needs beyond the event itself.
 *
 * @category models
 * @since 1.0.0
 */
export interface NotificationOptions {
  /** The notification's own durable id. Usually the event's dedupe key. */
  readonly id?: string | undefined
  /** The lineage the notification is queued against. */
  readonly targetLineageId: string
  readonly provenance: Notification["provenance"]
}

/**
 * The durable notification for an event.
 *
 * Integration events are machine-originated, so they queue rather than steer:
 * they reach the model when the run would otherwise idle, not by interrupting
 * the turn in flight. Consecutive events about the same thing coalesce on
 * `<eventName>:<correlationId>`, so a burst of edits to one issue leaves one
 * pending notification carrying the newest payload.
 *
 * @category conversions
 * @since 1.0.0
 */
export const toNotification = (event: ExternalEvent, options: NotificationOptions): Notification => ({
  _tag: "system-event",
  id: options.id ?? event.dedupeKey,
  targetLineageId: options.targetLineageId,
  provenance: options.provenance,
  payload: event.payload,
  delivery: "queue",
  coalescingKey: `${event.eventName}:${event.correlationId ?? ""}`
})
