import { Schema } from "effect"

// Importing this module is observable, so a test can prove which surface loaded
// it and which one did not.
const globals = globalThis as { fsRecordedImports?: number }
globals.fsRecordedImports = (globals.fsRecordedImports ?? 0) + 1

export default ({
  capabilities: [],
  effects: undefined,
  name: "recorded",
  description: "Import-recording command fixture.",
  input: Schema.Struct({ number: Schema.Number }),
  output: Schema.Struct({ accepted: Schema.Boolean, number: Schema.Number })
} as const)
