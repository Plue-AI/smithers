/**
 * The resource field schema shared by exact capabilities and patterns.
 *
 * @since 0.1.0
 */

import { Schema } from "effect"
import { maxResourceLength } from "../maxResourceLength.ts"

/**
 * @since 0.1.0
 * @private
 */
export const PatternResource = Schema.String.check(Schema.isMaxLength(maxResourceLength))
