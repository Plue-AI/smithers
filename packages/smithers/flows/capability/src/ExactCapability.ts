/**
 * The exact capability value.
 *
 * The class is named `Capability`, and `Capability.ts` is the module barrel
 * that re-exports it, so the definition lives here to keep the barrel free of
 * a runtime cycle with the constructors and parsers that instantiate it.
 *
 * @since 0.1.0
 */

import { type Brand, Schema } from "effect"
import { Action } from "./Action.ts"
import { PatternResource } from "./internal/PatternResource.ts"

/**
 * An exact adapter request subject to authorization.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export class Capability extends Schema.Class<Capability, Brand.Brand<"@smthrs/capability/Capability">>(
  "@smthrs/capability/Capability"
)({
  action: Action,
  resource: PatternResource
}) {}
