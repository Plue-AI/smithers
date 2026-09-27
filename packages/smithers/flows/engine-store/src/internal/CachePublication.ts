/**
 * The two-tier step-cache protocol, extracted out of `ActionPersistence`.
 *
 * `CacheAdmission` classifies the evidence that permits publication;
 * `ActionPersistence` supplies the measured facts and durable ordering. This module owns *how* it becomes
 * shareable and how a shared hit is made replayable, which is the half a
 * two-tier composition has to be able to inject into:
 *
 * - {@link publishArtifacts} runs before the cache entry is written, so an
 *   entry is never observable while an artifact it references is missing
 *   (`reference/bazel/.../remote/UploadManifest.java:630-633`).
 * - {@link publishEntry} runs after the transaction that made the local row
 *   durable, so the shared entry lands last of all — and outside the write
 *   transaction.
 * - {@link hydrateArtifacts} runs after a replay refused for a *missing*
 *   artifact — the one refusal a shared tier can repair — so the replay is
 *   retried once against fetched bytes instead of falling straight through to
 *   a real execution.
 *
 * The seams are `ArtifactSync` and `CacheSync`, both resolved optionally: a
 * composition with no shared tier gets the `makeLocal()` implementations, whose
 * publish steps are no-ops and whose `hydrate` reports nothing was fetched.
 * That is why a purely local engine pays nothing for this file.
 *
 * Every host call here stays OUTSIDE the `DurableWriter` transaction, like the
 * Jj snapshot and the boundary prepare/settle: a host call must never be held
 * across a write transaction.
 *
 * Neither publication step can fail a run. A shared cache is an accelerator,
 * and by the time these run the result is already durably recorded on this
 * host — failing a completed run because an optional tier is unreachable trades
 * a real result for an unavailable one. Both report the refusal instead, and
 * the caller journals it, exactly as an unverified read set is journaled rather
 * than swallowed.
 *
 * @since 0.1.0
 */

import type { CacheStore } from "@smthrs/step-cache"
import * as Cause from "effect/Cause"
import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as ArtifactSync from "../ArtifactSync.ts"
import * as CacheSync from "../CacheSync.ts"
import * as StepBoundary from "../StepBoundary.ts"

/** Resolves the configured protocol, defaulting to the single-tier one. */
const sync: Effect.Effect<ArtifactSync.Service> = Effect.map(
  Effect.serviceOption(ArtifactSync.ArtifactSync),
  (configured) => Option.isSome(configured) ? configured.value : ArtifactSync.makeLocal()
)

/** Resolves the configured entry publisher, defaulting to the single-tier one. */
const entrySync: Effect.Effect<CacheSync.Service> = Effect.map(
  Effect.serviceOption(CacheSync.CacheSync),
  (configured) => Option.isSome(configured) ? configured.value : CacheSync.makeLocal()
)

/**
 * Why a recorded result could not be shared, when it could not be.
 *
 * @since 0.1.0
 * @category models
 */
export interface Unshareable {
  /** Which half of the two-tier publication refused. */
  readonly stage: "artifacts" | "entry"
  readonly message: string
}

/**
 * Makes every artifact the evidence references durable in the shared tier,
 * reporting a refusal rather than failing.
 *
 * Called immediately before the transaction that records the cache entry, and
 * never inside it. A refusal means the entry must not be published to the
 * shared tier — the whole point of the ordering constraint — but says nothing
 * about the *local* row, which stays as valid as it ever was.
 *
 * @since 0.1.0
 * @category protocol
 */
export const publishArtifacts = (
  evidence: StepBoundary.BoundaryEvidence | undefined
): Effect.Effect<Unshareable | undefined, never, Crypto.Crypto> =>
  Effect.gen(function*() {
    if (evidence === undefined) return undefined
    const digests = StepBoundary.referencedDigests(evidence)
    if (digests.length === 0) return undefined
    const protocol = yield* sync
    return yield* protocol.publish(digests).pipe(
      Effect.as(undefined),
      Effect.catch((failure) => Effect.succeed<Unshareable>({ stage: "artifacts", message: failure.message }))
    )
  })

/**
 * Publishes the recorded entry to the shared step-result tier, reporting a
 * refusal rather than failing.
 *
 * Called only after {@link publishArtifacts} reported success and only after
 * the transaction that made the local row durable has committed: blobs first,
 * entry last, and no network round trip held across a write transaction.
 *
 * @since 0.1.0
 * @category protocol
 */
export const publishEntry = (
  entry: CacheStore.CacheEntry
): Effect.Effect<Unshareable | undefined> =>
  Effect.gen(function*() {
    const protocol = yield* entrySync
    const refused = yield* protocol.publishEntry(entry)
    return Option.isSome(refused) ? { stage: "entry" as const, message: refused.value.message } : undefined
  })

/**
 * Fetches the artifacts a replay could not resolve locally, reporting whether
 * the replay is now worth retrying.
 *
 * @since 0.1.0
 * @category protocol
 */
export const hydrateArtifacts = (
  evidence: StepBoundary.BoundaryEvidence
): Effect.Effect<boolean, never, Crypto.Crypto> =>
  Effect.gen(function*() {
    const digests = StepBoundary.referencedDigests(evidence)
    if (digests.length === 0) return false
    const protocol = yield* sync
    return yield* protocol.hydrate(digests)
  })

/**
 * The classification a `replayOutputs` failure needs before it can be
 * repaired: a {@link StepBoundary.MissingArtifact} means the bytes are simply
 * not on this host, which a shared tier may fix. Anything else — a corrupt
 * address, a host refusal — is not a fetchable condition.
 *
 * @since 0.1.0
 * @category protocol
 */
export const replayMissingArtifact = (
  cause: Cause.Cause<unknown>
): StepBoundary.MissingArtifact | undefined => {
  for (const reason of cause.reasons) {
    if (Cause.isFailReason(reason) && reason.error instanceof StepBoundary.MissingArtifact) {
      return reason.error
    }
  }
  return undefined
}
