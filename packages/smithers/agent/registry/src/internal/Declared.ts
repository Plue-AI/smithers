/**
 * Schema/metadata records matching the FlowBinding.Declared contract.
 *
 * @since 0.1.0
 */

import * as Effects from "@smthrs/plan/Effects"
import * as Context from "effect/Context"
import * as Schema from "effect/Schema"
import { BudgetCeiling, FlowBudget, ModelSelection } from "../Descriptor.ts"

/**
 * The schema and metadata fields accepted at module admission.
 * @since 0.1.0
 * @private
 */
export const Declared = Schema.Struct({
  name: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  input: Schema.declare(Schema.isSchema),
  output: Schema.declare(Schema.isSchema),
  capabilities: Schema.Array(Schema.String),
  effects: Schema.Union([
    Schema.Undefined,
    Schema.Struct({
      reads: Schema.Array(Schema.String),
      writes: Schema.Array(Schema.String),
      mode: Effects.Mode,
      onConflict: Effects.ConflictStrategy,
      tier: Schema.optional(Effects.Tier)
    })
  ]),
  flows: Schema.optional(Schema.Array(Schema.String)),
  model: Schema.optional(ModelSelection),
  annotations: Schema.optional(Schema.declare(Context.isContext)),
  budget: Schema.optional(FlowBudget),
  deadline: Schema.optional(BudgetCeiling),
  modelInvocable: Schema.optional(Schema.Boolean),
  disableModelInvocation: Schema.optional(Schema.Boolean)
})

/**
 * Refuses misspelled fields at every record level.
 * @since 0.1.0
 * @private
 */
export const decode = Schema.decodeUnknownEffect(Declared, { onExcessProperty: "error" })

/**
 * Metadata-only key validation; values remain source text and are never evaluated.
 * @since 0.1.0
 * @private
 */
export const keys = Schema.Struct(Object.fromEntries(
  Object.keys(Declared.fields).map((key) => [key, Schema.optionalKey(Schema.Unknown)])
))
