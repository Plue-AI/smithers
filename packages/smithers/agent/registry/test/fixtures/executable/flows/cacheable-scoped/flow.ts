"use server"

import { Annotations } from "@smthrs/core"
import * as CacheEnvironment from "@smthrs/flow/CacheEnvironment"
import type * as FlowBinding from "@smthrs/harness/FlowBinding"
import { Schema } from "effect"

/**
 * The `cacheable` fixture with one field changed: `scope: "run"`.
 *
 * A run-scoped policy folds the executing run into the address of the row it
 * records, so a sibling run derives a different address, finds nothing, and
 * runs the delegate again.
 */
export default ({
  name: "cacheable-scoped",
  description: "Delegates to the agent and keeps its result inside one run.",
  input: Schema.Struct({ name: Schema.String }),
  output: Schema.Struct({ greeting: Schema.String }),
  flows: [],
  capabilities: [],
  effects: {
    reads: [],
    writes: [],
    mode: "hermetic",
    onConflict: "serialize",
    tier: "sealed"
  },
  annotations: Annotations.add(Annotations.empty, CacheEnvironment.CachePolicyAnnotation, { scope: "run" })
} satisfies FlowBinding.Declared)
