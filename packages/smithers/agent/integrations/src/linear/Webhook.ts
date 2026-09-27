/**
 * Linear webhook ingress.
 *
 * Linear signs the raw body with HMAC-SHA256 and sends the bare hex digest in
 * `Linear-Signature`. Verification also checks `webhookTimestamp` inside the
 * body: a valid signature stays valid forever, so without a freshness window a
 * captured delivery could be replayed indefinitely.
 *
 * @since 1.0.0
 */

import type { Channel, InboundResult, RawInbound } from "@smthrs/control/Channels"
import type { InvalidInput } from "@smthrs/control/ControlError"
import type { CredentialRef } from "@smthrs/control/Credential"
import type { Effect, Redacted } from "effect"
import * as Core from "../core/Channel.ts"
import type { ExternalEvent } from "../core/ExternalEvent.ts"
import { type HasHeaders, readHeader, readJsonPath, readString } from "../core/JsonPath.ts"
import * as SignalName from "../core/SignalName.ts"
import { verifySignature } from "../core/Signature.ts"

/**
 * The service segment of every Linear signal name.
 *
 * @category constants
 * @since 1.0.0
 */
export const SERVICE = "linear"

/**
 * How stale a `webhookTimestamp` may be before the delivery is refused.
 *
 * @category constants
 * @since 1.0.0
 */
export const DEFAULT_TIMESTAMP_SKEW_MS = 60_000

/**
 * Linear's `webhookTimestamp` in milliseconds.
 *
 * Older payloads send seconds, so a value below the year-2001 millisecond
 * boundary is read as seconds.
 *
 * @category getters
 * @since 1.0.0
 */
export const timestampMs = (value: unknown): number | null => {
  if (typeof value !== "number" || !Number.isFinite(value)) return null
  return value < 1e12 ? value * 1000 : value
}

/**
 * What {@link verify} allows.
 *
 * @category models
 * @since 1.0.0
 */
export interface VerifyOptions {
  /**
   * How far a `webhookTimestamp` may sit from now, in milliseconds. Must be a
   * finite integer from 0 to {@link MAX_TIMESTAMP_SKEW_MS}; `Infinity` would
   * silently turn the replay window off, which is the check's whole point.
   */
  readonly maxTimestampSkewMs?: number | undefined
  readonly nowMs?: number | undefined
}

/**
 * The largest replay window this module accepts, one hour.
 *
 * @category constants
 * @since 1.0.0
 */
export const MAX_TIMESTAMP_SKEW_MS = 3_600_000

/**
 * Whether the delivery's signature matches and its timestamp is fresh.
 *
 * @category verification
 * @since 1.0.0
 */
export const verify = (raw: RawInbound, secret: string, options: VerifyOptions = {}): boolean => {
  if (!verifySignature({ payload: raw.body, secret, signature: readHeader(raw, "linear-signature") })) return false
  let payload: unknown
  try {
    payload = JSON.parse(new TextDecoder().decode(raw.body))
  } catch {
    return false
  }
  const sentAt = timestampMs(readJsonPath(payload, "webhookTimestamp"))
  if (sentAt === null) return false
  const skew = options.maxTimestampSkewMs ?? DEFAULT_TIMESTAMP_SKEW_MS
  // An unbounded or nonsensical window disables the replay check, so it is
  // refused rather than honored: verification fails closed.
  if (!Number.isSafeInteger(skew) || skew < 0 || skew > MAX_TIMESTAMP_SKEW_MS) return false
  const nowMs = options.nowMs ?? Date.now()
  if (!Number.isFinite(nowMs)) return false
  return Math.abs(nowMs - sentAt) <= skew
}

/**
 * The idempotency key for one Linear delivery.
 *
 * `Channels.ingest` drops a replayed `RawInbound.idempotencyKey`, and that is
 * the whole redelivery guarantee: nothing derives the key on the caller's
 * behalf. An ingress builds its `RawInbound` with this, so a Linear
 * redelivery is recognized rather than processed twice.
 *
 * @category getters
 * @since 1.0.0
 */
export const idempotencyKey = (raw: HasHeaders, payload: unknown): string => `linear:${deliveryId(raw, payload)}`

/**
 * Linear's delivery identity: the `Linear-Delivery` header when present, and
 * otherwise the webhook id, entity, action, and timestamp, which together
 * identify the same delivery across a redelivery.
 *
 * One derivation, so the idempotency key and the event's dedupe key cannot
 * come to disagree about what "the same delivery" means.
 */
const deliveryId = (raw: HasHeaders, payload: unknown): string => {
  const header = readHeader(raw, "linear-delivery")
  if (header !== undefined && header.length > 0) return header
  return [
    readString(payload, "webhookId") ?? "-",
    (readString(payload, "type") ?? "unknown").toLowerCase(),
    (readString(payload, "action") ?? "unknown").toLowerCase(),
    readString(payload, "data.id") ?? "-",
    String(readJsonPath(payload, "webhookTimestamp") ?? "-")
  ].join(":")
}

/**
 * The signal names a delivery answers to, most specific first:
 * `integration:linear:issue.update` then `integration:linear:issue`.
 *
 * @category getters
 * @since 1.0.0
 */
export const names = (payload: unknown): ReadonlyArray<string> => {
  const type = (readString(payload, "type") ?? "unknown").toLowerCase()
  const action = (readString(payload, "action") ?? "unknown").toLowerCase()
  return [SignalName.eventName(SERVICE, `${type}.${action}`), SignalName.eventName(SERVICE, type)]
}

/**
 * The correlations a delivery answers to, most specific first: the issue
 * identifier (`ENG-123`), the team key (`ENG`), then `null`.
 *
 * A comment delivery carries the issue one level down, under `data.issue`,
 * which is why both paths are read.
 *
 * @category getters
 * @since 1.0.0
 */
export const correlations = (payload: unknown): ReadonlyArray<string | null> => {
  const identifier = readString(payload, "data.identifier") ?? readString(payload, "data.issue.identifier")
  const teamKey = readString(payload, "data.team.key") ?? readString(payload, "data.issue.team.key")
  const found = [...new Set([identifier, teamKey].filter((value) => value !== undefined))] as Array<string | null>
  found.push(null)
  return found
}

/**
 * Decodes one verified delivery.
 *
 * Delivery identity is the `Linear-Delivery` header when present, and
 * otherwise the webhook id, entity, action, and timestamp, which together
 * identify the same delivery across a redelivery.
 *
 * @category constructors
 * @since 1.0.0
 */
export const decode = (
  raw: RawInbound,
  payload: unknown,
  source: string = SERVICE,
  receivedAtMs: number = Date.now()
): ExternalEvent => {
  const eventName = names(payload)[0] as string
  const correlationId = correlations(payload)[0] as string | null
  return {
    source,
    eventName,
    correlationId,
    payload: payload as ExternalEvent["payload"],
    dedupeKey: `${deliveryId(raw, payload)}#${eventName}#${correlationId ?? ""}`,
    receivedAtMs
  }
}

/**
 * What {@link channel} needs.
 *
 * @category models
 * @since 1.0.0
 */
export interface ChannelOptions {
  /** See {@link VerifyOptions}. The channel always verifies against the live clock. */
  readonly maxTimestampSkewMs?: VerifyOptions["maxTimestampSkewMs"]
  /** The channel name, which is every decoded event's source. Defaults to `linear`. */
  readonly name?: string | undefined
  readonly credential: Redacted.Redacted<CredentialRef>
  readonly secret: Core.SecretResolver
  readonly route: (event: ExternalEvent) => Effect.Effect<InboundResult, InvalidInput>
  readonly project?: Core.Config["project"]
}

/**
 * A control-plane channel for Linear webhooks.
 *
 * @category constructors
 * @since 1.0.0
 */
export const channel = (options: ChannelOptions): Channel => {
  const name = options.name ?? SERVICE
  return Core.make({
    name,
    credential: options.credential,
    secret: options.secret,
    fingerprintHeaders: ["linear-delivery"],
    verify: (raw, secret) => verify(raw, secret, { maxTimestampSkewMs: options.maxTimestampSkewMs }),
    decode: (raw, payload) => decode(raw, payload, name),
    route: options.route,
    project: options.project
  })
}
