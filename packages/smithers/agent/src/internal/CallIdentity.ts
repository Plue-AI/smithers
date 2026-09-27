/** Shared identity construction for native facts and the legacy control trail.
 * @since 1.0.0
 */

import * as Digest from "@smthrs/core/Digest"
import type * as Cell from "@smthrs/harness/Cell"
import * as CanonicalJson from "@smthrs/model/CanonicalJson"

/** Exact pre-existing cell-call-v1 contract, without publication coordinates.
 * @category projections
 * @since 1.0.0
 */
export const callId = (identity: Cell.CallIdentity): string =>
  `cell-call-v1:${
    Digest.digest(CanonicalJson.stringify({
      session: identity.session,
      frame: identity.frame,
      cell: identity.cell,
      ordinal: identity.ordinal,
      declaration: identity.declaration,
      layers: identity.layers
    }))
  }`
