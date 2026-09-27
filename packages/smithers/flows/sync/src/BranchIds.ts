/**
 * The source of freshly minted branch and capability identifiers.
 *
 * Minting an id is nondeterminism against the host, so it enters through a
 * port like every other host effect: `BranchServer.layerHandlers` asks
 * this service for the ids it puts on the wire instead of calling a global
 * generator, which is what lets a deterministic composition — a test, a
 * replayed transcript, a deployment that derives ids from its own namespace —
 * supply its own without touching the handlers.
 *
 * @since 0.1.0
 */

import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

/**
 * Identifier minting operations.
 *
 * @category models
 * @since 0.1.0
 */
export interface Service {
  /** A fresh, unguessable identifier. Never returns the same value twice. */
  readonly fresh: Effect.Effect<string>
}

/**
 * The branch identifier source.
 *
 * @category services
 * @since 0.1.0
 */
export class BranchIds extends Context.Service<BranchIds, Service>()("@smthrs/sync/BranchIds") {}

/**
 * Constructs the default source: Web Crypto UUIDs.
 *
 * Web Crypto is used directly, as it is for the share signature in
 * `BranchShare`, so the same module runs in the browser and on node.
 * A branch id is not itself an authorization — every operation still
 * authorizes through a signed capability — but an unguessable id keeps a
 * branch from being enumerated, which is why the default stays with a
 * cryptographic generator rather than `Random`.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeWebCrypto = (): Service => BranchIds.of({ fresh: Effect.sync(() => crypto.randomUUID()) })

/**
 * Provides {@link makeWebCrypto}.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer: Layer.Layer<BranchIds> = Layer.sync(BranchIds)(makeWebCrypto)

/**
 * Provides a deterministic counter, `<prefix>-1`, `<prefix>-2`, and so on.
 * For tests and reproducible transcripts only — the ids are guessable.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerSequential = (prefix: string): Layer.Layer<BranchIds> =>
  Layer.sync(BranchIds)(() => {
    let sequence = 0
    return BranchIds.of({
      fresh: Effect.sync(() => {
        sequence += 1
        return `${prefix}-${sequence}`
      })
    })
  })
