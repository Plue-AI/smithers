/**
 * R2 adapter for the content-store contract.
 *
 * @since 0.1.0
 */

import { CacheFailure } from "./cache-failure.ts"
import { constantTimeEquals } from "./constantTimeEquals.ts"
import { digestBytes } from "./digestBytes.ts"
import { discardBody } from "./discardBody.ts"
import { type ContentStore, maxArtifactBodyBytes } from "./protocol.ts"

const findMissingConcurrency = 16
const maxPublicationAttempts = 3

/**
 * Refuses an object the provider should never have returned.
 *
 * A wrong key or an impossible size is a broken bucket, not a repairable
 * object: no client republication would change the answer, so it stays a
 * storage refusal.
 */
const assertObjectShape = (digest: string, object: R2Object): void => {
  if (
    object.key !== digest ||
    !Number.isSafeInteger(object.size) ||
    object.size < 0 ||
    object.size > maxArtifactBodyBytes
  ) {
    throw new CacheFailure(
      "R2_OBJECT_INVALID",
      "r2.validate",
      "R2 returned an object outside the content-store invariant"
    )
  }
}

/**
 * Reports why a well-shaped object's checksum does not prove its address.
 *
 * Returns `null` when the checksum verifies. Every other answer names the
 * single failed check and is safe to log: it carries the content address and
 * never the object's bytes. This is the repairable half of the invariant, the
 * one a client republication fixes.
 */
const contentChecksumFault = (digest: string, object: R2Object): string | null => {
  const checksum = object.checksums.sha256
  if (checksum === undefined) return "R2 returned an object without a SHA-256 checksum"
  if (!constantTimeEquals(new Uint8Array(checksum), digestBytes(digest))) {
    return "R2 returned an object with a mismatched SHA-256 checksum"
  }
  return null
}

const assertContentObject = (digest: string, object: R2Object): void => {
  assertObjectShape(digest, object)
  const fault = contentChecksumFault(digest, object)
  if (fault !== null) throw new CacheFailure("R2_CHECKSUM_INVALID", "r2.validate", fault)
}

/**
 * Reports an unverifiable object as absent so the client republishes it.
 *
 * A stored object whose provider checksum is missing or wrong is not CAS
 * content, and only `put` can repair it. Refusing the read instead would
 * answer `503`, which the client retries rather than treating as a miss, so
 * the digest would stay wedged for as long as the object survives.
 */
const reportAbsent = (digest: string, fault: string): void => {
  console.error(`smithers build cache: ${fault}; reporting ${digest} absent so a publisher repairs it`)
}

/**
 * Adapts R2 to the checksum-verifying content-store contract.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeContentStore = (bucket: R2Bucket): ContentStore => ({
  async get(digest) {
    const object = await bucket.get(digest)
    if (object === null) return null
    try {
      assertObjectShape(digest, object)
    } catch (failure) {
      // The refused object's body would otherwise stay open until the
      // runtime collects it.
      void discardBody(object.body)
      throw failure
    }
    const fault = contentChecksumFault(digest, object)
    if (fault !== null) {
      reportAbsent(digest, fault)
      void discardBody(object.body)
      return null
    }
    return { body: object.body }
  },
  async has(digest) {
    const object = await bucket.head(digest)
    if (object === null) return false
    assertObjectShape(digest, object)
    const fault = contentChecksumFault(digest, object)
    if (fault === null) return true
    reportAbsent(digest, fault)
    return false
  },
  async put(digest, bytes) {
    const options = {
      httpMetadata: { contentType: "application/octet-stream" },
      sha256: digestBytes(digest)
    } as const
    for (let attempt = 0; attempt < maxPublicationAttempts; attempt += 1) {
      const object = await bucket.put(digest, bytes, {
        ...options,
        onlyIf: new Headers({ "if-none-match": "*" })
      })
      if (object !== null) {
        assertContentObject(digest, object)
        return "inserted"
      }
      const existing = await bucket.head(digest)
      if (existing === null) continue
      try {
        assertContentObject(digest, existing)
        return "present"
      } catch {
        // A conditional miss proves an object owns this digest, but an absent
        // or mismatched provider checksum means it is not CAS content. The
        // request body was already address-verified by the protocol, so an
        // unconditional write is a deterministic repair. A concurrent repair
        // writes the same bytes and checksum and is therefore harmless.
        const repaired = await bucket.put(digest, bytes, options)
        if (repaired === null) {
          throw new CacheFailure(
            "R2_REPAIR_MISSING",
            "contentStore.put",
            "R2 did not return the repaired content object"
          )
        }
        assertContentObject(digest, repaired)
        return "inserted"
      }
    }
    throw new CacheFailure(
      "R2_PUBLICATION_LOST",
      "contentStore.put",
      "R2 conditional publication lost its object repeatedly"
    )
  },
  async presentDigests(digests) {
    const present = new Set<string>()
    for (let offset = 0; offset < digests.length; offset += findMissingConcurrency) {
      const batch = digests.slice(offset, offset + findMissingConcurrency)
      const probes = await Promise.all(
        batch.map(async (digest) => ({ digest, object: await bucket.head(digest) }))
      )
      for (const { digest, object } of probes) {
        if (object === null) continue
        assertObjectShape(digest, object)
        const fault = contentChecksumFault(digest, object)
        if (fault === null) {
          present.add(digest)
          continue
        }
        // One unverifiable object must not fail the whole batch: the client
        // needs the rest of the answer, and reporting this digest missing is
        // what makes it republish the bytes that repair the object.
        reportAbsent(digest, fault)
      }
    }
    return present
  }
})
