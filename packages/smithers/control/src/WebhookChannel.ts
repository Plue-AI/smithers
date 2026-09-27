/**
 * Webhook channel construction over Effect's transport-neutral HTTP request.
 *
 * @since 0.1.0
 */

import { Effect, type Redacted, Schema, Stream } from "effect"
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest"
import { type Channel, Channels, type InboundResult, type RawInbound } from "./Channels.ts"
import { InvalidInput, type Unauthorized } from "./ControlError.ts"
import type { IdempotencyKey } from "./ControlSchema.ts"
import type { CredentialRef } from "./Credential.ts"

/**
 * Signature verifier injected by a webhook transport.
 *
 * The credential is intentionally a redacted reference. Resolution belongs at
 * the host adapter boundary, never in webhook input or its persisted record.
 *
 * @category models
 * @since 0.1.0
 */
export type SignatureVerifier = (
  raw: RawInbound,
  credential: Redacted.Redacted<CredentialRef>
) => Effect.Effect<void, Unauthorized>

/**
 * Configuration for a schema-declared webhook channel.
 *
 * @category models
 * @since 0.1.0
 */
export interface Config<A> {
  readonly name: string
  readonly schema: Schema.Schema<A>
  readonly credential: Redacted.Redacted<CredentialRef>
  readonly fingerprintHeaders?: Channel<A>["fingerprintHeaders"]
  readonly verify: SignatureVerifier
  readonly map: (payload: A) => Effect.Effect<InboundResult, InvalidInput>
  readonly project: Channel<A>["project"]
}

const invalidInput = (issue: string): InvalidInput => new InvalidInput({ issue })

/**
 * Largest webhook request body one mount reads by default, in bytes.
 *
 * A webhook is the one control-plane ingress a bearer holder reaches with an
 * arbitrary payload, and `handler` used to materialize whatever arrived before
 * anything looked at its size. The default is deliberately smaller than the
 * 4 MiB mutation-identity budget in `internal/mutationBoundary.ts`: a body that
 * cannot become a durable mutation is refused at the door rather than copied,
 * decoded, and refused later.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const maximumBodyBytes = 1024 * 1024

/**
 * Per-mount overrides for the webhook request handler.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface HandlerOptions {
  /** Body ceiling for this mount. Defaults to `maximumBodyBytes`. */
  readonly maximumBodyBytes?: number | undefined
}

/**
 * The declared body length, when the caller stated one this host can trust.
 *
 * Header names arrive lower-cased from Effect's HTTP layer, but a hand-built
 * request is not obliged to, so the lookup folds case itself. An absent,
 * non-numeric, fractional, or negative declaration is not evidence of
 * anything: it falls through to the streaming measurement rather than being
 * treated as zero.
 */
const declaredLength = (headers: Readonly<Record<string, string | undefined>>): number | undefined => {
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== "content-length" || value === undefined) continue
    const parsed = Number(value.trim())
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined
  }
  return undefined
}

/**
 * Builds a webhook channel. Verification receives raw bytes and headers before
 * JSON parsing and schema decoding.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = <A>(config: Config<A>): Channel<A> => {
  const decode = Schema.decodeUnknownEffect(config.schema)
  return {
    name: config.name,
    schema: config.schema,
    ...(config.fingerprintHeaders === undefined ? {} : { fingerprintHeaders: config.fingerprintHeaders }),
    verify: Effect.fn("WebhookChannel.verify")((raw) => config.verify(raw, config.credential)),
    decode: Effect.fn("WebhookChannel.decode")((raw) =>
      Effect.try({
        try: () => JSON.parse(new TextDecoder().decode(raw.body)),
        catch: () => invalidInput("invalid webhook JSON")
      }).pipe(
        Effect.flatMap((json) => decode(json)),
        Effect.mapError((cause) => cause instanceof InvalidInput ? cause : invalidInput(String(cause)))
      ) as Effect.Effect<A, InvalidInput>
    ),
    map: Effect.fn("WebhookChannel.map")((payload) => config.map(payload)),
    project: config.project
  }
}

/**
 * Reads an abstract Effect HTTP request and dispatches it through Channels.
 * This is mountable by any Effect HTTP host; it contains no Node transport
 * dependencies.
 *
 * The body is bounded twice. A `content-length` over the limit is refused
 * before the body is read at all, so a declared flood costs nothing; the
 * measured length is checked before retaining each streamed chunk. Reading
 * stops at the first chunk exceeding the limit, including when the caller
 * understates or omits the length. Both refusals are `InvalidInput` naming the
 * two byte counts and no body content.
 *
 * @category handlers
 * @since 0.1.0
 */
export const handler = (
  channel: string,
  idempotencyKey: IdempotencyKey,
  options?: HandlerOptions | undefined
) =>
  Effect.gen(function*() {
    const limit = options?.maximumBodyBytes ?? maximumBodyBytes
    const request = yield* HttpServerRequest.HttpServerRequest
    const declared = declaredLength(request.headers)
    if (declared !== undefined && declared > limit) {
      return yield* invalidInput(`webhook body: declared ${declared} bytes exceeds the ${limit} byte limit`)
    }
    const chunks: Array<Uint8Array> = []
    let size = 0
    yield* Stream.runForEach(request.stream, (chunk) =>
      Effect.gen(function*() {
        size += chunk.byteLength
        if (size > limit) {
          return yield* invalidInput(`webhook body: ${size} bytes exceeds the ${limit} byte limit`)
        }
        if (chunk.byteLength > 0) chunks.push(chunk.slice())
      }))
    const body = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      body.set(chunk, offset)
      offset += chunk.byteLength
    }
    const channels = yield* Channels
    return yield* channels.ingest({
      channel,
      raw: { body, headers: request.headers, idempotencyKey }
    })
  })
