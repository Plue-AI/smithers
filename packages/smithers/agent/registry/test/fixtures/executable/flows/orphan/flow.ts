"use server"

import type * as FlowBinding from "@smthrs/harness/FlowBinding"
import { Schema } from "effect"

export default ({
  name: "orphan",
  description: "Delegates to a flow no host registers.",
  input: Schema.Struct({ name: Schema.String }),
  output: Schema.String,
  capabilities: ["*"],
  flows: ["test/missing"],
  effects: {
    reads: [],
    writes: [],
    mode: "hermetic",
    onConflict: "serialize",
    tier: "sealed"
  }
} satisfies FlowBinding.Declared)
