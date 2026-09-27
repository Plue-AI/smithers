/**
 * Synchronous identity construction.
 *
 * The agent side computes content fingerprints inside *pure, synchronous*
 * constructors: a prompt section's identity, a context-window segment, a
 * cell's source digest, a plan card's digest. `@smthrs/crypto` now owns that
 * policy and its only handwritten implementation. This module delegates to
 * `digestSync`.
 *
 * The digest is therefore the *same digest*: same canonical bytes, same hash,
 * same hexadecimal encoding, just reached without suspending. `Digest.test.ts`
 * pins that equivalence against the platform Crypto layer.
 *
 * @since 0.1.0
 */

import { Canonical } from "@smthrs/canonical"
import { digestSync, syncCrypto } from "@smthrs/crypto"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

/**
 * Provides the synchronous SHA-256 service to an Effect-shaped derivation.
 *
 * @category hashing
 * @since 1.0.0
 */
export const provideSync = <A, E>(effect: Effect.Effect<A, E, Crypto.Crypto>): Effect.Effect<A, E> =>
  Effect.provideService(effect, Crypto.Crypto, syncCrypto)

const runSync = <A, E>(effect: Effect.Effect<A, E, Crypto.Crypto>): A => Effect.runSync(provideSync(effect))

const decodeCanonical = Schema.decodeUnknownEffect(Canonical)

/**
 * Returns the full lowercase SHA-256 digest of UTF-8 string or byte input.
 *
 * @category hashing
 * @since 0.1.0
 * @slop
 */
export const digest = digestSync

/**
 * Returns the RFC 8785 canonical JSON serialization of a value.
 *
 * A function, symbol, `bigint`, cyclic object, non-finite number, or top-level
 * `undefined` has no canonical JSON representation. For those values this
 * throws the `SchemaError` from `effect/Schema` raised through
 * `Effect.runSync`; the canonical package's failure is not wrapped.
 *
 * @category serialization
 * @since 0.1.0
 * @slop
 */
export const canonical = (value: unknown): string => runSync(decodeCanonical(value))
