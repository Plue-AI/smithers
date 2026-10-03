"use server"

import type * as FlowBinding from "@smthrs/harness/FlowBinding"
import { Schema } from "effect"

export default ({
  name: "greet",
  description: "Greets whoever the caller names.",
  input: Schema.Struct({ name: Schema.String }),
  output: Schema.Struct({ greeting: Schema.String }),
  capabilities: ["*"],
  flows: ["test/echo"],
  effects: {
    reads: [],
    writes: [],
    mode: "hermetic",
    onConflict: "serialize",
    tier: "sealed"
  }
} satisfies FlowBinding.Declared)
