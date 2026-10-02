/**
 * A minimal in-memory implementation of the `FlowRuntime` port, used to
 * exercise the authoring APIs this package owns.
 *
 * `@smthrs/flow` deliberately does not depend on anything that executes
 * flows, so its suite cannot reach for `@smthrs/engine`'s `layerMemory`. This
 * fixture is the smallest runtime the authoring surface needs: it registers
 * handlers, drives suspension and resumption, memoizes action outcomes per
 * (identity, attempt), and records durable deferred results. Everything the
 * real engine adds on top — step-key derivation, ordinal pinning, retry
 * policy decisions, snapshot boundaries — is tested in `@smthrs/engine`,
 * against the engine that owns it.
 */
import { Action, DurableDeferred, Flow, FlowRuntime } from "@smthrs/flow"
import * as Context from "effect/Context"
import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as FiberMap from "effect/FiberMap"
import * as Latch from "effect/Latch"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"

/** Builds the per-execution state the port's combinators read and update. */
export const makeInstance = (
  flow: Flow.Any,
  executionId: string
): FlowRuntime.FlowInstance["Service"] => {
  const ordinals = new Map<string, number>()
  return FlowRuntime.FlowInstance.of({
    executionId,
    lineageId: `${executionId}/root`,
    flow,
    scope: Scope.makeUnsafe(),
    suspended: false,
    interrupted: false,
    waiting: undefined,
    handoff: undefined,
    cause: undefined,
    actionState: {
      count: 0,
      latch: Latch.makeUnsafe(),
      nextOrdinal: (scope: string) => {
        const next = (ordinals.get(scope) ?? 0) + 1
        ordinals.set(scope, next)
        return next
      },
      snapshots: new Map(),
      keylessInFlight: new Set()
    }
  })
}

const toJsonExit = Exit.map((value: any) => value ?? null)

/** The ordinal counter one declaration's dispatches are allocated from. */
const ordinalScope = (action: { readonly name: string; readonly idempotencyKey?: unknown }): string =>
  `${action.name}/${JSON.stringify(action.idempotencyKey ?? null)}`

/**
 * The dispatch identity this fixture hands an implementation through
 * `Action.CurrentInvocationKey`: the `ordinal`-th dispatch of `action`
 * within `executionId`, counting from one.
 *
 * The real engine derives a digest here rather than a readable tuple. What the
 * two share is what an implementation may rely on: one value per dispatch,
 * re-derived identically on every replay of that dispatch, and distinct
 * between two dispatches of the same declaration.
 */
export const dispatchKey = (
  executionId: string,
  action: { readonly name: string; readonly idempotencyKey?: unknown },
  ordinal: number
): string => JSON.stringify([executionId, ordinalScope(action), ordinal])

type Handler = (
  payload: object,
  executionId: string
) => Effect.Effect<unknown, unknown, FlowRuntime.FlowInstance | FlowRuntime.FlowRuntime>

type ExecutionState = {
  readonly payload: object
  readonly handler: Handler
  readonly parent: string | undefined
  instance: FlowRuntime.FlowInstance["Service"]
  fiber: Fiber.Fiber<Flow.Result<unknown, unknown>> | undefined
  bodyFiber: Fiber.Fiber<unknown, unknown> | undefined
}

/**
 * The half of this runtime's state a process crash does NOT take with it:
 * recorded action outcomes, and durable deferred results.
 *
 * Registrations, live executions, and armed timers are process state and are
 * rebuilt by whoever starts next; these two maps are the journal, so a case
 * that drops a runtime and builds another over the same `MemoryState` is
 * running the second process against the first one's durable record.
 */
export interface MemoryState {
  readonly actions: Map<string, Exit.Exit<Flow.Result<unknown, unknown>>>
  readonly deferredResults: Map<string, Exit.Exit<unknown, unknown>>
  /**
   * Every node record the runtime was handed, in the order it was handed
   * them, with the execution that produced it.
   *
   * Deliberately NOT deduplicated. A real journal collapses two records that
   * share a producer identity onto one row; keeping the raw sequence here is
   * what lets a case assert the property that makes that collapse work — that
   * a resumed walk re-derives the same identities — rather than assert the
   * collapse of a fixture that was written to collapse.
   */
  readonly nodeRecords: Array<{ readonly runId: string; readonly record: FlowRuntime.NodeRecord }>
}

/** An empty durable record, as a fresh database would be. */
export const makeMemoryState = (): MemoryState => ({
  actions: new Map(),
  deferredResults: new Map(),
  nodeRecords: []
})

const makeRuntime = (durable: MemoryState) =>
  Effect.gen(function*() {
    const rootScope = yield* Effect.scope
    const flows = new Map<string, { readonly handler: Handler; readonly scope: Scope.Scope }>()
    const executions = new Map<string, ExecutionState>()
    const actions = durable.actions
    const deferredResults = durable.deferredResults
    const clocks = yield* FiberMap.make<string>()

    const drive = Effect.fnUntraced(function*(executionId: string): Effect.fn.Return<void> {
      const state = executions.get(executionId)
      if (!state) return
      const exit = state.fiber?.pollUnsafe()
      if (exit && exit._tag === "Success" && exit.value._tag === "Complete") return
      if (state.fiber && !exit) return

      const entry = flows.get(state.instance.flow._tag)!
      const instance = makeInstance(state.instance.flow, executionId)
      instance.interrupted = state.instance.interrupted
      state.instance = instance
      state.fiber = yield* state.handler(state.payload, executionId).pipe(
        // Runs as the forked body fiber's first instruction, so `interrupt`
        // has the fiber the body runs in, and a cancellation that landed
        // before the body started is answered by self-interrupting rather
        // than by dispatching work whose cancellation was already requested.
        (body) =>
          Effect.withFiber<unknown, unknown, FlowRuntime.FlowInstance | FlowRuntime.FlowRuntime>((fiber) => {
            state.bodyFiber = fiber
            return instance.interrupted ? Effect.interrupt : body
          }),
        Effect.onExit(() => {
          if (!instance.interrupted) return Effect.void
          instance.suspended = false
          return Effect.withFiber((fiber) => Effect.interruptible(Fiber.interrupt(fiber)))
        }),
        Flow.intoResult,
        Effect.provideService(FlowRuntime.FlowInstance, instance),
        Effect.provideService(FlowRuntime.FlowRuntime, runtime),
        Effect.tap((result) =>
          !state.parent || result._tag !== "Complete"
            ? Effect.void
            : Effect.forkIn(drive(state.parent), rootScope)
        ),
        Effect.forkIn(entry.scope)
      )
    })

    const start = Effect.fnUntraced(function*(
      flow: Flow.Any,
      executionId: string,
      payload: object,
      parent: string | undefined
    ) {
      let state = executions.get(executionId)
      if (!state) {
        const entry = flows.get(flow._tag)
        if (!entry) return yield* Effect.die(`Flow ${flow._tag} is not registered`)
        state = {
          payload,
          handler: entry.handler,
          instance: makeInstance(flow, executionId),
          fiber: undefined,
          bodyFiber: undefined,
          parent
        }
        executions.set(executionId, state)
        yield* drive(executionId)
      }
      return state
    })

    const runtime: FlowRuntime.FlowRuntime["Service"] = FlowRuntime.FlowRuntime.of({
      register: Effect.fnUntraced(function*(flow, execute, options) {
        const services = yield* Effect.context<FlowRuntime.FlowRuntime>()
        const scope = yield* Effect.scope
        if (options?.ifAbsent === true && flows.has(flow._tag)) return
        flows.set(flow._tag, {
          scope,
          handler: (payload, executionId) =>
            Effect.suspend(() => execute(payload as any, executionId)).pipe(
              Effect.updateContext((input) => Context.merge(services, input) as Context.Context<any>)
            ) as Handler extends (...args: never) => infer R ? R : never
        })
      }) as any,
      execute: Effect.fnUntraced(function*(flow: any, options: any) {
        const parentInstance = yield* Effect.serviceOption(FlowRuntime.FlowInstance)
        const state = yield* start(
          flow,
          options.executionId,
          options.payload,
          Option.isSome(parentInstance) ? parentInstance.value.executionId : undefined
        )
        if (options.discard) return options.executionId
        if (Option.isSome(parentInstance)) {
          const wrapped = yield* Flow.wrapActionResult(
            Fiber.join(state.fiber!) as Effect.Effect<Flow.Result<unknown, unknown>>,
            (result) => result._tag === "Suspended"
          )
          if (wrapped._tag !== "Complete") return yield* Flow.suspend(parentInstance.value)
          return yield* wrapped.exit
        }
        while (true) {
          const wrapped = yield* (Fiber.join(state.fiber!) as Effect.Effect<Flow.Result<unknown, unknown>>)
          if (wrapped._tag === "Complete") return yield* (wrapped.exit as unknown as Effect.Effect<any>)
          // The port fixture does not follow a lineage — that is the engine's
          // job — so a round that handed off settles as itself here.
          if (wrapped._tag === "Handoff") return wrapped as never
          yield* Effect.sleep(1)
          yield* drive(options.executionId)
        }
      }) as any,
      poll: ((_flow: any, executionId: string) =>
        Effect.suspend(() => {
          const state = executions.get(executionId)
          if (!state) {
            return Effect.fail(
              new FlowRuntime.FlowExecutionNotFound({ code: "execution_not_found", executionId })
            )
          }
          const exit = state.fiber?.pollUnsafe()
          if (!exit) return Effect.succeedNone
          return exit._tag === "Success" ? Effect.succeedSome(exit.value) : Effect.die(exit.cause)
        })) as any,
      interrupt: Effect.fnUntraced(function*(_flow, executionId) {
        const state = executions.get(executionId)
        if (!state) return
        state.instance.interrupted = true
        const exit = state.fiber?.pollUnsafe()
        if (state.fiber && !exit) {
          // The round is LIVE, so the interruption is delivered to the BODY
          // fiber and the round fiber converts it into the recorded
          // cancellation: a `Complete` carrying an interrupt cause, raised
          // after the body's finalizers ran. Interrupting the round fiber
          // itself would leave `poll` dying on a bare interrupt exit.
          // Delivery is a send, not an await: the contract is a cancellation
          // REQUEST. `@smthrs/engine`'s memory engine takes the same posture.
          const bodyFiber = state.bodyFiber
          if (bodyFiber !== undefined) {
            yield* Effect.withFiber((fiber) => Effect.sync(() => bodyFiber.interruptUnsafe(fiber.id)))
          }
          return
        }
        // A round that has already settled into a suspension has no live body:
        // driving it once more ends it as interrupted rather than resuming it.
        yield* drive(executionId)
      }),
      interruptUnsafe: Effect.fnUntraced(function*(_flow, executionId) {
        const state = executions.get(executionId)
        if (!state) return
        state.instance.interrupted = true
        yield* Fiber.interrupt(state.fiber!)
      }),
      resume: (_flow, executionId) => drive(executionId) as Effect.Effect<void>,
      actionExecute: Effect.fnUntraced(function*(action: any, attempt: number) {
        const instance = yield* FlowRuntime.FlowInstance
        const scope = ordinalScope(action)
        const slot = yield* Action.CurrentOrdinal
        let ordinal: number
        if (slot === undefined) {
          ordinal = instance.actionState.nextOrdinal(scope)
        } else {
          const index = slot.cursors.get(scope) ?? 0
          slot.cursors.set(scope, index + 1)
          const pinned = slot.values.get(scope) ?? []
          if (index < pinned.length) {
            ordinal = pinned[index]!
          } else {
            ordinal = instance.actionState.nextOrdinal(scope)
            pinned.push(ordinal)
            slot.values.set(scope, pinned)
          }
        }
        // The dispatch's identity, and the memo slot within it. The engine
        // allocates one key per dispatch and folds the attempt in nowhere, so
        // an implementation reading `CurrentInvocationKey` gets the same value
        // on every attempt and on every replay of one node; the memo is per
        // (dispatch, attempt) because a retried attempt is its own recording.
        const dispatch = dispatchKey(instance.executionId, action, ordinal)
        const id = JSON.stringify([dispatch, attempt])
        const memo = actions.get(id)
        if (memo && !(memo._tag === "Success" && memo.value._tag === "Suspended")) {
          // The fact only the runtime knows: this dispatch was served from the
          // durable record rather than run. The real engine reports it from
          // the same place, around `ActionPersistence`. No step key digest
          // travels with it: this runtime writes no attempt rows, so there is
          // nothing for a digest to join a node to.
          yield* Action.reportDispatch({ outcome: "replayed", attempt })
          const replayed = yield* memo
          if (replayed._tag !== "Complete") return replayed
          return new Flow.Complete({
            exit: yield* Effect.orDie(
              Schema.decodeEffect(action.exitSchemaPartial)(toJsonExit(replayed.exit))
            )
          }) as any
        }
        const actionInstance = makeInstance(instance.flow, instance.executionId)
        actionInstance.interrupted = instance.interrupted
        // A dispatch gets an instance of its own — here to keep attempt state
        // apart, in the real engine to keep the dispatch's persistence apart —
        // so the waiting classification is threaded in and back out rather than
        // lost, exactly as `@smthrs/engine`'s drivers thread it. An
        // implementation that declares one (`annotateWaiting`) has it travel to
        // the flow, one whose wait already has a persisted result clears it
        // (`deferredResult`), and one that touches neither leaves whatever the
        // body declared alone — seeded here, copied back below.
        const waitingBefore = instance.waiting
        actionInstance.waiting = waitingBefore
        yield* Action.reportDispatch({ outcome: "executed", attempt })
        const result = (yield* (action.executeEncoded.pipe(
          Flow.intoResult,
          Effect.provideService(FlowRuntime.FlowInstance, actionInstance),
          Effect.provideService(Action.CurrentAttempt, attempt),
          Effect.provideService(Action.CurrentInvocationKey, dispatch),
          Effect.onExit((exit: any) => Effect.sync(() => actions.set(id, exit)))
        ) as Effect.Effect<Flow.Result<unknown, unknown>>)) as Flow.Result<unknown, unknown>
        if (instance.waiting === waitingBefore) instance.waiting = actionInstance.waiting
        // A recorded interruption is a durable OUTCOME, not a request to
        // suspend (`DurableDeferred.await` sets the flag to say so). The flag
        // is set on whichever instance is in scope, which for a declared
        // action's implementation is the dispatch's own — so it travels back
        // to the flow, exactly as the waiting classification above does.
        // Without it the flow sees an interrupt-only cause it never marked and
        // classifies a terminal outcome as an external suspension.
        if (actionInstance.interrupted) instance.interrupted = true
        if (result._tag !== "Complete") return result as never
        return new Flow.Complete({
          exit: yield* Effect.orDie(
            Schema.decodeEffect(action.exitSchemaPartial)(toJsonExit(result.exit))
          )
        }) as any
      }) as any,
      deferredResult: Effect.fnUntraced(function*(deferred: any) {
        const instance = yield* FlowRuntime.FlowInstance
        const stored = deferredResults.get(`${instance.executionId}/${deferred.name}`)
        if (stored === undefined) return Option.none()
        instance.waiting = undefined
        return Option.some(
          yield* Effect.orDie(Schema.decodeEffect(deferred.exitSchema)(toJsonExit(stored)))
        )
      }) as any,
      deferredDone: ((deferred: any, options: any) =>
        Effect.gen(function*() {
          const encoded = yield* Schema.encodeEffect(deferred.exitSchema)(options.exit) as Effect.Effect<
            Exit.Exit<unknown, unknown>
          >
          const id = `${options.executionId}/${options.deferredName}`
          if (deferredResults.has(id)) return
          deferredResults.set(id, encoded)
          yield* drive(options.executionId)
        })) as any,
      deferredDoneIfWaiting: ((deferred: any, options: any) =>
        Effect.gen(function*() {
          const execution = executions.get(options.executionId)
          const ambient = yield* Effect.serviceOption(FlowRuntime.FlowInstance)
          const instance = execution?.instance ?? Option.getOrUndefined(ambient)
          const waiting = instance?.waiting
          if (
            instance === undefined ||
            instance.executionId !== options.executionId ||
            instance.flow._tag !== options.flowName ||
            waiting === undefined ||
            waiting.reason !== options.reason ||
            waiting.token !== options.token
          ) {
            return "NotWaiting" as const
          }
          const encoded = yield* Schema.encodeEffect(deferred.exitSchema)(options.exit) as Effect.Effect<
            Exit.Exit<unknown, unknown>
          >
          const id = `${options.executionId}/${options.deferredName}`
          const outcome = deferredResults.has(id) ? "Existing" as const : "Completed" as const
          if (outcome === "Completed") deferredResults.set(id, encoded)
          instance.waiting = undefined
          instance.suspended = false
          if (execution !== undefined) yield* drive(options.executionId)
          return outcome
        })) as any,
      recordNode: (record) =>
        Effect.flatMap(FlowRuntime.FlowInstance, (instance) =>
          Effect.sync(() => {
            durable.nodeRecords.push({ runId: instance.executionId, record })
          })),
      scheduleClock: (flow, options) =>
        runtime.deferredDone(options.clock.deferred as any, {
          flowName: flow._tag,
          executionId: options.executionId,
          deferredName: options.clock.deferred.name,
          exit: Exit.void
        }).pipe(
          Effect.delay(options.clock.duration),
          FiberMap.run(clocks, `${options.executionId}/${options.clock.name}`, { onlyIfMissing: true }),
          Effect.asVoid
        ) as Effect.Effect<void>
    })

    return runtime
  })

/**
 * A `FlowRuntime` layer whose durable record is `state`, so a second build
 * over the same state is what a restarted process sees.
 */
export const layerMemoryOver = (state: MemoryState): Layer.Layer<FlowRuntime.FlowRuntime> =>
  Layer.effect(FlowRuntime.FlowRuntime)(makeRuntime(state))

/**
 * A `FlowRuntime` layer that keeps every execution, action outcome, and
 * durable deferred result in process memory. Each build gets a record of its
 * own.
 */
export const layerMemory: Layer.Layer<FlowRuntime.FlowRuntime> = Layer.effect(FlowRuntime.FlowRuntime)(
  Effect.suspend(() => makeRuntime(makeMemoryState()))
)

/**
 * Everything a bodied flow needs to run: the action implementations and the
 * flow registrations a case wires up, over ONE implementation table, over this
 * runtime.
 *
 * The table goes UNDER the layers that file into it, because filing is a
 * build-time effect: a table merged beside an implementation is not the table
 * the interpreter reads.
 *
 * Pass `state` to build over a durable record a later build can reopen;
 * without it each build gets a record of its own.
 */
export const layerWired = <Implemented = never>(
  registrations: Layer.Layer<Implemented, never, Crypto.Crypto | FlowRuntime.FlowRuntime | Action.Implementations>,
  state?: MemoryState
): Layer.Layer<Implemented | FlowRuntime.FlowRuntime | Action.Implementations, never, Crypto.Crypto> =>
  registrations.pipe(
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(state === undefined ? layerMemory : layerMemoryOver(state))
  )

/** Re-exported for the suites that only need the deferred token helpers. */
export const token = DurableDeferred.token
