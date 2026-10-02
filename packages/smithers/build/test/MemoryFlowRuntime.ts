/**
 * The smallest `FlowRuntime` that can run `Install.Install` end to end.
 *
 * `@smthrs/build` depends on `@smthrs/flow` and not on `@smthrs/engine`, so
 * its suite has no `FlowEngine.layerMemory` to compose `Install.layer` over.
 * This fixture implements the three port operations the install flow reaches
 * (register, execute, actionExecute) and refuses the rest. Every action
 * outcome is recorded as the JSON-encoded exit `Action.executeEncoded`
 * produces, which is what a real engine journals: a value that cannot be
 * encoded dies here exactly as it would there.
 *
 * Modelled on `@smthrs/flow/test/MemoryFlowRuntime.ts`, minus suspension,
 * deferreds, clocks, replay, and ordinal pinning, none of which a one-round
 * flow with three sealed actions exercises.
 */
import { Action, Flow, FlowRuntime } from "@smthrs/flow"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import type * as Exit from "effect/Exit"
import * as Latch from "effect/Latch"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"

/** One recorded action outcome: the declaration's name and its encoded exit. */
export interface JournalEntry {
  readonly action: string
  readonly exit: Exit.Exit<unknown, unknown>
}

const makeInstance = (flow: Flow.Any, executionId: string): FlowRuntime.FlowInstance["Service"] => {
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

const unsupported = (operation: string) => () =>
  Effect.die(`the build test FlowRuntime does not implement ${operation}`)

type Handler = (
  payload: object,
  executionId: string
) => Effect.Effect<unknown, unknown, FlowRuntime.FlowInstance | FlowRuntime.FlowRuntime>

/**
 * A `FlowRuntime` layer that appends every action outcome to `journal`.
 */
export const layerMemory = (journal: Array<JournalEntry>): Layer.Layer<FlowRuntime.FlowRuntime> =>
  Layer.effect(FlowRuntime.FlowRuntime)(
    Effect.sync(() => {
      const flows = new Map<string, Handler>()
      const runtime: FlowRuntime.FlowRuntime["Service"] = FlowRuntime.FlowRuntime.of({
        register: Effect.fnUntraced(function*(flow, execute, options) {
          const services = yield* Effect.context<FlowRuntime.FlowRuntime>()
          if (options?.ifAbsent === true && flows.has(flow._tag)) return
          flows.set(
            flow._tag,
            (payload, executionId) =>
              Effect.suspend(() => execute(payload as never, executionId)).pipe(
                Effect.updateContext((input) => Context.merge(services, input) as Context.Context<any>)
              )
          )
        }) as never,
        execute: Effect.fnUntraced(function*(flow: Flow.Any, options: { executionId: string; payload: object }) {
          const handler = flows.get(flow._tag)
          if (handler === undefined) return yield* Effect.die(`Flow ${flow._tag} is not registered`)
          const result = yield* handler(options.payload, options.executionId).pipe(
            Flow.intoResult,
            Effect.provideService(FlowRuntime.FlowInstance, makeInstance(flow, options.executionId)),
            Effect.provideService(FlowRuntime.FlowRuntime, runtime)
          )
          if (result._tag !== "Complete") return yield* Effect.die(`the flow did not complete: ${result._tag}`)
          return yield* result.exit
        }) as never,
        poll: unsupported("poll"),
        interrupt: unsupported("interrupt"),
        interruptUnsafe: unsupported("interruptUnsafe"),
        resume: unsupported("resume"),
        actionExecute: Effect.fnUntraced(function*(
          action: Action.Any & { readonly exitSchemaPartial: Schema.Top },
          attempt: number
        ) {
          const instance = yield* FlowRuntime.FlowInstance
          const scope = `${action.name}/${JSON.stringify(action.idempotencyKey ?? null)}`
          const ordinal = instance.actionState.nextOrdinal(scope)
          const dispatch = JSON.stringify([instance.executionId, scope, ordinal])
          const result = yield* (action.executeEncoded.pipe(
            Flow.intoResult,
            Effect.provideService(FlowRuntime.FlowInstance, makeInstance(instance.flow, instance.executionId)),
            Effect.provideService(Action.CurrentAttempt, attempt),
            Effect.provideService(Action.CurrentInvocationKey, dispatch)
          ) as Effect.Effect<Flow.Result<unknown, unknown>>)
          if (result._tag !== "Complete") return yield* Effect.die(`the action did not complete: ${result._tag}`)
          journal.push({ action: action.name, exit: result.exit })
          const exit = yield* Effect.orDie(Schema.decodeEffect(action.exitSchemaPartial)(result.exit))
          return new Flow.Complete({ exit: exit as Exit.Exit<unknown, unknown> })
        }),
        deferredResult: unsupported("deferredResult"),
        deferredDone: unsupported("deferredDone"),
        deferredDoneIfWaiting: unsupported("deferredDoneIfWaiting"),
        scheduleClock: unsupported("scheduleClock")
      })
      return runtime
    })
  )
