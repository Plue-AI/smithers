import { Schema } from "effect"

export default ({
  capabilities: [],
  effects: undefined,
  name: "special",
  description: "Special path fixture.",
  input: Schema.Struct({ value: Schema.String }),
  output: Schema.String
} as const)
