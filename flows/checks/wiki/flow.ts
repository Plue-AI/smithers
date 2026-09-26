/**
 * The one discovered flow under `flows/` that still delegates, and why.
 *
 * `coding/capture-wiki-check` refuses unless the descriptor being run is bound
 * to THIS host's wiki check. Two of the four things it checks are statements
 * about the delegation itself, so collapsing this file would leave them with no
 * subject:
 *
 * - `wiki-registry.ts` stamps the host's reviewer policy onto a descriptor by
 *   selecting `descriptor.flows.includes("coding/WikiCheck")`. A module that is
 *   its own flow names no flows, so nothing would carry the stamp and the
 *   policy check could never pass.
 * - `wiki-check.ts` requires the catalog entry's `delegate` to be
 *   `coding/WikiCheck`, the flow this host registered. A self-flowed descriptor
 *   reports no delegate at all, which every collapsed flow under `flows/` also
 *   reports, so the check would stop distinguishing them.
 *
 * The third thing it reads, `invocation.flow`, is NOT the obstacle: a
 * self-delegating module reaches the same value through
 * `FlowRuntime.FlowInstance.flow._tag`, because the bridge inlines its graph
 * into the execution it tags with the descriptor's registry name.
 */
import { Flow } from "@smthrs/core"
import { Schema } from "effect"
import { Check, Implementation, Receipt } from "../../coding/schema.ts"

export default Flow.make({
  name: "checks/wiki",
  description:
    "Review the configured public wiki against the implemented immutable JJ revision and return ordinary owning-Change findings.",
  input: Schema.Struct({ implementation: Implementation, check: Check }),
  output: Receipt,
  capabilities: ["*"],
  flows: ["coding/WikiCheck"],
  effects: { reads: ["**"], writes: [], mode: "expected", onConflict: "serialize", tier: "sealed" }
})
