/**
 * One ordered policy rule: a capability pattern and the decision it applies.
 *
 * @since 0.1.0
 */

import { Schema } from "effect"
import { CapabilityPattern } from "./Capability.ts"
import { RuleEffect } from "./RuleEffect.ts"

/**
 * A capability pattern and the decision it applies.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export class Rule extends Schema.Class<Rule>("@smthrs/capability/Rule")({
  effect: RuleEffect,
  // Require a constructed pattern at the type boundary; decoding still uses
  // the original wire schema. Nested Class construction would coerce requests.
  pattern: CapabilityPattern.pipe(Schema.decodeTo(Schema.declare(Schema.is(CapabilityPattern))))
}) {}
