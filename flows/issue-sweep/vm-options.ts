/** Local pool configuration is carried unchanged through each durable child. */
import { Schema } from "effect"
const positive = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
export const vmFields = {
  agentsPerVm: Schema.optional(positive),
  maxVms: Schema.optional(positive),
  memoryBaseMib: Schema.optional(positive),
  memoryPerAgentMib: Schema.optional(positive),
  cpusPerAgent: Schema.optional(positive),
  maxCpus: Schema.optional(positive)
}
export const vmOptions = (input: {
  readonly agentsPerVm?: number | undefined
  readonly maxVms?: number | undefined
  readonly memoryBaseMib?: number | undefined
  readonly memoryPerAgentMib?: number | undefined
  readonly cpusPerAgent?: number | undefined
  readonly maxCpus?: number | undefined
}) => ({
  agentsPerVm: input.agentsPerVm,
  maxVms: input.maxVms,
  memoryBaseMib: input.memoryBaseMib,
  memoryPerAgentMib: input.memoryPerAgentMib,
  cpusPerAgent: input.cpusPerAgent,
  maxCpus: input.maxCpus
})
