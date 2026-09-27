/**
 * Workspace share capabilities: the credential a sync connection presents to
 * read the workspace's non-branch runs.
 *
 * The scheme extends the branch share shape rather than inventing a parallel
 * one: a claim set and an HMAC-SHA-256 signature over its length-prefixed
 * canonical encoding, verified with a constant-time comparison. Two things
 * are added. A `kid` names the signing key inside the claims, so keys rotate
 * without invalidating capabilities minted under a retired key that is still
 * in the verification keyring. And the canonical encoding starts with a
 * scheme label, so a workspace capability can never verify as a branch
 * capability even if one secret is misconfigured into both authorities.
 *
 * Secrets enter through {@link Key} as `Redacted` values — a keyring never
 * holds a plain string — and {@link layerConfig} provisions the keyring from
 * configuration without any secret appearing in code.
 *
 * @since 0.1.0
 */

import * as Clock from "effect/Clock"
import * as Config from "effect/Config"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { Access } from "./BranchProtocol.ts"
import * as Admission from "./internal/Admission.ts"
import * as shareSigner from "./internal/ShareSigner.ts"
import type { SyncError } from "./SyncError.ts"

/**
 * Schema for the claims a workspace capability carries.
 *
 * `kid` names the key that signed the claims and is itself signed, so a
 * verifier both selects the right key and refuses a capability whose key
 * name was swapped after minting.
 *
 * @category schemas
 * @since 0.1.0
 */
export class WorkspaceClaims extends Schema.Class<WorkspaceClaims>("@smthrs/sync/WorkspaceShare/WorkspaceClaims")({
  kid: Schema.NonEmptyString,
  capabilityId: Schema.NonEmptyString,
  access: Access,
  issuedAtMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  expiresAtMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
}) {}

/**
 * Schema for a signed, expiring, workspace-scoped capability.
 *
 * @category schemas
 * @since 0.1.0
 */
export class WorkspaceCapability extends Schema.Class<WorkspaceCapability>(
  "@smthrs/sync/WorkspaceShare/WorkspaceCapability"
)({
  claims: WorkspaceClaims,
  signature: Schema.String
}) {}

/**
 * The access one authorization request needs.
 *
 * @category models
 * @since 0.1.0
 */
export interface AuthorizeRequest {
  readonly access: Access
}

/**
 * What a freshly minted workspace capability grants.
 *
 * @category models
 * @since 0.1.0
 */
export const MintRequest = Schema.Struct({
  capabilityId: Schema.NonEmptyString,
  access: Access,
  ttlMs: Schema.Int.check(Schema.isGreaterThan(0))
})

/**
 * What a freshly minted workspace capability grants.
 *
 * @category models
 * @since 0.1.0
 */
export type MintRequest = typeof MintRequest.Type

/**
 * Workspace share capability operations.
 *
 * `mint` fails with a `SyncError` when the Web Crypto signing operation
 * rejects; `verify` fails with a `SyncError` when signing rejects or the
 * capability is refused.
 *
 * @category models
 * @since 0.1.0
 */
export interface Service {
  readonly mint: (request: MintRequest) => Effect.Effect<WorkspaceCapability, SyncError>
  readonly verify: (
    capability: WorkspaceCapability,
    request: AuthorizeRequest
  ) => Effect.Effect<WorkspaceClaims, SyncError>
}

/**
 * The workspace share-capability authority.
 *
 * @category services
 * @since 0.1.0
 */
export class WorkspaceShare extends Context.Service<WorkspaceShare, Service>()("@smthrs/sync/WorkspaceShare") {}

const denied = shareSigner.unauthorized

/**
 * Constructs a workspace share authority that mints nothing and trusts
 * nothing.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeNoop = (overrides: Partial<Service> = {}): Service =>
  WorkspaceShare.of({
    // Both operations FAIL. `mint` used to die, and this is the authority the
    // shipped CLI gateway wires, so a consumer handling `SyncError` on that
    // composition got a crash where the type promised a refusal.
    mint: () => Effect.fail(denied("Workspace sharing is unavailable")),
    verify: () => Effect.fail(denied("Workspace sharing is unavailable")),
    ...overrides
  })

/**
 * Provides a workspace share authority that refuses every capability.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerNoop: Layer.Layer<WorkspaceShare> = Layer.succeed(WorkspaceShare, makeNoop())

/**
 * One named signing key. The secret is `Redacted` so a keyring never renders
 * it into logs or inspection output.
 *
 * @category models
 * @since 0.1.0
 */
export type Key = shareSigner.Key

/**
 * A keyring: the key that signs new capabilities plus every key still
 * accepted for verification. Rotation adds a new active key and keeps the
 * retired one in `keys` until its outstanding capabilities expire.
 *
 * @category models
 * @since 0.1.0
 */
export type Keyring = shareSigner.Keyring

/**
 * Domain separation: the label leads the signed encoding, so a workspace
 * signature can never be replayed as any other scheme's signature under a
 * shared secret.
 */
const schemeLabel = "@smthrs/sync/WorkspaceShare/v1"

const canonical = (claims: WorkspaceClaims): string =>
  shareSigner.lengthPrefixed([
    schemeLabel,
    claims.kid,
    claims.capabilityId,
    claims.access,
    String(claims.issuedAtMs),
    String(claims.expiresAtMs)
  ])

/**
 * The claim fields, copied out of the capability the caller owns.
 *
 * `Schema.Class` instances are not frozen, and `verify` awaits Web Crypto
 * between signing the claims and authorizing them, so the checks must read a
 * snapshot rather than an object the caller can still mutate.
 */
const snapshot = (claims: WorkspaceClaims): WorkspaceClaims =>
  new WorkspaceClaims({
    kid: claims.kid,
    capabilityId: claims.capabilityId,
    access: claims.access,
    issuedAtMs: claims.issuedAtMs,
    expiresAtMs: claims.expiresAtMs
  })

/**
 * Constructs the HMAC-SHA-256 workspace share authority over a keyring.
 *
 * Every key is imported up front, so a misconfigured keyring — an unknown
 * active kid, a duplicate kid, or a key Web Crypto refuses — fails at
 * construction rather than at the first request.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeHmac = (keyring: Keyring): Effect.Effect<Service, SyncError> =>
  Effect.map(
    shareSigner.importKeyring(keyring, "workspace"),
    (ring) => {
      const mint = Effect.fn("WorkspaceShare.mint")(function*(request: MintRequest) {
        // Decoded, not read: the declared parameter type admits an empty
        // capability id and a `ttlMs` of 0 or NaN that the schema forbids, and
        // reading them straight into `new WorkspaceClaims` turned a caller's
        // bad argument into a defect out of an operation whose type promises a
        // `SyncError`.
        const admitted = yield* Admission.decode(MintRequest, request, "invalid_request")
        yield* Effect.annotateCurrentSpan({ access: admitted.access })
        const issuedAtMs = yield* Clock.currentTimeMillis
        const claims = new WorkspaceClaims({
          kid: ring.activeKid,
          capabilityId: admitted.capabilityId,
          access: admitted.access,
          issuedAtMs,
          expiresAtMs: issuedAtMs + admitted.ttlMs
        })
        return new WorkspaceCapability({
          claims,
          signature: yield* shareSigner.signHmac(ring.active, canonical(claims))
        })
      })

      const verify = Effect.fn("WorkspaceShare.verify")(function*(
        capability: WorkspaceCapability,
        request: AuthorizeRequest
      ) {
        yield* Effect.annotateCurrentSpan({ access: request.access })
        // Everything authorized below is read from these locals, never from the
        // caller's objects, which may change while Web Crypto is awaited.
        const claims = snapshot(capability.claims)
        const signature = capability.signature
        const key = ring.verification.get(claims.kid)
        if (key === undefined) {
          return yield* Effect.fail(denied("The workspace capability names an unknown signing key"))
        }
        yield* shareSigner.verifyClaims({
          key,
          canonical: canonical(claims),
          signature,
          expiresAtMs: claims.expiresAtMs,
          granted: claims.access,
          requested: request.access,
          subject: "The workspace capability"
        })
        return claims
      })

      return WorkspaceShare.of({ mint, verify })
    }
  )

/**
 * Provides the HMAC-SHA-256 workspace share authority over a keyring.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerHmac = (keyring: Keyring): Layer.Layer<WorkspaceShare, SyncError> =>
  Layer.effect(WorkspaceShare, makeHmac(keyring))

/**
 * Provides the workspace share authority from configuration: the secret from
 * `SMITHERS_SYNC_SECRET` (read as `Redacted`, never logged) and the key name
 * from `SMITHERS_SYNC_KEY_ID`, defaulting to `primary`. Rotation beyond one
 * configured key uses {@link layerHmac} with an explicit keyring.
 *
 * There is deliberately no default secret: a deployment that configures
 * neither name fails to construct the authority, and the read path stays
 * closed.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerConfig: Layer.Layer<WorkspaceShare, SyncError | Config.ConfigError> = Layer.effect(
  WorkspaceShare,
  Effect.gen(function*() {
    const secret = yield* Config.Redacted("SMITHERS_SYNC_SECRET")
    const kid = yield* Config.String("SMITHERS_SYNC_KEY_ID").pipe(Config.withDefault("primary"))
    return yield* makeHmac({ activeKid: kid, keys: [{ kid, secret }] })
  })
)
