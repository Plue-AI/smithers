/**
 * Share capabilities: the authorization boundary of a shared branch.
 *
 * A share link carries a capability, not a session. The capability names
 * exactly one branch, one access level, and one expiry, and it is signed, so
 * the holder cannot widen it. Every branch operation authorizes through
 * `verify`, which is therefore the single place cross-branch access and
 * expired links are refused.
 *
 * The signature is HMAC-SHA-256 over a length-prefixed encoding of the claims,
 * led by a scheme label. Length prefixes matter: without them a branch id
 * ending in the separator could be re-cut into a different, still-validly-
 * signed claim set. The label matters for the same reason across schemes: a
 * branch capability can never verify as a workspace capability even if one
 * secret is misconfigured into both authorities. Web Crypto is used directly
 * so the same module runs in the browser and on node.
 *
 * A `kid` inside the claims names the key that signed them, so a branch secret
 * rotates the way the workspace secret already did: the new key signs, the
 * retired key stays in the verification keyring, and the share links already
 * out keep working until they expire.
 *
 * @since 0.1.0
 */

import * as Clock from "effect/Clock"
import * as Config from "effect/Config"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { Access, BranchId, ShareCapability, ShareClaims } from "./BranchProtocol.ts"
import * as Admission from "./internal/Admission.ts"
import * as shareSigner from "./internal/ShareSigner.ts"
import type { SyncError } from "./SyncError.ts"

/**
 * The branch and access one authorization request needs.
 *
 * @category models
 * @since 0.1.0
 */
export interface AuthorizeRequest {
  readonly branchId: BranchId
  readonly access: Access
}

/**
 * What a freshly minted capability grants.
 *
 * @category models
 * @since 0.1.0
 */
export const MintRequest = Schema.Struct({
  branchId: BranchId,
  capabilityId: Schema.NonEmptyString,
  access: Access,
  ttlMs: Schema.Int.check(Schema.isGreaterThan(0)),
  /** Absolute expiry ceiling for a capability delegated from a parent. */
  maxExpiresAtMs: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)))
})

/**
 * What a freshly minted capability grants.
 *
 * @category models
 * @since 0.1.0
 */
export type MintRequest = typeof MintRequest.Type

/**
 * Share capability operations.
 *
 * `mint` fails with a `SyncError` when the Web Crypto signing operation
 * rejects or the absolute expiry ceiling has elapsed; `verify` fails with a
 * `SyncError` when signing rejects or the capability is refused.
 *
 * @category models
 * @since 0.1.0
 */
export interface Service {
  readonly mint: (request: MintRequest) => Effect.Effect<ShareCapability, SyncError>
  readonly verify: (
    capability: ShareCapability,
    request: AuthorizeRequest
  ) => Effect.Effect<ShareClaims, SyncError>
}

/**
 * The branch share-capability authority.
 *
 * @category services
 * @since 0.1.0
 */
export class BranchShare extends Context.Service<BranchShare, Service>()("@smthrs/sync/BranchShare") {}

const denied = shareSigner.unauthorized

/**
 * Constructs a share authority that mints nothing and trusts nothing.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeNoop = (overrides: Partial<Service> = {}): Service =>
  BranchShare.of({
    // Both operations FAIL. `mint` used to die, which contradicted its own
    // declared `Effect<ShareCapability, SyncError>` and left a consumer
    // wired to this authority unable to tell "sharing is off" from a bug.
    mint: () => Effect.fail(denied("Branch sharing is unavailable")),
    verify: () => Effect.fail(denied("Branch sharing is unavailable")),
    ...overrides
  })

/**
 * Provides a share authority that refuses every capability.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerNoop: Layer.Layer<BranchShare> = Layer.succeed(BranchShare, makeNoop())

/**
 * Domain separation: the label leads the signed encoding, so a branch
 * signature can never be replayed as a workspace signature (or any later
 * scheme's) under a shared secret. `WorkspaceShare` has always led with its
 * own label; a one-sided label protects one direction, and the branch side is
 * the one anonymous share-link holders reach.
 */
const schemeLabel = "@smthrs/sync/BranchShare/v2"

/** Length-prefixed so no two distinct claim sets share an encoding. */
const canonical = (claims: ShareClaims): string =>
  shareSigner.lengthPrefixed([
    schemeLabel,
    claims.kid,
    claims.branchId,
    claims.capabilityId,
    claims.access,
    String(claims.issuedAtMs),
    String(claims.expiresAtMs)
  ])

/**
 * The claim fields, copied out of the capability the caller owns.
 *
 * `Schema.Class` instances are not frozen, and `verify` awaits Web Crypto
 * between signing the claims and authorizing them. Reading the caller's object
 * again after the await let an in-process holder of the same instance widen
 * `access` — or move `expiresAtMs` — between the signature that was checked
 * and the checks that follow it.
 */
const snapshot = (claims: ShareClaims): ShareClaims =>
  new ShareClaims({
    kid: claims.kid,
    branchId: claims.branchId,
    capabilityId: claims.capabilityId,
    access: claims.access,
    issuedAtMs: claims.issuedAtMs,
    expiresAtMs: claims.expiresAtMs
  })

/**
 * One named signing key. The secret is `Redacted` so a keyring never renders
 * it into logs or inspection output.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type Key = shareSigner.Key

/**
 * A keyring: the key that signs new capabilities plus every key still
 * accepted for verification. Rotation adds a new active key and keeps the
 * retired one in `keys` until its outstanding links expire, so rotating the
 * branch secret no longer breaks every share link that is already out.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type Keyring = shareSigner.Keyring

/**
 * Constructs the HMAC-SHA-256 share authority over a keyring.
 *
 * Every key is imported up front, so a misconfigured keyring — an unknown
 * active kid, a duplicate kid, or a key Web Crypto refuses — fails at
 * construction rather than at the first request. Secrets enter as `Redacted`
 * values: an authority never holds a plain string that a log, a span, or an
 * inspection of the keyring could render.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeHmac = (keyring: Keyring): Effect.Effect<Service, SyncError> =>
  Effect.map(
    shareSigner.importKeyring(keyring, "branch"),
    (ring) => {
      const mint = Effect.fn("BranchShare.mint")(function*(request: MintRequest) {
        // Decoded, not read: the declared parameter type admits an empty
        // branch id, an empty capability id and a non-positive ttl that the
        // schema forbids, and reading them straight into `new ShareClaims`
        // turned a caller's bad argument into a defect out of an operation
        // whose type promises a `SyncError`. A `ttlMs` of 0 minted an
        // already-expired capability instead of being refused.
        const admitted = yield* Admission.decode(MintRequest, request, "invalid_request")
        yield* Effect.annotateCurrentSpan({ branchId: admitted.branchId, access: admitted.access })
        const issuedAtMs = yield* Clock.currentTimeMillis
        const maxExpiresAtMs = admitted.maxExpiresAtMs ?? Infinity
        if (issuedAtMs >= maxExpiresAtMs) {
          return yield* Effect.fail(denied("The share capability has expired"))
        }
        const claims = new ShareClaims({
          kid: ring.activeKid,
          branchId: admitted.branchId,
          capabilityId: admitted.capabilityId,
          access: admitted.access,
          issuedAtMs,
          expiresAtMs: Math.min(issuedAtMs + admitted.ttlMs, maxExpiresAtMs)
        })
        return new ShareCapability({
          claims,
          signature: yield* shareSigner.signHmac(ring.active, canonical(claims))
        })
      })

      const verify = Effect.fn("BranchShare.verify")(function*(
        capability: ShareCapability,
        request: AuthorizeRequest
      ) {
        yield* Effect.annotateCurrentSpan({ branchId: request.branchId, access: request.access })
        // Everything authorized below is read from these locals, never from
        // the caller's objects, which may change while Web Crypto is awaited.
        const claims = snapshot(capability.claims)
        const signature = capability.signature
        const branchId = request.branchId
        const key = ring.verification.get(claims.kid)
        if (key === undefined) {
          return yield* Effect.fail(denied("The share capability names an unknown signing key"))
        }
        yield* shareSigner.verifyClaims({
          key,
          canonical: canonical(claims),
          signature,
          expiresAtMs: claims.expiresAtMs,
          granted: claims.access,
          requested: request.access,
          subject: "The share capability",
          // The one check this authority adds, run after the signature so a
          // forged claim set is refused as a bad signature and never reported
          // back as the branch it names.
          scope: claims.branchId === branchId
            ? Effect.void
            : Effect.fail(denied(`The share capability is scoped to branch ${claims.branchId}`))
        })
        return claims
      })

      return BranchShare.of({ mint, verify })
    }
  )

/**
 * Provides the HMAC-SHA-256 share authority over a keyring.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerHmac = (keyring: Keyring): Layer.Layer<BranchShare, SyncError> =>
  Layer.effect(BranchShare, makeHmac(keyring))

/**
 * Provides the branch share authority from configuration: the secret from
 * `SMITHERS_SYNC_BRANCH_SECRET` (read as `Redacted`, never logged) and the key
 * name from `SMITHERS_SYNC_BRANCH_KEY_ID`, defaulting to `primary`. Rotation
 * beyond one configured key uses {@link layerHmac} with an explicit keyring.
 *
 * The names are the branch authority's own, not the workspace's: the scheme
 * label makes one secret in both authorities survivable, not advisable, and a
 * deployment that rotates one credential should not silently invalidate the
 * other's outstanding capabilities.
 *
 * There is deliberately no default secret: a deployment that configures
 * neither name fails to construct the authority, and every branch operation
 * stays closed.
 *
 * @category layers
 * @since 1.0.0-rc.0
 */
export const layerConfig: Layer.Layer<BranchShare, SyncError | Config.ConfigError> = Layer.effect(
  BranchShare,
  Effect.gen(function*() {
    const secret = yield* Config.Redacted("SMITHERS_SYNC_BRANCH_SECRET")
    const kid = yield* Config.String("SMITHERS_SYNC_BRANCH_KEY_ID").pipe(Config.withDefault("primary"))
    return yield* makeHmac({ activeKid: kid, keys: [{ kid, secret }] })
  })
)
