/**
 * Named reusable filesystem declaration groups.
 *
 * @since 0.1.0
 */

import { Filegroup, makeFilegroup } from "@smthrs/plan/FileSet"
export { Filegroup }
export type { Filegroup as Type } from "@smthrs/plan/FileSet"
/**
 * Creates a named filegroup.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = makeFilegroup
