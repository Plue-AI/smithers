/**
 * A host that parks a run, and the host that comes back for it.
 *
 * The crash family's waiting cases need a run that is genuinely parked in
 * durable state while its host dies. After detached admission, the host
 * observes the durable suspension before `linger` prints
 * `PARKED=<executionId>` and then holds the process open until somebody kills
 * it.
 *
 * `resolve` is the replacement host: it satisfies the wait the way a control
 * plane does — answering the human task's token, completing the durable
 * deferred — and then drives the same execution to a result. `settle` skips the
 * resolution, which is what a timer needs and what a second racing host does.
 *
 * Usage:
 *   node waitChild.ts <filename> <executionId> <approval|event|timer> \
 *     <linger|settle|resolve|notify|race-timer> <counterFile> <hostId> [millis]
 */
import { DurableDeferred, FlowRuntime, HumanTask } from "@smthrs/flow"
import * as NodeRuntime from "@smthrs/flows/NodeRuntime"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import type * as Scope from "effect/Scope"
import {
  ApprovalFlow,
  approvalRegistration,
  EventFlow,
  eventRegistration,
  EventSignal,
  host,
  hostOptions,
  taskName,
  TimerFlow,
  timerRegistration,
  type WaitMode
} from "../harness/waitFlows.ts"

const [filename, executionId, modeArg, phase, counterFile, hostId, millisArg] = process.argv.slice(2)

if (
  filename === undefined || executionId === undefined || modeArg === undefined ||
  phase === undefined || counterFile === undefined || hostId === undefined
) {
  process.stderr.write(
    "usage: waitChild.ts <filename> <executionId> <mode> <linger|settle|resolve|notify|race-timer> <counterFile> <hostId> [millis]\n"
  )
  process.exit(2)
}
if (modeArg !== "approval" && modeArg !== "event" && modeArg !== "timer") {
  process.stderr.write(`waitChild: invalid mode ${modeArg}\n`)
  process.exit(2)
}
if (phase !== "linger" && phase !== "settle" && phase !== "resolve" && phase !== "notify" && phase !== "race-timer") {
  process.stderr.write(`waitChild: invalid phase ${phase}\n`)
  process.exit(2)
}
if (phase === "race-timer" && modeArg !== "timer") {
  process.stderr.write("waitChild: race-timer requires timer mode\n")
  process.exit(2)
}

const mode: WaitMode = modeArg
const options = { filename, counterFile, hostId }
const millis = millisArg === undefined ? 3_000 : Number(millisArg)
const label = "wait"

const waitForPark = Effect.gen(function*() {
  for (let attempt = 0; attempt < 20_000; attempt++) {
    const observed = yield* (mode === "approval"
      ? ApprovalFlow.poll(executionId)
      : mode === "event"
      ? EventFlow.poll(executionId)
      : TimerFlow.poll(executionId))
    if (observed._tag === "Some" && observed.value._tag === "Suspended") return
    yield* Effect.sleep("2 millis")
  }
  return yield* Effect.die(`run ${executionId} did not park`)
}).pipe(Effect.orDie)

/** The wait point the first attempt at the question resolves through. */
const approvalToken = DurableDeferred.tokenFromExecutionId(HumanTask.deferred(taskName, 1), {
  flow: ApprovalFlow,
  executionId
})

const announce = (value: unknown): void => {
  process.stdout.write(
    phase === "linger" ? `PARKED=${String(value)}\n` : `SETTLED=${JSON.stringify(value ?? null)}\n`
  )
}

/**
 * Drives the run on `layer`, first satisfying the wait in `resolve`. Both
 * effects may need only what `layer` provides (plus a scope), so tsc rejects
 * a body that needs anything else.
 */
const run = <ROut, LE, A, E>(
  resolveWait: Effect.Effect<void, unknown, NoInfer<ROut> | Scope.Scope>,
  body: Effect.Effect<A, E, NoInfer<ROut> | Scope.Scope>,
  layer: Layer.Layer<ROut, LE, Scope.Scope>
): Promise<Exit.Exit<A, E | LE>> =>
  Effect.runPromise(
    Effect.gen(function*() {
      if (phase === "resolve") yield* Effect.orDie(resolveWait)
      const value = yield* body
      announce(value)
      return value
    }).pipe(
      Effect.provide(layer),
      Effect.scoped,
      Effect.exit
    )
  )

/**
 * Satisfies the wait on `layer` and leaves. Nobody drives the run: that is
 * what makes the two hosts that come next a real race.
 */
const notify = <ROut, LE>(
  resolveWait: Effect.Effect<void, unknown, NoInfer<ROut> | Scope.Scope>,
  layer: Layer.Layer<ROut, LE, Scope.Scope>
): Promise<Exit.Exit<void, LE>> =>
  Effect.runPromise(
    Effect.orDie(resolveWait).pipe(
      Effect.andThen(Effect.sync(() => process.stdout.write("RESOLVED\n"))),
      Effect.asVoid,
      Effect.provide(layer),
      Effect.scoped,
      Effect.exit
    )
  )

const answerQuestion = Effect.suspend(() => HumanTask.answer({ token: approvalToken, value: true }))
const completeSignal = Effect.gen(function*() {
  const runtime = yield* FlowRuntime.FlowRuntime
  yield* runtime.deferredDone(EventSignal, {
    flowName: EventFlow._tag,
    executionId,
    deferredName: EventSignal.name,
    exit: Exit.succeed("signalled")
  })
})

// Completing a deferred schedules a wake. A notifier must register no flows,
// or it can claim the run before the two racing hosts have even started.
const notifier = NodeRuntime.layerHost(hostOptions(options), Layer.empty)

/** A service no wait host provides. */
class Unprovided extends Context.Service<Unprovided, { readonly value: string }>()("test/waitChild/Unprovided") {}

/**
 * Never called; tsc checks it (#2704). This child runs as a script, so the
 * directives are the whole assertion.
 */
const unprovidedServiceProbe = () => {
  // @ts-expect-error the notifier host does not provide Unprovided
  notify(Effect.map(Unprovided, (service) => service.value), notifier)
  // @ts-expect-error the approval host does not provide Unprovided
  run(Effect.void, Effect.map(Unprovided, (service) => service.value), host(approvalRegistration, options))
  notify(Effect.void, notifier)
  run(Effect.void, Effect.succeed(1), host(approvalRegistration, options))
}
void unprovidedServiceProbe

const exit: Exit.Exit<unknown, unknown> = phase === "notify"
  ? await notify(mode === "approval" ? answerQuestion : mode === "event" ? completeSignal : Effect.void, notifier)
  : mode === "approval"
  ? await run(
    answerQuestion,
    phase === "linger"
      ? ApprovalFlow.execute({ label }, { executionId, discard: true }).pipe(Effect.tap(() => waitForPark))
      : ApprovalFlow.execute({ label }, { executionId }),
    host(approvalRegistration, options)
  )
  : mode === "event"
  ? await run(
    completeSignal,
    phase === "linger"
      ? EventFlow.execute({ label }, { executionId, discard: true }).pipe(Effect.tap(() => waitForPark))
      : EventFlow.execute({ label }, { executionId }),
    host(eventRegistration(options), options)
  )
  : await run(
    Effect.void,
    phase === "linger"
      ? TimerFlow.execute({ millis }, { executionId, discard: true }).pipe(Effect.tap(() => waitForPark))
      : phase === "race-timer"
      ? Effect.gen(function*() {
        // Both hosts register and observe the same suspended execution before
        // its absolute deadline. They remain alive with their timers armed.
        const parked = yield* TimerFlow.execute({ millis }, { executionId, discard: true }).pipe(
          Effect.tap(() => waitForPark)
        )
        process.stdout.write(`PARKED=${parked}\n`)
        return yield* TimerFlow.execute({ millis }, { executionId })
      })
      : TimerFlow.execute({ millis }, { executionId }),
    host(timerRegistration(options), options)
  )

if (Exit.isFailure(exit)) {
  process.stderr.write(`${String(exit.cause)}\n`)
  process.exit(1)
}
// A lingering host has parked its run and now exists only to be killed. The
// interval is a real libuv handle: a bare unsettled promise lets Node decide
// the event loop is empty and exit, which is the opposite of lingering.
if (phase === "linger") setInterval(() => {}, 1_000)
else process.exit(0)
