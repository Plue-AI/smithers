/**
 * Slack Events API ingress over HTTP.
 *
 * Slack signs `v0:<timestamp>:<raw body>` with the app's signing secret and
 * sends the hex digest as `X-Slack-Signature: v0=<hex>` beside
 * `X-Slack-Request-Timestamp`. A valid signature stays valid forever, so the
 * timestamp must also be fresh: {@link verify} refuses one more than five
 * minutes from now, which is the window Slack documents.
 *
 * Two answers belong to the HTTP host rather than to `Channels.ingest`, which
 * returns a control receipt. Slack's `url_verification` check wants its
 * `challenge` echoed, and a delivery the policy refuses (another workspace, an
 * unlisted channel, the app's own message) should be acknowledged with a 200
 * rather than refused with a 4xx, which Slack would retry and eventually count
 * against the app. {@link answer} makes that decision before ingest, and the
 * channel's decoder enforces the same policy again, so an ingress that skips
 * {@link answer} is still gated.
 *
 * Slack retries a delivery it did not see acknowledged, with the same body.
 * {@link idempotencyKey} is the delivery identity `slack:<team>:<event id>`, so
 * `Channels.ingest` drops the retry.
 *
 * Block Kit interactions over HTTP arrive form-encoded and are not handled
 * here; Socket Mode delivers them through `Slack.SocketSource`.
 *
 * @since 1.0.0
 */

import type { Channel, InboundResult, RawInbound } from "@smthrs/control/Channels"
import type { InvalidInput } from "@smthrs/control/ControlError"
import type { CredentialRef } from "@smthrs/control/Credential"
import { type Effect, type Redacted, Schema } from "effect"
import * as Core from "../core/Channel.ts"
import type { ExternalEvent } from "../core/ExternalEvent.ts"
import { type HasHeaders, readHeader } from "../core/JsonPath.ts"
import { verifySignature } from "../core/Signature.ts"
import * as Payload from "./Payload.ts"

/**
 * The service segment of every Slack signal name.
 *
 * @category constants
 * @since 1.0.0
 */
export const SERVICE = Payload.SERVICE

/**
 * The prefix of the `X-Slack-Signature` header and of the signed base string.
 *
 * @category constants
 * @since 1.0.0
 */
export const SIGNATURE_VERSION = "v0"

/**
 * How far `X-Slack-Request-Timestamp` may sit from now: five minutes.
 *
 * @category constants
 * @since 1.0.0
 */
export const DEFAULT_TIMESTAMP_SKEW_MS = 300_000

/**
 * The widest replay window {@link verify} accepts. A caller may narrow the
 * window, never widen it past Slack's own.
 *
 * @category constants
 * @since 1.0.0
 */
export const MAX_TIMESTAMP_SKEW_MS = DEFAULT_TIMESTAMP_SKEW_MS

/**
 * What {@link verify} allows.
 *
 * @category models
 * @since 1.0.0
 */
export interface VerifyOptions {
  /** How far the timestamp may sit from now, in milliseconds. 0 to {@link MAX_TIMESTAMP_SKEW_MS}. */
  readonly maxTimestampSkewMs?: number | undefined
  readonly nowMs?: number | undefined
}

/**
 * The exact bytes Slack signs: `v0:<timestamp>:<raw body>`.
 *
 * @category verification
 * @since 1.0.0
 */
export const signatureBase = (timestamp: string, body: Uint8Array): Uint8Array =>
  Buffer.concat([Buffer.from(`${SIGNATURE_VERSION}:${timestamp}:`), body])

/**
 * Whether the delivery's signature matches `secret` and its timestamp is
 * fresh.
 *
 * Returns `false`, and never throws, for a missing or malformed timestamp, a
 * window outside the accepted range, a stale or future timestamp, and a
 * signature that does not match the raw body.
 *
 * @category verification
 * @since 1.0.0
 */
export const verify = (raw: RawInbound, secret: string, options: VerifyOptions = {}): boolean => {
  const timestamp = readHeader(raw, "x-slack-request-timestamp")
  if (timestamp === undefined || !/^\d{1,12}$/.test(timestamp)) return false
  const skew = options.maxTimestampSkewMs ?? DEFAULT_TIMESTAMP_SKEW_MS
  // An unbounded or nonsensical window turns the replay check off, so it is
  // refused rather than honored: verification fails closed.
  if (!Number.isSafeInteger(skew) || skew < 0 || skew > MAX_TIMESTAMP_SKEW_MS) return false
  const nowMs = options.nowMs ?? Date.now()
  if (!(Math.abs(nowMs - Number(timestamp) * 1000) <= skew)) return false
  return verifySignature({
    payload: signatureBase(timestamp, raw.body),
    secret,
    signature: readHeader(raw, "x-slack-signature"),
    prefix: `${SIGNATURE_VERSION}=`
  })
}

const isUrlVerification = Schema.is(Payload.UrlVerification)

const parse = (body: Uint8Array): unknown => {
  try {
    return JSON.parse(new TextDecoder().decode(body))
  } catch {
    return undefined
  }
}

/**
 * The `challenge` of a `url_verification` payload, or `undefined` for any
 * other payload.
 *
 * @category getters
 * @since 1.0.0
 */
export const challenge = (payload: unknown): string | undefined =>
  isUrlVerification(payload) ? payload.challenge : undefined

/**
 * The delivery identity of an Events API delivery,
 * `slack:<team_id>:<event_id>`, or `undefined` when the payload carries none.
 *
 * @category getters
 * @since 1.0.0
 */
export const idempotencyKey = (payload: unknown): string | undefined => Payload.idempotencyKey(payload)

/**
 * What the HTTP host does with one request.
 *
 * - `Unauthorized`: answer 401. The signature or the timestamp failed.
 * - `Malformed`: answer 400. The verified body is not JSON.
 * - `Challenge`: answer 200 with `challenge` as the body.
 * - `Ignored`: answer 200. The policy refused the delivery; Slack must not retry it.
 * - `Ingest`: pass `raw` to `Channels.ingest` and answer from its receipt.
 *
 * @category models
 * @since 1.0.0
 */
export type HostAnswer =
  | { readonly _tag: "Unauthorized" }
  | { readonly _tag: "Malformed" }
  | { readonly _tag: "Challenge"; readonly challenge: string }
  | { readonly _tag: "Ignored"; readonly reason: Payload.RefusalReason }
  | { readonly _tag: "Ingest"; readonly raw: RawInbound }

/**
 * What {@link answer} needs.
 *
 * @category models
 * @since 1.0.0
 */
export interface AnswerOptions extends VerifyOptions {
  readonly policy: Payload.Policy
}

/**
 * Decides, before `Channels.ingest`, how the HTTP host answers one request.
 *
 * Verification runs first, on the exact bytes received; nothing reads the
 * body before it passes. An admitted delivery comes back as the `RawInbound`
 * to ingest, carrying {@link idempotencyKey}.
 *
 * @category constructors
 * @since 1.0.0
 */
export const answer = (
  request: { readonly body: Uint8Array; readonly headers: HasHeaders["headers"] },
  secret: string,
  options: AnswerOptions
): HostAnswer => {
  const unkeyed: RawInbound = { body: request.body, headers: request.headers, idempotencyKey: "" }
  if (!verify(unkeyed, secret, options)) return { _tag: "Unauthorized" }
  const payload = parse(request.body)
  if (payload === undefined) return { _tag: "Malformed" }
  const echo = challenge(payload)
  if (echo !== undefined) return { _tag: "Challenge", challenge: echo }
  const verdict = Payload.classify(payload, options.policy)
  if (verdict._tag === "Refused") return { _tag: "Ignored", reason: verdict.reason }
  return { _tag: "Ingest", raw: { ...unkeyed, idempotencyKey: verdict.key } }
}

/**
 * Decodes one verified delivery.
 *
 * Throws `Payload.SlackRefused` for a delivery the policy refuses, including a
 * `url_verification` that reached ingest instead of {@link answer}.
 *
 * @category constructors
 * @since 1.0.0
 */
export const decode = (payload: unknown, options: Payload.DecodeOptions): ExternalEvent =>
  Payload.toExternalEvent(payload, options)

/**
 * What {@link channel} needs.
 *
 * @category models
 * @since 1.0.0
 */
export interface ChannelOptions {
  /** The channel name, which is every decoded event's source. Defaults to `slack`. */
  readonly name?: string | undefined
  readonly credential: Redacted.Redacted<CredentialRef>
  readonly secret: Core.SecretResolver
  readonly route: (event: ExternalEvent) => Effect.Effect<InboundResult, InvalidInput>
  readonly project?: Core.Config["project"]
  readonly policy: Payload.Policy
  /** See {@link VerifyOptions}. The channel always verifies against the live clock. */
  readonly maxTimestampSkewMs?: number | undefined
}

/**
 * A control-plane channel for Slack Events API deliveries.
 *
 * Throws `IntegrationError` with reason `invalid-config` when either
 * allowlist is empty.
 *
 * @category constructors
 * @since 1.0.0
 */
export const channel = (options: ChannelOptions): Channel => {
  const name = options.name ?? SERVICE
  const policy = Payload.requirePolicy(options.policy, "Slack.Webhook.channel")
  return Core.make({
    name,
    credential: options.credential,
    secret: options.secret,
    verify: (raw, secret) => verify(raw, secret, { maxTimestampSkewMs: options.maxTimestampSkewMs }),
    decode: (_raw, payload) => decode(payload, { source: name, policy }),
    route: options.route,
    project: options.project
  })
}
