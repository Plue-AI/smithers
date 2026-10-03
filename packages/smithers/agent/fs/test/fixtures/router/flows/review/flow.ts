import { Schema } from "effect"

throw new Error("must not execute")

export default ({
  capabilities: [],
  effects: undefined,
  output: Schema.Unknown,
  name: "ignored-review-name",
  description: "Review a pull request.",
  input: Schema.Struct({ number: Schema.Number })
} as const)
