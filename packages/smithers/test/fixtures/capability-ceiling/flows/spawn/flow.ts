import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Outcomes, Payload, probe } from "../../probe.ts"

const { Probe, layer: probeLayer } = probe("spawn")

export const layer = probeLayer

export default Flow.make("spawn", {
  description: "Reach for every host service under the declared ceiling.",
  capabilities: ["proc:spawn:sh *"],
  effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  payload: Payload,
  success: Outcomes,
  body: Node.capture({ action: Probe.name }, (input) => Probe.call(input))
})
