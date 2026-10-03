"use sandbox"

import { Annotations } from "@smthrs/core"
import * as CacheEnvironment from "@smthrs/flow/CacheEnvironment"
import type * as FlowBinding from "@smthrs/harness/FlowBinding"
import { Schema } from "effect"

export default ({
  name: "tuned",
  description: "Carries a cache policy, a priority, and a placement directive.",
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
  },
  annotations: Annotations.add(
    Annotations.add(Annotations.empty, Annotations.Priority, 7),
    CacheEnvironment.CachePolicyAnnotation,
    { ttlMs: 60_000, scope: "shared" }
  )
} satisfies FlowBinding.Declared)
