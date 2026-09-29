/**
 * Credential storage boundary.
 *
 * Credentials are capabilities. They must never enter flow input, plan
 * digests, journal payloads, or model context, so only a {@link CredentialRef}
 * — an id and a human-readable connection name — crosses the browser-safe
 * contract. Plaintext exists in exactly two places: inside a `Redacted` handed
 * to `create`/`rotate`, and inside the `Redacted` returned by `resolve`.
 *
 * The implementation composes two ports:
 *
 * - {@link CredentialStore} persists an opaque sealed record and enforces
 *   compare-and-set on writes, so concurrent rotations cannot interleave.
 * - {@link CredentialCipher} seals and opens the secret under host-managed
 *   keys. `WebCryptoCipher` is the browser and Node adapter; a host with no
 *   secure key material fails with the typed `Unavailable`.
 *
 * Authorization is a host decision, injected as {@link Options.authorize}. A
 * reference is also authenticated on every operation: caller-owned fields are
 * snapshotted before policy effects run, and a caller cannot present a forged
 * or stale `CredentialRef` because the snapshotted name must still match the
 * stored record.
 *
 * @since 0.1.0
 */

import { Context, Effect, Layer, Option, Redacted } from "effect"
import {
  type CredentialConflict,
  InvalidInput,
  type PersistenceError,
  Unauthorized,
  Unavailable
} from "./ControlError.ts"
import * as CredentialCipher from "./CredentialCipher.ts"
import * as CredentialStore from "./CredentialStore.ts"

// String.prototype.isWellFormed without the ES2024 lib, which every package
// compiling this source would also need. A loop, not a regex: a match would
// leave the rejected secret in the legacy RegExp.input static.
const wellFormed = (value: string): boolean => {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xdc00 && unit <= 0xdfff) return false
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = value.charCodeAt(++index)
      if (!(low >= 0xdc00 && low <= 0xdfff)) return false
    }
  }
  return true
}

/**
 * A journal-safe name for a stored connection credential.
 *
 * @category models
 * @since 0.1.0
 */
export interface CredentialRef {
  readonly id: string
  readonly name: string
}

/**
 * One credential operation, as seen by a host authorization policy.
 *
 * @category models
 * @since 0.1.0
 */
export type Operation = "list" | "get" | "create" | "resolve" | "rotate" | "revoke"

/**
 * Adapter-bound credential resolution. References are safe to list and
 * persist; only `resolve` crosses into a secret-bearing adapter boundary.
 *
 * @category services
 * @since 0.1.0
 */
export interface Credential {
  readonly list: () => Effect.Effect<ReadonlyArray<CredentialRef>, Unavailable | Unauthorized>
  readonly get: (id: string) => Effect.Effect<CredentialRef, Unavailable | Unauthorized>
  readonly create: (
    options: { readonly id: string; readonly name: string; readonly secret: Redacted.Redacted<string> }
  ) => Effect.Effect<CredentialRef, Unavailable | Unauthorized | CredentialConflict | InvalidInput>
  readonly resolve: (
    reference: CredentialRef
  ) => Effect.Effect<Redacted.Redacted<string>, Unavailable | Unauthorized | PersistenceError>
  readonly rotate: (
    reference: CredentialRef,
    secret: Redacted.Redacted<string>
  ) => Effect.Effect<CredentialRef, Unavailable | Unauthorized | CredentialConflict | InvalidInput>
  readonly revoke: (reference: CredentialRef) => Effect.Effect<void, Unavailable | Unauthorized>
}

/**
 * Service tag for credential resolution.
 *
 * @category services
 * @since 0.1.0
 */
export const Credential: Context.Service<Credential, Credential> = Context.Service("/control/Credential")

const unavailable = (): Unavailable =>
  new Unavailable({
    feature: "credential storage",
    ticket: "control-credential-storage"
  })

/**
 * A credential implementation that explicitly reports unavailable storage.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeNoop = (): Credential =>
  Credential.of({
    list: Effect.fn("Credential.list")(() => Effect.fail(unavailable())),
    get: Effect.fn("Credential.get")(() => Effect.fail(unavailable())),
    create: Effect.fn("Credential.create")(() => Effect.fail(unavailable())),
    resolve: Effect.fn("Credential.resolve")(() => Effect.fail(unavailable())),
    rotate: Effect.fn("Credential.rotate")(() => Effect.fail(unavailable())),
    revoke: Effect.fn("Credential.revoke")(() => Effect.fail(unavailable()))
  })

/**
 * Layer for the unavailable credential-storage boundary.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerNoop = Layer.succeed(Credential, makeNoop())

/**
 * The collaborators a working credential boundary needs.
 *
 * `authorize` is the host's policy hook. It defaults to allowing every
 * operation, which is correct for a single-principal local process; a server
 * composition supplies its own and gets typed `Unauthorized` failures for free.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options {
  readonly store: CredentialStore.Service
  readonly cipher: CredentialCipher.Service
  readonly authorize?:
    | ((operation: Operation, reference: Option.Option<CredentialRef>) => Effect.Effect<void, Unauthorized>)
    | undefined
}

const referenceOf = (value: { readonly id: string; readonly name: string }): CredentialRef =>
  Object.freeze({
    id: value.id,
    name: value.name
  })

const cipherContextOf = (
  value: { readonly id: string; readonly name: string; readonly version: number }
): CredentialCipher.Context =>
  Object.freeze({
    id: value.id,
    name: value.name,
    version: value.version
  })

const missing = (id: string): Unauthorized =>
  // Deliberately indistinguishable from a denied reference: telling an
  // unauthorized caller which ids exist is itself a leak.
  new Unauthorized({ message: `Credential ${id} is not available to this caller` })

/**
 * Constructs a working credential boundary over a store and a cipher.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (options: Options): Credential => {
  const authorize = options.authorize ?? (() => Effect.void)
  const store = options.store
  const cipher = options.cipher

  /** Reads the record `reference` names, refusing a forged or stale one. */
  const authenticate = (
    operation: Operation,
    reference: CredentialRef
  ): Effect.Effect<CredentialStore.SealedRecord, Unavailable | Unauthorized> =>
    Effect.gen(function*() {
      const snapshot = referenceOf(reference)
      yield* authorize(operation, Option.some(snapshot))
      const record = yield* store.read(snapshot.id)
      if (Option.isNone(record)) return yield* Effect.fail(missing(snapshot.id))
      if (record.value.name !== snapshot.name) return yield* Effect.fail(missing(snapshot.id))
      return record.value
    })

  const put = (
    record: CredentialStore.SealedRecord,
    secret: Redacted.Redacted<string>
  ): Effect.Effect<CredentialRef, Unavailable | CredentialConflict | InvalidInput> =>
    Effect.gen(function*() {
      if (!wellFormed(Redacted.value(secret))) {
        return yield* Effect.fail(new InvalidInput({ issue: "Credential secret must be well-formed Unicode" }))
      }
      // The metadata written beside this blob is also its authenticated data;
      // moving the blob to another id, name, or version must make it unreadable.
      const context = cipherContextOf(record)
      const sealed = yield* cipher.seal(secret, context)
      const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
      yield* store.write({ ...record, ...sealed, updatedAtMs: now })
      return referenceOf(record)
    })

  return Credential.of({
    list: Effect.fn("Credential.list")(function*() {
      yield* authorize("list", Option.none())
      const records = yield* store.list()
      return records.map(referenceOf)
    }),
    get: Effect.fn("Credential.get")(function*(id) {
      const record = yield* store.read(id)
      if (Option.isNone(record)) return yield* Effect.fail(missing(id))
      const reference = referenceOf(record.value)
      yield* authorize("get", Option.some(reference))
      return reference
    }),
    create: Effect.fn("Credential.create")(function*(input) {
      const snapshot = Object.freeze({
        reference: referenceOf(input),
        secret: input.secret
      })
      yield* authorize("create", Option.some(snapshot.reference))
      return yield* put(
        {
          id: snapshot.reference.id,
          name: snapshot.reference.name,
          ciphertext: "",
          nonce: "",
          version: 1,
          updatedAtMs: 0
        },
        snapshot.secret
      )
    }),
    resolve: Effect.fn("Credential.resolve")(function*(reference) {
      const record = yield* authenticate("resolve", reference)
      return yield* cipher.open(
        { ciphertext: record.ciphertext, nonce: record.nonce },
        cipherContextOf(record)
      )
    }),
    rotate: Effect.fn("Credential.rotate")(function*(reference, secret) {
      const record = yield* authenticate("rotate", reference)
      return yield* put({ ...record, version: record.version + 1 }, secret)
    }),
    revoke: Effect.fn("Credential.revoke")(function*(reference) {
      const record = yield* authenticate("revoke", reference)
      yield* store.remove(record.id)
    })
  })
}

/**
 * Provides a working credential boundary over the ambient store and cipher.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = (
  options: { readonly authorize?: Options["authorize"] } = {}
): Layer.Layer<
  Credential,
  never,
  CredentialStore.CredentialStore | CredentialCipher.CredentialCipher
> =>
  Layer.effect(Credential)(Effect.gen(function*() {
    const store = yield* CredentialStore.CredentialStore
    const cipher = yield* CredentialCipher.CredentialCipher
    return make({ store, cipher, ...(options.authorize === undefined ? {} : { authorize: options.authorize }) })
  }))
