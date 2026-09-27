/**
 * Browser-safe encryption port for credential material.
 *
 * The cipher is the only place plaintext exists outside a `Redacted`. Keys are
 * host-managed: an adapter receives a key from its host and never persists one
 * through {@link CredentialStore}, so a stolen store is ciphertext and nothing
 * else.
 *
 * @since 0.1.0
 */

import { Context as EffectContext, Effect, Layer, type Redacted } from "effect"
import { type PersistenceError, Unavailable } from "./ControlError.ts"

/**
 * One encrypted secret: base64 ciphertext and the nonce it was sealed under.
 *
 * @category models
 * @since 0.1.0
 */
export interface Sealed {
  readonly ciphertext: string
  readonly nonce: string
}

/**
 * Credential metadata authenticated with one sealed secret.
 *
 * Every field is immutable because the same values must be written beside the
 * ciphertext and supplied again when it is opened.
 *
 * @category models
 * @since 0.1.0
 */
export interface Context {
  readonly id: string
  readonly name: string
  readonly version: number
}

/**
 * Authenticated encryption over credential plaintext.
 *
 * @category services
 * @since 0.1.0
 */
export interface Service {
  readonly seal: (plaintext: Redacted.Redacted<string>, context: Context) => Effect.Effect<Sealed, Unavailable>
  /**
   * Fails with `PersistenceError` on operation `credential.open` when the
   * record does not open: a malformed nonce, or ciphertext that fails
   * authentication under this key and context.
   */
  readonly open: (
    sealed: Sealed,
    context: Context
  ) => Effect.Effect<Redacted.Redacted<string>, Unavailable | PersistenceError>
}

/**
 * Service key for credential encryption.
 *
 * @category services
 * @since 0.1.0
 */
export class CredentialCipher extends EffectContext.Service<CredentialCipher, Service>()(
  "/control/CredentialCipher"
) {}

/**
 * Constructs a cipher from an implementation record.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (implementation: Service): Service => CredentialCipher.of(implementation)

/**
 * The typed failure a host reports when no secure key material is reachable.
 *
 * @category constructors
 * @since 0.1.0
 */
export const unavailable = (): Unavailable =>
  new Unavailable({
    feature: "credential encryption",
    ticket: "control-credential-storage"
  })

/**
 * A cipher that reports unavailable key material for every operation.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeNoop = (overrides: Partial<Service> = {}): Service =>
  make({
    seal: Effect.fn("CredentialCipher.seal")(() => Effect.fail(unavailable())),
    open: Effect.fn("CredentialCipher.open")(() => Effect.fail(unavailable())),
    ...overrides
  })

/**
 * Provides a cipher that reports unavailable key material.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerNoop = (overrides: Partial<Service> = {}): Layer.Layer<CredentialCipher> =>
  Layer.succeed(CredentialCipher)(makeNoop(overrides))
