/**
 * Fixed diagnostics for internal cache refusals.
 *
 * @since 0.1.0
 */

import * as Data from "effect/Data"

/**
 * The fixed code of one internal cache refusal.
 *
 * @category models
 * @since 0.1.0
 */
export type CacheFailureCode =
  | "AC_BODY_INVALID"
  | "AC_DELETION_INVALID"
  | "AC_JSON_INVALID"
  | "AC_KEY_MISMATCH"
  | "AC_PUBLICATION_INVALID"
  | "CAS_BODY_INVALID"
  | "CAS_DIGEST_SET_INVALID"
  | "CAS_DIGEST_UNREQUESTED"
  | "CAS_OBJECT_INVALID"
  | "CAS_PRESENCE_INVALID"
  | "CAS_PUBLICATION_INVALID"
  | "D1_PUBLICATION_LOST"
  | "D1_READINESS_INVALID"
  | "D1_RESULT_INVALID"
  | "D1_RESULT_NON_CANONICAL"
  | "DEPENDENCY_FAILED"
  | "DEPENDENCY_OCCUPIED"
  | "OPERATION_STOPPED"
  | "R2_CHECKSUM_INVALID"
  | "R2_OBJECT_INVALID"
  | "R2_PUBLICATION_LOST"
  | "R2_REPAIR_MISSING"
  | "READINESS_CANCELLED"
  | "RETENTION_FAILED"
  | "STREAM_READ_FAILED"

/**
 * The fixed internal operation a cache refusal belongs to.
 *
 * @category models
 * @since 0.1.0
 */
export type CacheOperation =
  | "actionCache.get"
  | "actionCache.put"
  | "actionCache.delete"
  | "contentStore.get"
  | "contentStore.has"
  | "contentStore.put"
  | "contentStore.presentDigests"
  | "credentialBudget.charge"
  | "health"
  | "wait"
  | "r2.validate"
  | "retention"

/**
 * An internally authored refusal with stable, payload-free diagnostic fields.
 *
 * Codes and operations are fixed at call sites. Messages remain useful to
 * direct adapter callers but are never included in Worker request logs or
 * response bodies. `name` stays `CacheFailure` so the request log, which
 * accepts only identifier-shaped names, still attributes it.
 *
 * @category errors
 * @since 0.1.0
 */
export class CacheFailure extends Data.TaggedError("@smthrs/build-infra/CacheFailure")<{
  readonly code: CacheFailureCode
  readonly operation: CacheOperation
  readonly message: string
  readonly cause?: unknown
}> {
  override readonly name = "CacheFailure"

  constructor(code: CacheFailureCode, operation: CacheOperation, message: string, options?: ErrorOptions) {
    super(options === undefined ? { code, operation, message } : { code, operation, message, cause: options.cause })
  }
}
