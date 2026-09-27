/**
 * The ambient source of execution identity, for a flow executed without one.
 *
 * Identity has three sources, in this order: the `executionId` the caller
 * named, the `idempotencyKey` the flow declared, and — when neither exists —
 * the source in this module. The first two are decisions an author made at the
 * call site or the declaration site; the third is a decision the *host* makes
 * once, for every flow it drives, which is why it is a context reference and
 * not another option on `execute`.
 *
 * The default mints a fresh cryptographic UUID for every unkeyed invocation.
 * Equal payloads are independent requests. To reattach after a crash, retain
 * the returned execution id, declare an idempotency key, or explicitly install
 * the `derived` source. Changing this default does not rewrite stored ids.
 *
 * @since 0.1.0
 */

import { Sha256 } from "@smthrs/crypto"
import { DerivedKey } from "@smthrs/keys"
import * as Context from "effect/Context"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { ExecutionIdRequired } from "./ExecutionIdRequired.ts"
import type { Any } from "./Flow.ts"

/**
 * Mints the execution id of an invocation that named none.
 *
 * It is consulted only after the two explicit sources are absent, and it runs
 * before the runtime is read, so a source that cannot name the invocation
 * fails the execution rather than starting one under a guessed identity.
 *
 * @category models
 * @since 0.1.0
 */
export interface ExecutionIdSource {
  readonly mint: <W extends Any>(
    flow: W,
    payload: unknown
  ) => Effect.Effect<string, never, Crypto.Crypto | W["payloadSchema"]["EncodingServices"]>
}

/**
 * The canonical key of an invocation: the flow's own payload codec, then RFC
 * 8785, then SHA-256.
 *
 * Encoding first is what makes the key agree with the durable driver, which
 * compares the ENCODED payload when it decides whether an existing run row is
 * the same invocation. A payload with no canonical form — a non-finite number,
 * a lone surrogate, a cycle — has no derivable identity at all, so it fails
 * here instead of hashing something approximate.
 *
 * @private
 */
const canonicalKey = <W extends Any>(
  flow: W,
  payload: unknown
): Effect.Effect<string, ExecutionIdRequired, Crypto.Crypto | W["payloadSchema"]["EncodingServices"]> =>
  (Schema.encodeEffect(Schema.toCodecJson(flow.payloadSchema))(payload) as Effect.Effect<
    unknown,
    unknown,
    W["payloadSchema"]["EncodingServices"]
  >).pipe(
    Effect.flatMap((encoded) => Schema.decodeUnknownEffect(DerivedKey)(encoded)),
    Effect.mapError(() => new ExecutionIdRequired({ flowName: flow._tag }))
  )

/**
 * An opt-in deterministic source over the flow tag and the payload's
 * canonical form.
 *
 * Same tag and same encoded payload derive the same id, which is exactly the
 * pair the durable driver already treats as one invocation, so a re-drive of a
 * crashed program re-attaches to the run it left behind instead of opening a
 * second one.
 *
 * The tag and canonical payload key are JSON-tuple framed before hashing.
 * Their strings are used exactly as given and encoded as UTF-8, with no Unicode
 * normalization. This preimage encoding freezes at rc.0.
 *
 * @category constructors
 * @since 0.1.0
 */
export const derived: ExecutionIdSource = {
  mint: (flow, payload) =>
    canonicalKey(flow, payload).pipe(
      // The JSON tuple prevents delimiter splicing. This exact framing freezes at rc.0.
      Effect.flatMap((key) => Effect.orDie(Schema.decodeUnknownEffect(Sha256)(JSON.stringify([flow._tag, key])))),
      Effect.orDie
    )
}

/**
 * Mints independent execution ids for unkeyed requests using host cryptography.
 * @category constructors
 * @since 0.1.0
 */
export const fresh: ExecutionIdSource = {
  mint: () => Effect.flatMap(Crypto.Crypto, (crypto) => Effect.orDie(crypto.randomUUIDv4))
}

/**
 * Context reference carrying the host's execution-id source, defaulting to
 * {@link fresh}.
 *
 * @category idempotency
 * @since 0.1.0
 */
export const CurrentExecutionIds = Context.Reference<ExecutionIdSource>(
  "@smthrs/flow/Flow/CurrentExecutionIds",
  {
    defaultValue: () => fresh
  }
)

/**
 * Declares the host's execution-id source as a layer.
 *
 * **When to use**
 *
 * Install `derived` when equal payloads deliberately identify the same work,
 * or provide a host-specific identity source. Explicit caller execution ids
 * and declared idempotency keys take precedence over this source.
 *
 * @category idempotency
 * @since 0.1.0
 */
export const layerExecutionIds = (
  source: ExecutionIdSource
): Layer.Layer<never> => Layer.succeed(CurrentExecutionIds)(source)
