/**
 * Recovery of the structured permission failure a `PlatformError` carries.
 *
 * @since 0.1.0
 */

import { Option } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { isPermissionError } from "./isPermissionError.ts"
import type { PermissionErrorPayload } from "./PermissionErrorPayload.ts"

/**
 * Recovers the structured permission failure a `toPlatformError`
 * projection carries, so an attended surface can still reply to the request
 * and an unattended report can still name the capability. Any PermissionDenied
 * reason with a valid structural cause is accepted, including foreign errors.
 * Callers crossing a trust boundary must establish producer or request identity
 * separately. The result guarantees data fields, not class operations.
 *
 * @category refinements
 * @since 0.1.0
 * @slop
 */
export const fromPlatformError = (error: PlatformError): Option.Option<PermissionErrorPayload> =>
  error.reason._tag === "PermissionDenied" && isPermissionError(error.reason.cause)
    ? Option.some(error.reason.cause)
    : Option.none()
