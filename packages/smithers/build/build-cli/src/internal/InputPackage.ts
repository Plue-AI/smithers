/**
 * Input anchoring shared by CLI planning and declaration projections.
 * @since 1.0.0
 */

import * as Input from "@smthrs/targets/Input"
import type * as Target from "@smthrs/targets/Target"

/**
 * Filegroup's explicit cwd is a workspace-relative input anchor, not ownership.
 * @private
 * @since 1.0.0
 */
export const inputPackage = (metadata: Target.Metadata, declaringPackage: string): string => {
  if (metadata.target !== "Filegroup") return declaringPackage
  const cwd = (metadata.attrs as { readonly cwd: string }).cwd
  if (cwd === ".") return declaringPackage
  const resolved = Input.resolvePath("", cwd)
  return resolved === "." ? "" : resolved
}
