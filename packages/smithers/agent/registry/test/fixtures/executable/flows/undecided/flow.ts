"use server"

import { Schema } from "effect"

export default ({
  name: "undecided",
  description: "Names two flows and no model, so nothing decides between them.",
  input: Schema.Struct({ name: Schema.String }),
  output: Schema.String,
  flows: ["test/echo", "test/other"],
  effects: {
    reads: [],
    writes: [],
    mode: "hermetic",
    onConflict: "serialize",
    tier: "sealed"
  }
} as const)
