import { Schema } from "effect"

export default ({
  capabilities: [],
  effects: undefined,
  name: "visible",
  description: "Visible command fixture.",
  input: Schema.Struct({
    enabled: Schema.optionalKey(Schema.Boolean),
    number: Schema.Number,
    tags: Schema.optionalKey(Schema.Array(Schema.String))
  }),
  output: Schema.Struct({
    accepted: Schema.Boolean,
    number: Schema.Number
  })
} as const)
