"use server"

import { Schema } from "effect"

export default ({
  name: "orphan",
  description: "Delegates to a flow no host registers.",
  input: Schema.Struct({ name: Schema.String }),
  output: Schema.String,
  flows: ["test/missing"],
  effects: {
    reads: [],
    writes: [],
    mode: "hermetic",
    onConflict: "serialize",
    tier: "sealed"
  }
} as const)
