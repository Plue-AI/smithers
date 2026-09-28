/**
 * Restores approved control authority at native handler boundaries, including resume.
 * @since 1.0.0
 */

import * as AgentAction from "@smthrs/agent/AgentAction"
import * as AgentSession from "@smthrs/agent/AgentSession"
import * as Budget from "@smthrs/agent/Budget"
import * as EventSink from "@smthrs/agent/EventSink"
import * as QuotaPolicy from "@smthrs/agent/QuotaPolicy"
import { LaunchFailed } from "@smthrs/control/ControlError"
import { ControlRuntime } from "@smthrs/control/ControlRuntime"
import * as DurableEngineState from "@smthrs/engine-store/DurableEngineState"
import * as RunState from "@smthrs/engine-store/RunState"
import { FlowRuntime } from "@smthrs/flow"
import { HarnessError } from "@smthrs/harness/HarnessError"
import * as Notifications from "@smthrs/harness/Notifications"
import * as Steering from "@smthrs/harness/Steering"
import { Journal } from "@smthrs/journal"
import * as CapabilitySet from "@smthrs/kernel/CapabilitySet"
import { NotificationQueue } from "@smthrs/notifications"
import * as Descriptor from "@smthrs/registry/Descriptor"
import type * as Executable from "@smthrs/registry/Executable"
import * as Registry from "@smthrs/registry/Registry"
import { RunStore } from "@smthrs/run-store"
import { Effect, Option, RcMap, Schema } from "effect"
import { ModuleOwner } from "./ModuleOwner.ts"

/**
 * Composes existing host authority services without another run ledger.
 * @since 1.0.0
 * @private
 */
export const make = (
  catalog: Effect.Effect<Executable.Catalog>,
  actionHost: AgentAction.Host,
  weights?: Budget.Weights
) =>
  Effect.gen(function*() {
    const engine = yield* FlowRuntime.FlowRuntime
    const state = yield* DurableEngineState.DurableEngineState
    const runs = yield* RunStore.RunStore
    const control = yield* ControlRuntime
    const journal = yield* Journal.Journal
    const quota = yield* QuotaPolicy.QuotaClassifier
    const registry = yield* Registry.Registry
    // Native execution has its own journal, but the queue is the existing
    // owning control queue, captured before any handler context is installed.
    const notifications = yield* NotificationQueue.NotificationQueue
    const refuse = (runId: string, message: string) => Effect.die(new LaunchFailed({ runId, message }))

    const owner = (executionId: string) =>
      Effect.gen(function*() {
        const pending = [executionId]
        const visited = new Set<string>()
        const roots = new Set<string>()
        while (pending.length > 0) {
          const id = pending.pop()!
          if (visited.has(id)) continue
          if (visited.size >= 1_024) {
            return yield* refuse(executionId, "Module ancestry exceeds the host traversal limit")
          }
          visited.add(id)
          const run = yield* control.getRun(id).pipe(
            Effect.map(Option.some),
            Effect.catchTag("/control/RunNotFound", () => Effect.succeedNone),
            Effect.orDie
          )
          if (Option.isSome(run)) {
            const row = yield* runs.get(id).pipe(Effect.orDie)
            const native = yield* Effect.try(() =>
              Schema.decodeUnknownSync(RunState.RunState)(JSON.parse(row.stateJson))
            )
              .pipe(Effect.catch(() => refuse(executionId, "The control ancestor has invalid native state")))
            // Time-travel forks copy the old payload's runId. AgentSession
            // takes identity from this native row, not from that copied field.
            const payload = native.payload as { readonly planId?: unknown } | null
            if (
              native.flowName !== "agent/run" || payload?.planId !== run.value.planId ||
              native.parentExecutionId !== undefined || (yield* state.runParents(id)).length !== 0
            ) {
              return yield* refuse(executionId, "The native ancestor is not its owning control wrapper")
            }
            roots.add(id)
            continue
          }
          const parents = yield* state.runParents(id)
          if (parents.length > 0) {
            for (const parent of parents) pending.push(parent.parentId)
          } else {
            // A trampoline predecessor is distinct from an ordinary spawn edge.
            const row = yield* runs.get(id).pipe(Effect.orDie)
            if (row.parentRunId !== null) pending.push(row.parentRunId)
            else return yield* refuse(executionId, "Module execution has no recorded control ancestor")
          }
        }
        if (roots.size !== 1) return yield* refuse(executionId, "Module execution has ambiguous control authority")
        const rootId = [...roots][0]!
        const run = yield* control.getRun(rootId).pipe(Effect.orDie)
        if (
          run.planId === undefined || run.status === "cancelled" || run.status === "failed" ||
          run.status === "completed"
        ) {
          return yield* refuse(executionId, "The owning control run is not active")
        }
        const plan = yield* control.getPlan(run.planId).pipe(Effect.orDie)
        if (plan.decision !== "approved" || run.planDigest !== plan.card.digest) {
          return yield* refuse(executionId, "The owning control plan is not the approved plan")
        }
        const card = plan.card
        // The code an operator adopted with `runs resume --allow-code-drift`
        // is recorded on the run and binds it from then on; otherwise the
        // plan's digest does (#1807).
        const approved = run.executionDigest ?? card.executionDigest
        const descriptor = yield* registry.get(card.flowId).pipe(Effect.orDie)
        const executable = (yield* catalog).executables.find((entry) => entry.descriptor.name === card.flowId)
        if (
          approved === undefined || Descriptor.executionDigest(descriptor) !== approved ||
          executable === undefined || Descriptor.executionDigest(executable.descriptor) !== approved ||
          // A module that IS its own flow names no delegate. The
          // `executionDigest` checked above covers its entry bytes and every
          // module that entry imports from beside itself; a host-registered
          // delegate's code is covered by nothing, which is why the envelope
          // has to name that one.
          (executable.delegate !== undefined && !card.envelope.flows.includes(executable.delegate))
        ) {
          return yield* refuse(executionId, "The module no longer matches its approved executable identity")
        }
        // Re-read the pinned body as well: a parked child can run before its
        // agent/run parent is entered again after a process restart.
        yield* registry.loadBody(card.flowId, approved).pipe(Effect.orDie)
        return { rootId, flowId: card.flowId, envelope: card.envelope }
      })

    // Concurrent descendants share one existing Budget accumulator. RcMap
    // holds it until all handlers release it; later acquisition recovers the
    // existing journal's usage, including after a process restart.
    const budgets = yield* RcMap.make({
      lookup: (rootId: string) =>
        Effect.gen(function*() {
          const { envelope } = yield* owner(rootId)
          return yield* Budget.make(Budget.policyFromEnvelope(envelope, { weights })).pipe(Effect.orDie)
        })
    })

    // Construction closes the service dependency but grants no root identity.
    // Every admitted handler installs the real queue source below, once.
    const unowned = Effect.fail(
      new HarnessError({
        code: "assembly_failed",
        message: "Native steering requires an approved execution context"
      })
    )
    const steering = Steering.make({
      read: () => unowned,
      drain: () => unowned
    })
    const runtime = FlowRuntime.FlowRuntime.of({
      ...engine,
      register: (flow, handler) =>
        engine.register(flow, (payload, executionId) =>
          Effect.scoped(Effect.gen(function*() {
            const { rootId, flowId, envelope } = yield* owner(executionId)
            const notificationsForRoot = yield* Notifications.make({ runId: rootId, lineageId: rootId }).pipe(
              Effect.provideService(NotificationQueue.NotificationQueue, notifications)
            )
            const handlerSteering = Steering.make({
              read: notificationsForRoot.read,
              drain: (input) =>
                notificationsForRoot.drain({
                  ...input,
                  boundary: JSON.stringify([executionId, input.boundary])
                })
            })
            const budget = yield* RcMap.get(budgets, rootId).pipe(Effect.orDie)
            const instance = yield* FlowRuntime.FlowInstance
            const trace = yield* EventSink.durable(journal)
            const accountingInstance = { ...instance, executionId: rootId }
            const key = (step: string) => JSON.stringify([executionId, step])
            const account = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
              effect.pipe(
                Effect.provideService(FlowRuntime.FlowInstance, accountingInstance),
                Effect.provideService(Journal.Journal, journal)
              )
            const shared: Budget.Service = {
              check: (step) => account(budget.check(step === undefined ? undefined : key(step))),
              reserve: (step) => account(budget.reserve(key(step))),
              record: (step, usage, modelId) => account(budget.record(key(step), usage, modelId)),
              usage: account(budget.usage),
              usageOf: (id) => account(budget.usageOf(id))
            }
            return yield* handler(payload, executionId).pipe(
              CapabilitySet.attenuate(AgentSession.patterns(envelope.capabilities)),
              Effect.provideService(AgentAction.Host, {
                ...actionHost,
                capabilityEnvelope: AgentSession.patterns(envelope.capabilities)
              }),
              Effect.provideService(Budget.Budget, shared),
              Effect.provideService(ModuleOwner, { rootId, flowId }),
              Effect.provideService(NotificationQueue.NotificationQueue, notifications),
              Effect.provideService(Steering.Source, handlerSteering),
              Effect.provideService(QuotaPolicy.QuotaClassifier, quota),
              Effect.provideService(EventSink.EventSink, trace)
            )
          })))
    })
    return { runtime, steering }
  })
