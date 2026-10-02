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
import { EventTypes } from "@smthrs/engine-store/EventTypes"
import * as RunState from "@smthrs/engine-store/RunState"
import { FlowRuntime } from "@smthrs/flow"
import { HarnessError } from "@smthrs/harness/HarnessError"
import * as Notifications from "@smthrs/harness/Notifications"
import * as Steering from "@smthrs/harness/Steering"
import { Journal, JournalEvent } from "@smthrs/journal"
import * as CapabilitySet from "@smthrs/kernel/CapabilitySet"
import { NotificationQueue } from "@smthrs/notifications"
import * as Descriptor from "@smthrs/registry/Descriptor"
import type * as Executable from "@smthrs/registry/Executable"
import * as Registry from "@smthrs/registry/Registry"
import { RunStore } from "@smthrs/run-store"
import { Cause, Effect, Exit, Option, RcMap, Schema } from "effect"
import { ModuleOwner } from "./ModuleOwner.ts"

/**
 * Composes existing host authority services without another run ledger.
 * @since 1.0.0
 * @private
 */
export const make = (
  catalog: Effect.Effect<Executable.Catalog>,
  actionHost: AgentAction.Host,
  budgetHost: {
    /** The owning control run's journal, where budget requests and decisions live. */
    readonly controlJournal: Journal.Service
    /** Whether a refused `park` budget may ask an operator, as the session's `asks` says. */
    readonly parks: boolean
    readonly weights?: Budget.Weights | undefined
  }
) =>
  Effect.gen(function*() {
    const authorityContext = yield* Effect.context<never>()
    const engine = yield* FlowRuntime.FlowRuntime
    const state = yield* DurableEngineState.DurableEngineState
    const runs = yield* RunStore.RunStore
    const control = yield* ControlRuntime
    const journal = yield* Journal.Journal
    const quota = yield* QuotaPolicy.QuotaClassifier
    const registry = yield* Registry.Registry
    // Executable already imported a verified, private copy of a module's
    // measured closure. Keep that exact loaded identity for this host/root,
    // rather than making later children depend on edits to the live tree.
    // No approval, refreshed executable, or restarted host inherits it.
    const verifiedModules = new Map<string, { readonly digest: string; readonly executable: Executable.Executable }>()
    // Native execution has its own journal, but the queue is the existing
    // owning control queue, captured before any handler context is installed.
    const notifications = yield* NotificationQueue.NotificationQueue
    const refuse = (runId: string, message: string) => Effect.die(new LaunchFailed({ runId, message }))

    /**
     * Whether the engine ever released this execution by interrupting it: a
     * lease lapse or a host shutdown stopped it mid-flight, so entering it
     * again retries whatever effect it had started.
     */
    const released = (executionId: string) =>
      Effect.gen(function*() {
        let after: Journal.EntriesOptions["after"]
        for (;;) {
          const page = yield* journal.entries({
            runId: JournalEvent.RunId.make(executionId),
            eventTypes: [EventTypes.runDecision],
            limit: 1_000,
            ...(after === undefined ? {} : { after })
          }).pipe(Effect.orDie)
          if (
            page.entries.some((entry) =>
              (entry.payload as { readonly decision?: unknown } | null)?.decision === "interrupt-released"
            )
          ) return true
          const last = page.entries.at(-1)
          if (last === undefined || !page.hasMore) return false
          after = last.seq
        }
      })

    /**
     * The approved authority an execution runs under, refusing one it may not.
     *
     * A completed control run still admits the detached descendants it
     * launched: their first drive can land after the root settled, and their
     * later rounds (a wake after a park) follow it. The outcome is the same
     * whichever finishes first (#3209). What a completed root does not admit
     * is a retry of an execution the engine released mid-flight: nothing
     * supervises that work any more, so its interrupted effect never runs a
     * second time (#3072). A cancelled or failed root admits nothing.
     * `admission` is false for a caller that already admitted a descendant and
     * only reads the root's authority again.
     */
    const owner = (executionId: string, admission = true) =>
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
        if (run.planId === undefined || run.status === "cancelled" || run.status === "failed") {
          return yield* refuse(executionId, "The owning control run is not active")
        }
        if (
          run.status === "completed" && admission &&
          (executionId === rootId || (yield* released(executionId)))
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
        const live = yield* registry.getOption(card.flowId).pipe(Effect.map(Option.getOrUndefined), Effect.orDie)
        const snapshot = approved === undefined || registry.snapshots === undefined
          ? undefined
          : yield* registry.snapshots.descriptor(approved).pipe(
            Effect.catch((error) =>
              error.code === "missing" ?
                Effect.succeed(undefined)
                : refuse(executionId, `The approved module snapshot is unavailable: ${error.code}`)
            )
          )
        const descriptor = snapshot ?? live
        const executable = (yield* catalog).executables.find((entry) =>
          entry.descriptor.name === card.flowId && Descriptor.executionDigest(entry.descriptor) === approved
        )
        if (
          approved === undefined || descriptor === undefined || Descriptor.executionDigest(descriptor) !== approved ||
          executable === undefined ||
          (executable.delegate !== undefined && !card.envelope.flows.includes(executable.delegate))
        ) {
          return yield* refuse(executionId, "The module no longer matches its approved executable identity")
        }
        const measuredModule = descriptor.body._tag === "Module" && executable.delegate === undefined
        const verified = verifiedModules.get(rootId)
        if (!measuredModule || verified?.digest !== approved || verified.executable !== executable) {
          yield* registry.loadBody(card.flowId, approved).pipe(Effect.orDie)
          // Publication precedes the first handler effect. An abrupt host death
          // can therefore never leave admitted work without its source receipt.
          if (measuredModule) {
            if (registry.snapshots !== undefined) yield* registry.snapshots.pin(executable).pipe(Effect.orDie)
            verifiedModules.set(rootId, { digest: approved, executable })
          } else verifiedModules.delete(rootId)
        }
        return { rootId, flowId: card.flowId, envelope: card.envelope }
      }).pipe(
        // Ownership and pinned source verification are host admission work.
        // A module need not grant itself filesystem reads to let the host
        // verify its source; its handler retains the execution ceiling below.
        Effect.updateContext<never, never>(() => authorityContext)
      )

    const parking = AgentSession.budgetParking(budgetHost.controlJournal, control)
    // Concurrent descendants share one existing Budget accumulator. RcMap
    // holds it until all handlers release it; later acquisition recovers the
    // existing journal's usage, including after a process restart. The
    // ceiling is the approved card's with every approved budget raise applied,
    // so a resumed module spends against what the operator granted (#2739).
    const budgets = yield* RcMap.make({
      lookup: (rootId: string) =>
        Effect.gen(function*() {
          const { envelope } = yield* owner(rootId, false)
          const spending = yield* AgentSession.approvedEnvelope(budgetHost.controlJournal, rootId, envelope)
            .pipe(Effect.orDie)
          const budget = yield* Budget.make(Budget.policyFromEnvelope(spending, { weights: budgetHost.weights }))
            .pipe(Effect.orDie)
          return { budget, envelope: spending }
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
      register: (flow, handler, options) =>
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
            const { budget, envelope: spending } = yield* RcMap.get(budgets, rootId).pipe(Effect.orDie)
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
              admitReading: (step) => account(budget.admitReading(key(step))),
              record: (step, usage, modelId) => account(budget.record(key(step), usage, modelId)),
              usage: account(budget.usage),
              usageOf: (id) => account(budget.usageOf(id)),
              suspend: account(budget.suspend),
              resume: (at) => account(budget.resume(at))
            }
            // A native wait parks no harness, so nothing else records it: an
            // execution that suspends on a HumanTask, an approval, or a timer
            // opens the root's suspension span here, and entering again closes
            // it, so the wait is not charged as task time. Entering is the
            // run executing again, and it does no work until that is recorded:
            // an open span would subtract the work as parked time.
            yield* shared.resume().pipe(Effect.orDie)
            return yield* handler(payload, executionId).pipe(
              Effect.onExit((exit) =>
                instance.suspended || (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause))
                  // Without the record the wait is charged, the conservative side.
                  ? shared.suspend.pipe(
                    Effect.catchCause((cause) => Effect.logWarning("A budget suspension could not be recorded", cause))
                  )
                  : Effect.void
              ),
              // A `park` budget parks the owning control run, as a prompt
              // run's does; a host that refuses asks fails it instead.
              (effect) =>
                budgetHost.parks
                  ? Effect.provideService(effect, Budget.Parking, parking(rootId, spending))
                  : effect,
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
          })), options)
    })
    return { runtime, steering }
  })
