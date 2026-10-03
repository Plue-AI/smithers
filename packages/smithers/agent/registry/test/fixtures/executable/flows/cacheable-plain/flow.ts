"use server"

import { Schema } from "effect"

/**
 * The control for the cache golden: a sealed, agent-delegating flow that
 * declares NO cache policy.
 *
 * Everything the engine needs to reuse a result is already true here — the
 * projected authority is sealed, the effect declaration is hermetic, and the
 * read set is empty — so the only thing separating it from its three siblings
 * is the policy each of them declares. That is what makes those cases about
 * the policy and nothing else.
 */
export default ({
  name: "cacheable-plain",
  description: "Delegates to the agent and declares no cache policy.",
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
  }
} as const)
