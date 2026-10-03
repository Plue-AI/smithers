import { Schema } from "effect"

// A refinement JSON Schema types cannot express, so the flow's own schema stays
// the last word on what decodes even after the projection accepts a value.
export default ({
  capabilities: [],
  effects: undefined,
  name: "refined",
  description: "Refinement command fixture.",
  input: Schema.Struct({ title: Schema.NonEmptyString }),
  output: Schema.Struct({ accepted: Schema.Boolean, number: Schema.Number })
} as const)
