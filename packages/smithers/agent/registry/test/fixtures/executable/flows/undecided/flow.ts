"use server"

import type * as FlowBinding from "@smthrs/harness/FlowBinding"
import { Schema } from "effect"

export default ({
  name: "undecided",
  description: "Names two flows and no model, so nothing decides between them.",
  input: Schema.Struct({ name: Schema.String }),
  output: Schema.String,
  capabilities: ["*"],
  flows: ["test/echo", "test/other"],
  effects: {
    reads: [],
    writes: [],
    mode: "hermetic",
    onConflict: "serialize",
    tier: "sealed"
  }
} satisfies FlowBinding.Declared)
