/**
 * The source of the fencing identity a store incarnation runs under.
 *
 * Minting an {@link OwnerId} is an act of nondeterminism against the host: it
 * reads a process identifier and draws a fresh nonce. Both belong behind a
 * port rather than in the composition itself — the closed-host doctrine in
 * `@smthrs/kernel`'s `HostServices` admits no ambient `process` and no static
 * `node:crypto` import, and browser support is a hard requirement, so a store
 * that reached for either directly could not be composed in a tab at all.
 *
 * Governing design: `docs/concepts/ownership-and-fencing.md`.
 *
 * @since 0.1.0
 */

import type { OwnerId } from "@smthrs/journal/OwnerId"
import * as Context from "effect/Context"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Random from "effect/Random"

/**
 * Owner identity operations.
 *
 * @category models
 * @since 0.1.0
 */
export interface Service {
  /**
   * Mints the identity this incarnation fences its durable writes with. The
   * host supplies the incarnation; the caller supplies the host id, because
   * which host a store speaks for is a composition decision, not a host fact.
   */
  readonly ownerId: (hostId: string) => Effect.Effect<OwnerId>
}

/**
 * Service tag for the owner identity source.
 *
 * @category services
 * @since 0.1.0
 */
export class OwnerIdentity extends Context.Service<OwnerIdentity, Service>()("@smthrs/engine-store/OwnerIdentity") {}

/**
 * Constructs an owner identity source from an implementation.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (service: Service): Service => OwnerIdentity.of(service)

/**
 * The host's process identifier, when the platform has one.
 *
 * Read off `globalThis` rather than through a bare `process` reference so the
 * module carries no Node binding at all: a browser bundle sees `undefined`
 * here and falls through to a drawn incarnation number instead. The read
 * happens at layer construction — {@link layer} — so importing the module
 * touches nothing.
 */
const hostProcessId = (): number | undefined =>
  (globalThis as { readonly process?: { readonly pid?: number } }).process?.pid

/**
 * Builds the standard identity source over an explicitly supplied process id
 * and the injected `Crypto` service.
 *
 * On node and bun `pid` is the real process id, so the minted token is exactly
 * what the store produced before this service existed. A browser tab has no
 * process, and no stable per-tab integer that means the same thing, so
 * `undefined` draws an incarnation number instead: the component's only job is
 * to distinguish concurrent incarnations on one host, and `Random` is the
 * sanctioned port for drawing one. Effect's own cluster storage does the same
 * where a backend exposes no connection pid (`reference/effect`
 * `unstable/cluster/SqlRunnerStorage.ts`).
 *
 * The nonce is a UUIDv4 drawn from the injected `effect/Crypto` service — the
 * closed-host seam every composition already provides for digesting — so no
 * ambient `crypto` global is reached from a hot path. A host whose crypto
 * cannot mint a UUID cannot fence anything, so that refusal is a defect.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeIncarnation = (pid: number | undefined, crypto: Crypto.Crypto): Service => {
  const incarnationId: Effect.Effect<number> = pid === undefined
    ? Random.nextIntBetween(0, Number.MAX_SAFE_INTEGER, { halfOpen: true })
    : Effect.succeed(pid)
  return make({
    ownerId: Effect.fn("OwnerIdentity.ownerId")(function*(hostId) {
      yield* Effect.annotateCurrentSpan({ hostId })
      return {
        hostId,
        pid: yield* incarnationId,
        nonce: yield* crypto.randomUUIDv4.pipe(Effect.orDie)
      } satisfies OwnerId
    })
  })
}

/**
 * Provides {@link makeIncarnation} over whatever process id the running
 * platform reports and the composition's `Crypto` service. This is what
 * engine composition supplies unless a host has a better answer.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer: Layer.Layer<OwnerIdentity, never, Crypto.Crypto> = Layer.effect(
  OwnerIdentity,
  Effect.map(Crypto.Crypto, (crypto) => makeIncarnation(hostProcessId(), crypto))
)

/**
 * Provides a fixed identity. A test — or a host that derives ownership from
 * something outside this process, such as a lease it already holds — pins the
 * whole token instead of letting the default draw one.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerConstant = (owner: OwnerId): Layer.Layer<OwnerIdentity> =>
  Layer.succeed(OwnerIdentity)(make({ ownerId: () => Effect.succeed(owner) }))
