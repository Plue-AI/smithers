/** The one protocol-version comparison every sync boundary answers with.
 * @since 1.0.0-rc.0
 */

import * as Effect from "effect/Effect"
import { SyncError } from "../SyncError.ts"
import { protocolVersion } from "../SyncProtocol.ts"

/** Refuse a version this revision does not speak, on every path, with one code.
 *
 * Read, subscribe and snapshot all decode a mismatched version so the refusal
 * is this typed `protocol_violation` rather than three different decode
 * failures, and the accepted number is only ever
 * {@link SyncProtocol.protocolVersion}.
 *
 * @category validation
 * @since 1.0.0-rc.0
 */
export const requireVersion = (version: number | undefined): Effect.Effect<void, SyncError> =>
  version === protocolVersion
    ? Effect.void
    : Effect.fail(
      new SyncError({
        code: "protocol_violation",
        message: `Expected sync protocol version ${protocolVersion}; received ${version}`,
        cause: "protocol_version_mismatch"
      })
    )
