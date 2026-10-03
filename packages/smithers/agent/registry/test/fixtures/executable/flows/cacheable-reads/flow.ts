"use server"

import { Annotations } from "@smthrs/core"
import * as CacheEnvironment from "@smthrs/flow/CacheEnvironment"
import type * as FlowBinding from "@smthrs/harness/FlowBinding"
import { Schema } from "effect"

/**
 * A policy-declaring flow whose effect declaration keeps it out of the
 * cross-run cache anyway: it names file inputs as patterns and calls its
 * boundary `expected` rather than `hermetic`.
 *
 * A declared read carries no digest at discovery time, so the bridge lowers
 * the whole read set as one glob, and the engine refuses to reuse a result
 * whose key cannot say which expansion it names. `expected` says the two sets
 * are a best effort, which is not the hard boundary a shared result needs.
 */
export default ({
  name: "cacheable-reads",
  description: "Declares file inputs and a soft boundary beside a cache policy.",
  input: Schema.Struct({ name: Schema.String }),
  output: Schema.Struct({ greeting: Schema.String }),
  flows: [],
  capabilities: [],
  effects: {
    reads: ["notes/*.md"],
    writes: [],
    mode: "expected",
    onConflict: "serialize",
    tier: "sealed"
  },
  annotations: Annotations.add(Annotations.empty, CacheEnvironment.CachePolicyAnnotation, {
    ttlMs: 60_000,
    scope: "shared"
  })
} satisfies FlowBinding.Declared)
