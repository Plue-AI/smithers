/**
 * A volatile, in-memory implementation of the flow runtime port.
 *
 * @since 0.1.0
 */

import * as CapabilitySet from "@smthrs/capability/CapabilitySet"
import { Flow, FlowRuntime } from "@smthrs/flow"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as FiberMap from "effect/FiberMap"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import { bindHostCeiling, joinable, requestedAuthority } from "./Authority.ts"
import { makeInstance } from "./FlowInstance.ts"
import { makeUnsafe } from "./make.ts"
import type * as Round from "./Round.ts"
import { FlowNotRegistered } from "./Trampoline.ts"

/**
 * A caller reused an execution id for different persisted run identity.
 *
 * @category errors
 * @since 1.0.0
 */
export class ExecutionIdentityConflict extends Schema.TaggedError<ExecutionIdentityConflict>()(
  "@smthrs/engine/ExecutionIdentityConflict",
  {
    code: Schema.Literal("execution_identity_conflict").pipe(
      Schema.withConstructorDefault(Effect.succeed("execution_identity_conflict"))
    ),
    executionId: Schema.String,
    field: Schema.Literals(["flow", "payload", "capabilities", "lineage", "round", "parent"]),
    expected: Schema.String,
    actual: Schema.String,
    message: Schema.String
  }
) {}

/**
 * The refusal of a join whose caller's capability ceiling does not cover the
 * one the execution was admitted with. Both drivers raise the same value.
 *
 * @category errors
 * @since 1.0.0
 */
export const capabilityConflict = (executionId: string): ExecutionIdentityConflict =>
  new ExecutionIdentityConflict({
    executionId,
    field: "capabilities",
    expected: "a capability ceiling covering the one the execution was admitted with",
    actual: "a capability ceiling that does not cover it",
    message: `execution ${executionId} was admitted under authority this caller's capability ceiling ` +
      "does not cover; it cannot be joined under this one"
  })

/**
 * Layer that provides an in-memory `FlowRuntime`.
 *
 * **When to use**
 *
 * Use to run tests and local development flows where durability is not
 * needed.
 *
 * **Gotchas**
 *
 * This layer keeps state only in memory and is not suitable for production
 * flows that require durability.
 *
 * The capability ceiling current where the layer is built is the engine's
 * host ceiling: every execution it admits records it, and every join, poll,
 * and resume is compared under it.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerMemory: Layer.Layer<FlowRuntime.FlowRuntime> = Layer.effect(FlowRuntime.FlowRuntime)(
  Effect.gen(function*() {
    const scope = yield* Effect.scope
    // The ceiling this engine is built under bounds every admission, join,
    // poll, and resume it answers, whatever context later calls it.
    const host = yield* CapabilitySet.current

    type Registration = {
      readonly flow: Flow.Any
      readonly execute: (
        payload: object,
        executionId: string
      ) => Effect.Effect<unknown, unknown, FlowRuntime.FlowInstance | FlowRuntime.FlowRuntime>
      readonly scope: Scope.Scope
    }
    // Registrations of one tag stack: the last still-open one serves, and a
    // closed inner registration is spliced back out so the outer one serves
    // again — the same restore `make.register`'s declaration table performs.
    const flows = new Map<string, Array<Registration>>()

    type ExecutionState = {
      readonly capabilityCeilings: CapabilitySet.CapabilitySet["groups"]
      readonly payload: unknown
      readonly parent: string | undefined
      readonly rootExecutionId: Round.RootExecutionId
      instance: FlowRuntime.FlowInstance["Service"]
      fiber: Fiber.Fiber<Flow.Result<unknown, unknown>> | undefined
      /**
       * The fiber the flow body actually runs in: `Flow.intoResult` forks the
       * body as a child of the round fiber, and a normal `interrupt` targets
       * this child so the round fiber survives to CONVERT the interruption
       * into the recorded cancellation instead of dying on it.
       */
      bodyFiber: Fiber.Fiber<unknown, unknown> | undefined
    }
    const executions = new Map<string, ExecutionState>()
    /**
     * Refuses a poll or resume of an execution of `flow` whose caller's
     * authority does not cover the authority `state` was admitted with.
     */
    const authorize = (flow: Flow.Any, state: ExecutionState, executionId: string): Effect.Effect<void> =>
      Effect.flatMap(requestedAuthority(flow), (requested) =>
        joinable(state.capabilityCeilings, requested)
          ? Effect.void
          : Effect.die(capabilityConflict(executionId)))
    // Payload constructors and identity codecs may suspend. Serialize only
    // admission and drive installation for one id, never the body or another id.
    const executionLocks = new Map<string, { readonly semaphore: Semaphore.Semaphore; users: number }>()
    const withExecutionLock = <A, E, R>(executionId: string, effect: Effect.Effect<A, E, R>) =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          let lock = executionLocks.get(executionId)
          if (lock === undefined) {
            lock = { semaphore: Semaphore.makeUnsafe(1), users: 0 }
            executionLocks.set(executionId, lock)
          }
          lock.users++
          return lock
        }),
        (lock) => lock.semaphore.withPermit(effect),
        (lock) =>
          Effect.sync(() => {
            // Count waiters as well as holders: cancelling one waiter must not
            // replace the semaphore underneath another. Rejected ids retain none.
            if (--lock.users === 0) executionLocks.delete(executionId)
          })
      )
    // A round fiber that settled `Suspended` is the only state a re-drive or
    // a conditional completion continues from. A live round is still
    // running, and every other settlement — an answer, a hand-off to the
    // next round, or a Failure exit from a defect that escaped capture — is
    // terminal, so acting on it would re-run the body's effects.
    const settledSuspended = (state: ExecutionState): boolean => {
      const exit = state.fiber?.pollUnsafe()
      return exit !== undefined && Exit.isSuccess(exit) && exit.value._tag === "Suspended"
    }

    // In-process wake for a caller parked on the suspension backoff sleep.
    // Edge-triggered and miss-tolerant like engine-store's WakeBus: a wake
    // completes the deferred the current subscribers await and drops it, so
    // the next subscription starts a fresh one and polling stays the
    // fallback for a wake that landed before the subscription.
    const wakes = new Map<string, Deferred.Deferred<void>>()
    const wake = (executionId: string): void => {
      const pending = wakes.get(executionId)
      if (pending === undefined) return
      wakes.delete(executionId)
      Deferred.doneUnsafe(pending, Exit.void)
    }
    // Trampoline membership, keyed by root execution id rather than the
    // journal lineage on an instance. A cancellation survives the gap before
    // the next round exists.
    const rounds = new Map<Round.RootExecutionId, Set<string>>()
    const cancelledLineages = new Set<Round.RootExecutionId>()

    // Every child execution request records an edge, including a fan-in that
    // joins an existing execution. This mirrors the durable engine's edge
    // table: keeping only ExecutionState.parent would miss second-parent
    // cycles and let the participants join one another forever.
    const parents = new Map<string, Set<string>>()
    const children = new Map<string, Set<string>>()
    const recordParent = (
      child: string,
      parent: string
    ): Effect.Effect<void, FlowRuntime.FlowCycleDetected> =>
      Effect.suspend(() => {
        const pending: Array<readonly [string, ReadonlyArray<string>]> = [[parent, [parent]]]
        const visited = new Set<string>()
        while (pending.length > 0) {
          const [current, path] = pending.shift()!
          if (current === child) {
            return Effect.fail(
              new FlowRuntime.FlowCycleDetected({
                code: "flow_cycle_detected",
                path: [...path].reverse()
              })
            )
          }
          if (visited.has(current)) continue
          visited.add(current)
          for (const ancestor of parents.get(current) ?? []) {
            pending.push([ancestor, [...path, ancestor]])
          }
        }
        const existing = parents.get(child)
        if (existing === undefined) {
          parents.set(child, new Set([parent]))
        } else {
          existing.add(parent)
        }
        const linked = children.get(parent) ?? new Set<string>()
        linked.add(child)
        children.set(parent, linked)
        return Effect.void
      })

    // Publish all intent synchronously before sending an interrupt or re-drive.
    // A body that admits another child during cleanup inherits this intent.
    const requestCancellation = (executionId: string): ReadonlyArray<string> => {
      if (!executions.has(executionId)) return []
      const pending = [executionId]
      const seen = new Set(pending)
      const visitedLineages = new Set<Round.RootExecutionId>()
      const admit = (id: string) => {
        if (seen.has(id)) return
        seen.add(id)
        pending.push(id)
      }
      for (let index = 0; index < pending.length; index++) {
        const id = pending[index]!
        const state = executions.get(id)
        if (state !== undefined) {
          state.instance.interrupted = true
          const root = state.rootExecutionId
          cancelledLineages.add(root)
          if (!visitedLineages.has(root)) {
            visitedLineages.add(root)
            for (const round of rounds.get(root)!) admit(round)
          }
        }
        for (const child of children.get(id) ?? []) admit(child)
      }
      return pending
    }

    type ActionState = {
      readonly settlement: Deferred.Deferred<Flow.Result<unknown, unknown>>
      exit: Exit.Exit<Flow.Result<unknown, unknown>> | undefined
    }
    const actions = new Map<string, ActionState>()

    /**
     * Rebuilds one payload through the flow's own payload schema.
     *
     * The engine stores a rebuilt copy and rebuilds again for every drive, so
     * neither the caller that submitted the payload nor a handler that mutated
     * the value it received can reach the value a later drive runs on. The
     * schema constructor is the copier because it is the only description of
     * the payload the engine has: it rebuilds each struct, array, and record
     * it declares, and it hands back by reference the values it declares
     * opaque, such as a `Schema.declare` reference to a live object. Copying
     * through `Schema.toCodecJson` instead, as this did until 2026-09-01,
     * demanded a JSON representation of every member and so refused any
     * payload holding a declared reference, including every `smithers-build`
     * target that names a dependency. The constructor also belongs to the
     * schema object itself, so a flow authored against a second `effect`
     * instance is rebuilt by the instance that owns it.
     */
    const snapshot = (
      flow: Flow.Any,
      value: unknown
    ): Effect.Effect<unknown> => Effect.orDie(flow.payloadSchema.makeEffect(value as never))

    // JSON identity, with a conservative fallback for memory-only payloads.
    // Plain objects and arrays are structural even when declared opaque;
    // other references only match themselves. Bound cycles and deep inputs.
    const sameShape = (left: unknown, right: unknown, depth: number): boolean => {
      if (Object.is(left, right) || (left === 0 && right === 0)) return true
      if (depth === 0) return false
      if (typeof left !== "object" || left === null) return false
      if (typeof right !== "object" || right === null) return false
      try {
        const leftArray = Array.isArray(left)
        const rightArray = Array.isArray(right)
        if (leftArray !== rightArray) return false
        if (leftArray && (left as Array<unknown>).length !== (right as Array<unknown>).length) return false
        if (!leftArray) {
          const leftPrototype = Object.getPrototypeOf(left)
          const rightPrototype = Object.getPrototypeOf(right)
          if (leftPrototype !== Object.prototype && leftPrototype !== null) return false
          if (rightPrototype !== Object.prototype && rightPrototype !== null) return false
        }
        const leftKeys = Object.keys(left)
        const rightKeys = Object.keys(right)
        if (leftKeys.length !== rightKeys.length) return false
        for (const key of leftKeys) {
          if (!Object.hasOwn(right, key)) return false
          if (
            !sameShape(
              (left as Record<string, unknown>)[key],
              (right as Record<string, unknown>)[key],
              depth - 1
            )
          ) return false
        }
        return true
      } catch {
        return false
      }
    }

    const samePayload = (flow: Flow.Any, left: unknown, right: unknown): Effect.Effect<boolean> =>
      Effect.gen(function*() {
        // A declared live reference need not have a JSON codec. Codec
        // construction itself can throw, so include it in the fallback.
        const encoded = yield* Effect.exit(Effect.suspend(() => {
          const encode = Schema.encodeEffect(Schema.toCodecJson(flow.payloadSchema))
          return Effect.zip(encode(left as never), encode(right as never)) as Effect.Effect<
            [Schema.Json, Schema.Json],
            Schema.SchemaError
          >
        }))
        return Exit.isSuccess(encoded)
          ? sameShape(encoded.value[0], encoded.value[1], 64)
          : sameShape(left, right, 64)
      })

    const settlement = (
      flow: Flow.Any,
      executionId: string,
      result: Flow.Result<unknown, unknown>
    ): Effect.Effect<Flow.Result<unknown, unknown>> =>
      // Memory stores decoded values. Validate the Type side so transforms
      // such as NumberFromString do not decode an already-decoded number.
      Flow.Result({
        success: Schema.toType(flow.successSchema),
        error: Schema.toType(flow.errorSchema)
      }).makeEffect(result).pipe(
        Effect.catch(() =>
          Effect.die(
            new ExecutionIdentityConflict({
              executionId,
              field: "flow",
              expected: "schemas compatible with the recorded settlement",
              actual: flow._tag,
              message: `execution ${executionId} has a settlement incompatible with the schemas of flow ${flow._tag}`
            })
          )
        )
      )

    // Untraced because resume recursively drives suspended executions.
    const resumeUnlocked = Effect.fnUntraced(function*(
      executionId: string,
      state: ExecutionState
    ): Effect.fn.Return<void> {
      wake(executionId)
      // Only the first drive and a suspended round are driven: a live round
      // keeps running, and every other settlement is terminal.
      if (state.fiber !== undefined && !settledSuspended(state)) return

      // The latest still-open registration serves every drive, so a re-drive
      // after an inner scoped registration of the tag closed follows the
      // outer registration exactly as `make.register`'s declaration table
      // does. With every registration closed the execution stays parked for
      // a process that registers the flow again — the durable driver takes
      // the same posture for a run that wakes where its flow is unknown.
      const entry = flows.get(state.instance.flow._tag)?.at(-1)
      if (entry === undefined) return
      const instance = makeInstance(
        state.instance.flow,
        state.instance.executionId,
        state.instance.lineageDeadline
      )
      instance.interrupted = state.instance.interrupted
      state.instance = instance
      state.fiber = yield* snapshot(instance.flow, state.payload).pipe(
        Effect.flatMap((payload) => entry.execute(payload as object, instance.executionId)),
        CapabilitySet.attenuateGroups(state.capabilityCeilings),
        // Runs as the forked body fiber's first instruction: it hands
        // `interrupt` the fiber the body runs in, and it answers a
        // cancellation that landed BEFORE the body started — the flag is
        // already set, so the body self-interrupts instead of dispatching
        // work whose cancellation was requested.
        (body) =>
          Effect.withFiber<unknown, unknown, FlowRuntime.FlowInstance | FlowRuntime.FlowRuntime>(
            (fiber) => {
              state.bodyFiber = fiber
              return instance.interrupted ? Effect.interrupt : body
            }
          ),
        Effect.onExit(() => {
          if (!instance.interrupted) {
            return Effect.void
          }
          instance.suspended = false
          return Effect.withFiber((fiber) => Effect.interruptible(Fiber.interrupt(fiber)))
        }),
        Flow.intoResult,
        Effect.provideService(FlowRuntime.FlowInstance, instance),
        Effect.provideService(FlowRuntime.FlowRuntime, engine),
        Effect.tap((result) => {
          if (!state.parent || result._tag !== "Complete") {
            return Effect.void
          }
          return Effect.forkIn(resume(state.parent), scope)
        }),
        Effect.onExit(() => Effect.sync(() => wake(state.instance.executionId))),
        Effect.forkIn(entry.scope)
      )
    })

    const resume = (executionId: string): Effect.Effect<void> =>
      Effect.suspend(() => {
        const state = executions.get(executionId)
        if (state === undefined) return Effect.void
        const previous = state.fiber
        return withExecutionLock(
          executionId,
          Effect.suspend(() => state.fiber === previous ? resumeUnlocked(executionId, state) : Effect.void)
        )
      })

    const deferredResults = new Map<string, Exit.Exit<any, any>>()

    const clocks = yield* FiberMap.make<string>()

    const unbound = makeUnsafe({
      // Untraced because registration feeds back into the in-memory engine.
      register: Effect.fnUntraced(function*(flow, execute) {
        const registration: Registration = {
          flow,
          execute,
          scope: yield* Effect.scope
        }
        const existing = flows.get(flow._tag)
        const entries = existing ?? []
        if (existing === undefined) flows.set(flow._tag, entries)
        entries.push(registration)
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            entries.splice(entries.indexOf(registration), 1)
            if (entries.length === 0) flows.delete(flow._tag)
          })
        )
      }),
      // Untraced because execution recursively invokes child flows.
      execute: Effect.fnUntraced(function*(flow, options) {
        let cancelJoined = false
        const admitted = yield* withExecutionLock(
          options.executionId,
          Effect.gen(function*() {
            const entry = flows.get(flow._tag)?.at(-1)
            if (!entry) {
              return yield* Effect.die(
                new FlowNotRegistered({
                  flowName: flow._tag,
                  message: `Flow ${flow._tag} is not registered`
                })
              )
            }

            let state = executions.get(options.executionId)
            // An execution id names one run of one flow declaration and one
            // rebuilt payload snapshot. A reused id may join only when both
            // identities match, exactly as the durable driver's `ensureCreatedRun`
            // does. The id is caller-supplied identity, so a multi-tenant server
            // must namespace it before requests share an engine.
            if (state !== undefined && state.instance.flow._tag !== flow._tag) {
              return yield* Effect.die(
                new ExecutionIdentityConflict({
                  executionId: options.executionId,
                  field: "flow",
                  expected: state.instance.flow._tag,
                  actual: flow._tag,
                  message: `execution ${options.executionId} already belongs to flow ${state.instance.flow._tag}; ` +
                    `it cannot be reused for flow ${flow._tag}`
                })
              )
            }
            const requestedCeilings = yield* requestedAuthority(flow)
            if (state !== undefined) {
              const requestedPayload = yield* snapshot(flow, options.payload)
              if (!(yield* samePayload(flow, state.payload, requestedPayload))) {
                return yield* Effect.die(
                  new ExecutionIdentityConflict({
                    executionId: options.executionId,
                    field: "payload",
                    expected: "the payload the execution was admitted with",
                    actual: "a different payload",
                    message: `execution ${options.executionId} already belongs to the payload it was admitted with; ` +
                      "it cannot be reused for a different payload"
                  })
                )
              }
              // A join answers the result the run's admitted authority produced.
              if (!joinable(state.capabilityCeilings, requestedCeilings)) {
                return yield* Effect.die(capabilityConflict(options.executionId))
              }
            }
            if (options.parent !== undefined) {
              yield* recordParent(options.executionId, options.parent.executionId)
              if (
                state !== undefined && (options.parent.interrupted ||
                  executions.get(options.parent.executionId)?.instance.interrupted === true)
              ) {
                // Joining is also child admission. An existing independent run
                // must not escape an already-cancelled parent's ownership edge.
                // Deliver after releasing this id's admission lock: cancellation
                // can re-drive a parked child and acquires the same lock.
                cancelJoined = true
              }
            }
            if (!state) {
              const storedPayload = yield* snapshot(flow, options.payload)
              const rootExecutionId = options.round.rootExecutionId
              const instance = makeInstance(flow, options.executionId, options.lineageDeadline)
              const parent = options.parent
              instance.interrupted = cancelledLineages.has(rootExecutionId) ||
                (parent !== undefined && (parent.interrupted ||
                  executions.get(parent.executionId)?.instance.interrupted === true))
              if (instance.interrupted) cancelledLineages.add(rootExecutionId)
              state = {
                // The stored value never crosses into user code. Every drive
                // rebuilds its own copy, so caller and handler mutation cannot
                // alter a replay.
                payload: storedPayload,
                capabilityCeilings: requestedCeilings,
                instance,
                rootExecutionId,
                fiber: undefined,
                bodyFiber: undefined,
                parent: options.parent?.executionId
              }
              // Publish the state and install its driver together. All asynchronous
              // payload rebuilding now belongs to that driver, inside intoResult.
              yield* Effect.uninterruptible(Effect.gen(function*() {
                executions.set(options.executionId, state!)
                const members = rounds.get(rootExecutionId) ?? new Set<string>()
                members.add(options.executionId)
                rounds.set(rootExecutionId, members)
                yield* resumeUnlocked(options.executionId, state!)
              }))
            }
            return state
          })
        )
        if (cancelJoined) yield* engine.interrupt(flow, options.executionId).pipe(Effect.orDie)
        if (options.discard) return
        return (yield* settlement(flow, options.executionId, yield* Fiber.join(admitted.fiber!))) as any
      }),
      // Untraced because interruption is coordinated from recursive execution.
      interrupt: Effect.fnUntraced(function*(_flow, executionId) {
        const targets = requestCancellation(executionId)
        for (const target of targets) {
          const state = executions.get(target)
          if (state === undefined) continue
          // `execute` installs the state and synchronously starts `resume`
          // before it can return its execution id, so every publicly
          // observable execution has a round fiber to inspect.
          const exit = state.fiber!.pollUnsafe()
          if (exit === undefined) {
            // The round is LIVE. The interruption is delivered to the body
            // fiber rather than the round fiber: the round fiber then converts
            // it into the recorded cancellation — `Complete` with an interrupt
            // cause, after the body's finalizers ran — where interrupting the
            // round fiber itself would leave `poll` dying on a bare interrupt
            // exit. Delivery is a send, not an await: the contract is a
            // cancellation REQUEST, and a body pinned in an uninterruptible
            // region settles on its own time with the request already
            // recorded. A round fiber that has not started yet has no body
            // fiber; its body observes the flag and self-interrupts on start.
            if (state.bodyFiber !== undefined) {
              const bodyFiber = state.bodyFiber
              yield* Effect.withFiber((fiber) => Effect.sync(() => bodyFiber.interruptUnsafe(fiber.id)))
            }
            continue
          }
          yield* resume(target)
        }
      }),
      // Untraced because interruption is coordinated from recursive execution.
      interruptUnsafe: Effect.fnUntraced(function*(_flow, executionId) {
        const targets = requestCancellation(executionId)
        // `execute` installs the state and synchronously starts `resume`
        // before it can return its execution id. `resume` assigns this fiber
        // without yielding, so every publicly observable execution has one.
        yield* Effect.forEach(targets, (target) => {
          const state = executions.get(target)
          return state === undefined ? Effect.void : Fiber.interrupt(state.fiber!)
        }, { concurrency: "unbounded", discard: true })
      }),
      resume(flow, executionId) {
        // Only an execution of this declaration that the caller's authority
        // covers is driven; an unknown or foreign id drives nothing.
        return Effect.suspend(() => {
          const state = executions.get(executionId)
          return state === undefined || state.instance.flow._tag !== flow._tag
            ? Effect.void
            : Effect.andThen(authorize(flow, state, executionId), resume(executionId))
        })
      },
      resumeSignal: (_flow, executionId) =>
        Effect.suspend(() => {
          let pending = wakes.get(executionId)
          if (pending === undefined) {
            pending = Deferred.makeUnsafe<void>()
            wakes.set(executionId, pending)
          }
          return Deferred.await(pending)
        }),
      // Untraced because action execution is a retry-loop hot path.
      actionExecute: Effect.fnUntraced(function*(options) {
        const action = options.action
        const instance = yield* FlowRuntime.FlowInstance
        // Publish ownership and install its settlement finalizer without an
        // interruptible gap. Even a scheduler yield during Deferred allocation
        // must not let a second caller claim the same key and attempt.
        return yield* Effect.uninterruptibleMask((restore) =>
          Effect.suspend(() => {
            const actionId = JSON.stringify([options.key, options.attempt])
            const state = actions.get(actionId)
            if (state) {
              const exit = state.exit
              if (exit && exit._tag === "Success" && exit.value._tag === "Suspended") {
                actions.delete(actionId)
              } else if (exit) {
                return exit
              } else {
                return restore(Deferred.await(state.settlement))
              }
            }
            const owner: ActionState = {
              exit: undefined,
              settlement: Deferred.makeUnsafe<Flow.Result<unknown, unknown>>()
            }
            actions.set(actionId, owner)
            const actionInstance = makeInstance(instance.flow, instance.executionId)
            actionInstance.interrupted = instance.interrupted
            // DECIDED: the waiting classification is
            // threaded through the dispatch's instance and back, because a driver
            // gives an action its own instance while `annotateWaiting` is
            // documented to reach the parked run. An implementation that declares
            // one — `Sleep` under `timer`, `WaitFor` under `event` with its wake
            // token — writes it here, so without the thread-back the driver would
            // park on the derived default and the declaration would be inert for
            // every action. It is seeded as well as copied back so a body that
            // annotated before dispatching keeps its own declaration, and so the
            // consumption `deferredResult` performs on a settled wait travels out
            // the same way (issue #42).
            const waitingBefore = instance.waiting
            actionInstance.waiting = waitingBefore
            return restore(action.executeEncoded.pipe(
              Flow.intoResult,
              Effect.provideService(FlowRuntime.FlowInstance, actionInstance)
            )).pipe(
              Effect.onExit((exit) => {
                if (Exit.isSuccess(exit)) {
                  owner.exit = exit
                } else {
                  // An interrupted dispatch has no settlement to replay.
                  actions.delete(actionId)
                }
                return Deferred.done(owner.settlement, exit)
              }),
              Effect.ensuring(Effect.sync(() => {
                if (instance.waiting === waitingBefore) instance.waiting = actionInstance.waiting
              }))
            )
          })
        )
      }),
      poll: (flow, executionId) =>
        Effect.suspend(() => {
          const state = executions.get(executionId)
          if (!state) {
            // An unknown execution is a typed failure, not `Option.none`:
            // `none` is reserved for a known run that has not settled yet.
            return Effect.fail(
              new FlowRuntime.FlowExecutionNotFound({
                code: "execution_not_found",
                executionId
              })
            )
          }
          // A run owned by another declaration has no settled result from
          // this flow's view. `none` matches the durable driver's posture and
          // avoids presenting another flow's encoded result under this one.
          if (state.instance.flow._tag !== flow._tag) return Effect.succeedNone
          return Effect.andThen(
            authorize(flow, state, executionId),
            Effect.suspend(() => {
              const exit = state.fiber?.pollUnsafe()
              if (!exit) {
                return Effect.succeedNone
              }
              return exit._tag === "Success"
                ? Effect.map(settlement(flow, executionId, exit.value), Option.some)
                : Effect.die(exit.cause)
            })
          )
        }),
      // Untraced because deferred polling is a flow scheduler hot path.
      deferredResult: Effect.fnUntraced(function*(deferred) {
        const instance = yield* FlowRuntime.FlowInstance
        const id = JSON.stringify([instance.flow._tag, instance.executionId, deferred.name])
        return Option.fromNullishOr(deferredResults.get(id))
      }),
      deferredDone: (options) =>
        Effect.suspend(() => {
          const execution = executions.get(options.executionId)
          if (execution !== undefined && execution.instance.flow._tag !== options.flowName) {
            return Effect.die(
              new ExecutionIdentityConflict({
                executionId: options.executionId,
                field: "flow",
                expected: execution.instance.flow._tag,
                actual: options.flowName,
                message: `execution ${options.executionId} belongs to flow ${execution.instance.flow._tag}; ` +
                  `a deferred for ${options.flowName} cannot complete it`
              })
            )
          }
          const id = JSON.stringify([options.flowName, options.executionId, options.deferredName])
          if (deferredResults.has(id)) return Effect.void
          deferredResults.set(id, options.exit)
          return resume(options.executionId)
        }),
      deferredDoneIfWaiting: (options) =>
        Effect.suspend(() => {
          const execution = executions.get(options.executionId)
          const waiting = execution?.instance.waiting
          // The annotation counts only while the round that made it is
          // parked: a running body has no wait to complete yet, and an
          // annotation left behind by a completed or cancelled round names
          // a wait that no longer exists. The durable store answers the
          // same way because its waiting row is written when a round parks.
          if (
            execution === undefined ||
            execution.instance.flow._tag !== options.flowName ||
            !settledSuspended(execution) ||
            waiting?.reason !== options.reason ||
            waiting.token !== options.token
          ) {
            return Effect.succeed("NotWaiting" as const)
          }
          const id = JSON.stringify([options.flowName, options.executionId, options.deferredName])
          const outcome = deferredResults.has(id) ? "Existing" as const : "Completed" as const
          if (outcome === "Completed") deferredResults.set(id, options.exit)
          return resume(options.executionId).pipe(Effect.as(outcome))
        }),
      scheduleClock: (flow, options) =>
        engine.deferredDone(options.clock.deferred, {
          flowName: flow._tag,
          executionId: options.executionId,
          deferredName: options.clock.deferred.name,
          exit: Exit.void
        }).pipe(
          Effect.delay(options.clock.duration),
          FiberMap.run(clocks, JSON.stringify([flow._tag, options.executionId, options.clock.name]), {
            onlyIfMissing: true
          }),
          Effect.asVoid
        )
    })
    const engine: FlowRuntime.FlowRuntime["Service"] = bindHostCeiling(host, unbound)

    return engine
  })
)
