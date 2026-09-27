/**
 * The wire contract of a model API family, split from the deployment that
 * serves it. A protocol owns the body encoder, the event decoder, and the
 * state machine that turns decoded frames into {@link ModelEvent}s; an
 * endpoint owns where to send them.
 *
 * @since 0.1.0
 */

import { type Effect, Schema } from "effect"
import type { ModelError } from "./ModelError.ts"
import type { ModelEvent } from "./ModelEvent.ts"
import type { ModelRequest } from "./ModelRequest.ts"

/**
 * The semantic wire contract shared by deployments of a model API family.
 *
 * The body and event codecs are the runtime boundary: a provider-native body
 * is validated before canonical encoding, and every framed event is decoded
 * before it reaches the state machine.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export interface Protocol<Body, Frame, Event, State> {
  readonly id: string
  readonly supportsDeferred: (modelId: string) => boolean
  readonly body: ProtocolBody<Body>
  readonly stream: ProtocolStream<Frame, Event, State>
  readonly classifyError: (status: number, body: string) => ModelError
  /**
   * Public headers derived from one request, merged over the route's static
   * headers. They enter the prepared request, and so the sealed-step key,
   * exactly like the body; a credential still belongs to `Auth`.
   */
  readonly headers?: ((request: ModelRequest) => Readonly<Record<string, string>>) | undefined
  /**
   * A response header that carries an opaque routing token the provider
   * expects echoed on the next request of the same conversation (the
   * request's `cacheKey`). The route remembers the latest value per
   * conversation for the life of the process and sends it back under the
   * same name. Like a credential it is applied as the request leaves, so it
   * never enters the prepared request or the sealed-step key.
   */
  readonly affinityHeader?: string | undefined
}

/**
 * Provider request construction and its validating Schema codec.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export interface ProtocolBody<Body> {
  readonly schema: Schema.Codec<Body, unknown>
  readonly from: (
    request: ModelRequest,
    options: { readonly native: boolean }
  ) => Effect.Effect<Body, ModelError>
}

/**
 * Framed provider-event decoding and the typed event state machine.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export interface ProtocolStream<Frame, Event, State> {
  readonly event: Schema.Codec<Event, Frame>
  readonly initial: (request: ModelRequest) => State
  readonly step: (
    state: State,
    event: Event
  ) => Effect.Effect<readonly [State, ReadonlyArray<ModelEvent>], ModelError>
  readonly onHalt?: ((state: State) => ReadonlyArray<ModelEvent>) | undefined
  readonly terminal?: ((event: Event) => boolean) | undefined
}

/**
 * Constructs a protocol from its deterministic request lowering and streaming
 * state machine.
 *
 * @since 0.1.0
 * @category constructors
 * @slop
 */
export const make = <Body, Frame, Event, State>(
  protocol: Protocol<Body, Frame, Event, State>
): Protocol<Body, Frame, Event, State> => protocol

/**
 * Builds the JSON-string event codec shared by SSE protocols.
 *
 * @since 0.1.0
 * @category schemas
 * @slop
 */
export const jsonEvent = <S extends Schema.Top>(schema: S) => Schema.fromJsonString(schema)
