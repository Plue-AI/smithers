"use server"

import { Annotations } from "@smthrs/core"
import * as CacheEnvironment from "@smthrs/flow/CacheEnvironment"
import { Schema } from "effect"

/**
 * A sealed, agent-delegating flow whose result may be served again.
 *
 * `scope: "shared"` is the unnarrowed reach and `ttlMs` is longer than any
 * test run, so a second run addressing the same invocation finds the row the
 * first one recorded and never starts the delegate.
 */
export default ({
  name: "cacheable",
  description: "Delegates to the agent and declares a reusable result.",
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
  annotations: Annotations.add(Annotations.empty, CacheEnvironment.CachePolicyAnnotation, {
    ttlMs: 60_000,
    scope: "shared"
  })
} as const)
