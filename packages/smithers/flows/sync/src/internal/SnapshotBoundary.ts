/** Snapshot validation shared by the hosted and browser-side boundaries.
 * @since 1.0.0-rc.0
 */

import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { SyncError } from "../SyncError.ts"
import * as Protocol from "../SyncProtocol.ts"
import { causeCode } from "./CauseText.ts"
import { requireVersion } from "./ProtocolVersion.ts"

/** Decode a detached request before callbacks can mutate its expected identity.
 * @category validation
 * @since 1.0.0-rc.0
 */
export const request = (value: unknown): Effect.Effect<Protocol.SnapshotRequest, SyncError> =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(Protocol.SnapshotRequest)(value, { onExcessProperty: "error" }),
    catch: (cause) =>
      new SyncError({ code: "invalid_request", message: "Invalid public snapshot request", cause: causeCode(cause) })
  }).pipe(
    // The schema admits any integer version so this refusal, not a decode
    // failure, is what a version mismatch produces here as on every other RPC.
    Effect.tap((decoded) => requireVersion(decoded.protocolVersion)),
    Effect.map((decoded) => ({ ...decoded }))
  )

/** Copy JSON bytes once, bound them, then check the exact requested projection.
 * @category validation
 * @since 1.0.0-rc.0
 */
export const response = (
  expected: Protocol.SnapshotRequest,
  value: unknown,
  maxBytes: number
): Effect.Effect<Protocol.Snapshot, SyncError> =>
  Effect.gen(function*() {
    const text = yield* Effect.try({
      try: () => JSON.stringify(value),
      catch: (cause) =>
        new SyncError({
          code: "decode_failed",
          message: "Public snapshot is not JSON encodable",
          cause: causeCode(cause)
        })
    })
    if (text === undefined) {
      return yield* Effect.fail(
        new SyncError({ code: "decode_failed", message: "Public snapshot is missing", cause: "undefined" })
      )
    }
    if (new TextEncoder().encode(text).length > maxBytes) {
      return yield* Effect.fail(
        new SyncError({ code: "frame_too_large", message: "Public snapshot exceeds the response byte limit" })
      )
    }
    const snapshot = yield* Effect.try({
      try: () => {
        // JSON.stringify alone silently drops undefined/functions and turns
        // non-finite numbers into null. Reject such provider values rather than
        // returning a different state under the same checkpoint sequence.
        Schema.decodeUnknownSync(Protocol.Snapshot)(value, { onExcessProperty: "error" })
        return Schema.decodeUnknownSync(Protocol.Snapshot)(JSON.parse(text), { onExcessProperty: "error" })
      },
      catch: (cause) =>
        new SyncError({ code: "decode_failed", message: "Invalid public snapshot response", cause: causeCode(cause) })
    })
    yield* requireVersion(snapshot.protocolVersion)
    if (
      snapshot.runId !== expected.runId || snapshot.lineageId !== expected.lineageId ||
      snapshot.projection !== expected.projection || snapshot.projectionVersion !== expected.projectionVersion
    ) {
      return yield* Effect.fail(
        new SyncError({
          code: "protocol_violation",
          message: "Public snapshot identity does not match the request",
          cause: "snapshot_identity_mismatch"
        })
      )
    }
    if (snapshot.seq < expected.atLeastSeq) {
      return yield* Effect.fail(
        new SyncError({
          code: "compacted",
          message: "Public snapshot does not cover the required history",
          resync: { runId: expected.runId, checkpointSeq: expected.atLeastSeq }
        })
      )
    }
    return snapshot
  })
