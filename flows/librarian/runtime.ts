import * as Agent from "@smthrs/agent/Agent"
import * as AgentAction from "@smthrs/agent/AgentAction"
import * as Budget from "@smthrs/agent/Budget"
import { Action, FlowRuntime } from "@smthrs/flow"
import { ModelError, ModelErrorCode } from "@smthrs/model/ModelError"
import * as Registry from "@smthrs/registry/Registry"
import { Context, Effect, Layer, Option, Schema, type Scope, Stream } from "effect"
import { HarnessError } from "../../packages/smithers/agent/harness/src/HarnessError.ts"
import { ModuleOwner } from "../../packages/smithers/src/internal/ModuleOwner.ts"

export { SeatUnresolved } from "@smthrs/agent/Seat"
export { BudgetExceeded, AccountingUnavailable } from "@smthrs/agent/Budget"
// The provider conditions this file can actually surface: a seat that could
// not reach the provider at all. `surfaceFailure` below is the only thing that
// builds a ProviderUnavailable, and it builds one only from these seven, so
// declaring the model's whole vocabulary here claimed twelve. The five it
// dropped — content_policy, context_overflow, invalid_provider_output,
// invalid_request, unknown — describe an exchange that DID reach the provider,
// which the librarian never re-raises under its own tag. A code names its
// author only while one vocabulary spells it (apps/app RunCause.ts), so five
// unreachable members cost a person five sentences about their own request.
export const ProviderCode = ModelErrorCode.pick([
  "no_route",
  "authentication",
  "transport",
  "provider_internal",
  "call_timeout",
  "rate_limited",
  "quota_exceeded"
])
export class ProviderUnavailable extends Schema.TaggedError<ProviderUnavailable>()("librarian/ProviderUnavailable", {
  code: ProviderCode, message: Schema.String
}) {}
// Lanes 2/3 include this schema in every enclosing action/flow error union.
export const LibrarianFailure = Schema.Union([AgentAction.AgentFailure, Budget.AccountingUnavailable, ProviderUnavailable])
export type LibrarianFailure = typeof LibrarianFailure.Type
export const failureTags = {
  seat: "@smthrs/agent/Seat/SeatUnresolved", budget: "flows/agent/BudgetExceeded", provider: "librarian/ProviderUnavailable"
} as const
const ProviderCause = Schema.Struct({ librarianProvider: Schema.Tuple([ProviderCode, Schema.String]) })
const isProviderCode = Schema.is(ProviderCode)
export const surfaceFailure = (failure: unknown): unknown => {
  const cause = typeof failure === "object" && failure !== null && "cause" in failure ? failure.cause : failure
  if (Schema.is(ProviderCause)(cause)) return new ProviderUnavailable({ code: cause.librarianProvider[0], message: cause.librarianProvider[1] })
  if (Schema.is(ModelError)(cause) && isProviderCode(cause.code)) return new ProviderUnavailable({ code: cause.code, message: cause.message })
  return failure
}
const preserveProvider = <E>(failure: E): E | HarnessError => {
  if (!(failure instanceof HarnessError)) return failure
  const surfaced = surfaceFailure(failure)
  // HarnessError.cause uses Schema.Defect, which reduces Error objects to their
  // message on decode. A tuple keeps the provider code through that codec.
  return surfaced instanceof ProviderUnavailable ? new HarnessError({ code: failure.code, message: surfaced.message,
    cause: { librarianProvider: [surfaced.code, surfaced.message] } }) : failure
}

// Four million tokens allows typical evidence slices, not maximal ones;
// two hours bounds admission across parks/restarts, not an in-flight call.
export const budgetPolicy: Budget.Policy = {
  tokens: { max: 4_000_000, onExceeded: "fail" },
  latency: { maxMillis: 2 * 60 * 60 * 1000, onExceeded: "fail" }
}
// Evidence is supplied by deterministic readers. Cells only format answers, so
// no tools are exposed; eight frames leave room to construct structured output.
// Outages fail promptly; another attempt belongs to the explicit Retry door.
export const hostLimits = {
  limits: { memoryBytes: 128 * 1024 * 1024, steps: 25_000_000, calls: 8 },
  maxFrames: 8, defaultCorrections: 1, maxQuotaParks: 0
} as const
const registry = Registry.makeNoop({ list: () => Effect.succeed([]), visible: () => Effect.succeed([]), getOption: () => Effect.succeedNone })
class Installed extends Context.Service<Installed, Budget.Service>()("librarian/InstalledBudget") {}

/** Apply inside native handler authority restoration, including child resume. */
export const bounded = <A, E, R>(effect: Effect.Effect<A, E, R>, budget: Budget.Service): Effect.Effect<A, E, Exclude<R, Budget.Budget>> => Effect.gen(function*() {
  const host = yield* Effect.serviceOption(AgentAction.Host)
  const agent = yield* Effect.serviceOption(Agent.Agent)
  const current = yield* Effect.serviceOption(Budget.Budget)
  const installed = yield* Effect.serviceOption(Installed)
  const instance = yield* Effect.serviceOption(FlowRuntime.FlowInstance)
  const owner = yield* Effect.serviceOption(ModuleOwner)
  const root: string | undefined = Option.isSome(owner) ? owner.value.rootId : Option.isSome(instance) ? instance.value.executionId : undefined
  const key = (step: string): string => JSON.stringify([Option.isSome(instance) ? instance.value.executionId : root, step])
  const account = <B, F, S>(work: Effect.Effect<B, F, S>): Effect.Effect<B, F, S> => Option.isSome(instance) && root !== undefined
    ? work.pipe(Effect.provideService(FlowRuntime.FlowInstance, { ...instance.value, executionId: root })) : work
  const local: Budget.Service = {
    check: step => account(budget.check(step === undefined ? undefined : key(step))),
    reserve: step => account(budget.reserve(key(step))),
    record: (step, usage) => account(budget.record(key(step), usage)),
    usage: account(budget.usage), usageOf: id => account(budget.usageOf(id))
  }
  // Keep the approved native budget too. A host ceiling cannot widen a tighter
  // allowance on the admitted plan. Nested inline actions reuse this service.
  const previous = Option.isSome(current) ? current.value : undefined
  const combine = (first: Effect.Effect<Budget.Verdict, Budget.AccountingUnavailable, Scope.Scope>,
    second: Effect.Effect<Budget.Verdict, Budget.AccountingUnavailable, Scope.Scope>) =>
    first.pipe(Effect.flatMap(verdict => verdict._tag === "refuse" ? Effect.succeed(verdict) : second))
  const shared: Budget.Service = Option.isSome(installed) && installed.value === previous ? previous : previous === undefined ? local : {
    check: step => local.check(step).pipe(Effect.flatMap(verdict => verdict._tag === "refuse" ? Effect.succeed(verdict) : previous.check(step))),
    reserve: step => combine(local.reserve(step), previous.reserve(step)),
    record: (step, usage) => local.record(step, usage).pipe(Effect.andThen(previous.record(step, usage))),
    usage: local.usage, usageOf: local.usageOf
  }
  let work: Effect.Effect<A, E, R> = effect
  if (Option.isSome(host)) work = work.pipe(Effect.provideService(AgentAction.Host, {
    ...host.value, ...hostLimits, registry, flows: [], implementations: undefined, promptRunner: undefined, capabilityEnvelope: []
  }))
  if (Option.isSome(agent)) work = work.pipe(Effect.provideService(Agent.Agent, {
    ...agent.value, run: options => agent.value.run({ ...options, unmovedCap: 0 }).pipe(Stream.mapError(preserveProvider))
  }))
  return yield* work.pipe(Effect.provideService(Budget.Budget, shared), Effect.provideService(Installed, shared))
})

export const agentRuntime = <A, E, R>(modules: Layer.Layer<A, E, R>, policy: Budget.Policy = budgetPolicy) => {
  const boundaries = Layer.unwrap(Effect.gen(function*() {
    const budget = yield* Budget.Budget
    return Layer.mergeAll(
      Layer.effect(FlowRuntime.FlowRuntime)(Effect.map(FlowRuntime.FlowRuntime, runtime => ({
        ...runtime, register: (flow, handler) => runtime.register(flow, (payload, executionId) =>
          bounded(handler(payload, executionId), budget).pipe(Effect.mapError(error => {
            const surfaced = surfaceFailure(error)
            // AgentAction's own schema remains authoritative; the enclosing
            // flow opts into ProviderUnavailable through LibrarianFailure.
            return Schema.is(flow.errorSchema)(surfaced) ? surfaced : error
          })))
      }))),
      Layer.effect(Action.Implementations)(Effect.map(Action.Implementations, table => ({
        ...table, add: (implementation, options) => table.add({ ...implementation,
          action: payload => bounded(implementation.action(payload), budget) }, options)
      })))
    )
  })).pipe(Layer.provide(Budget.layer(policy)), Layer.orDie)
  return modules.pipe(Layer.provide(boundaries))
}
