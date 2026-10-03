"use server"

import { Annotations } from "@smthrs/core"
import * as CacheEnvironment from "@smthrs/flow/CacheEnvironment"
import type * as FlowBinding from "@smthrs/harness/FlowBinding"
import { Schema } from "effect"

/**
 * Declares the one cache policy whose effect at dispatch is observable without
 * a clock: `scope: "run"` narrows the address of the cache row a sealed step
 * writes, so a second run must miss and re-execute. Every other policy a
 * descriptor can carry either narrows nothing (`scope: "shared"`) or bounds an
 * age no test run reaches (`ttlMs`), which is why the fixture that carries them
 * cannot tell a policy that reached the runtime from one that did not.
 */
export default ({
  name: "scoped",
  description: "Declares a run-scoped cache policy.",
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
  annotations: Annotations.add(Annotations.empty, CacheEnvironment.CachePolicyAnnotation, { scope: "run" })
} satisfies FlowBinding.Declared)
