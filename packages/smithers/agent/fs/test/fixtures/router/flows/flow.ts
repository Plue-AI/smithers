import * as Schema from "effect/Schema"

export default ({
  capabilities: [],
  effects: undefined,
  input: Schema.Void,
  output: Schema.Unknown,
  name: "root",
  description: "Root flows cannot be routed."
} as const)
