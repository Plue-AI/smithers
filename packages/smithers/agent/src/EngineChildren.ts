/**
 * The durable half of {@link ChildFlows}: detached children as real runs.
 *
 * `ChildFlows` declares `agent/spawn`, `agent/send`, and `agent/await` and
 * leaves the lifecycle behind the injected {@link ChildFlows.Children} port,
 * because nothing in a browser-safe package can honestly claim to persist a
 * detached run. This module is the implementation a host with a durable engine
 * supplies. Every operation is a durable one:
 *
 * - `spawn` starts a run of its own — a separate row, a separate claim, a
 *   separate journal — linked to the caller through the engine's parent-edge
 *   table. It is spawned with the result DISCARDED, which is what records
 *   `onParentExit: "detach"` on the child, so the child outlives the run that
 *   started it instead of being cancelled with it.
 * - `await` reads the child's settled result out of the run store, so it works
 *   from a different engine, a different process, and a later incarnation than
 *   the one that spawned it.
 * - `send` steers the child through the control plane, which admits a durable
 *   `human-steer` message the child drains at its next turn boundary.
 *
 * **What it is allowed to touch.** Three services and no more: the flow
 * runtime that starts and polls executions, the run store that says whether a
 * child exists, and the control plane that steers one. It reaches into no
 * engine internals — the engine's own state document is read through the one
 * public field `RunStore.RunRow.stateJson`, projected down to the single key
 * this port needs (see {@link ChildState}) — so the port composes over any
 * runtime that satisfies those three contracts rather than over one engine
 * implementation.
 *
 * **Whose children it reaches.** `await` and `send` take the child id as a
 * plain string a cell writes, so a call made inside a run is restricted to
 * that run's own child namespace — the ids `childExecutionId` derives from its
 * execution id. Without that, the string was a selector over every run the host
 * could see, and a cell that learned another run's id read its result and
 * steered it. A call made from OUTSIDE any run is the host collecting a child
 * of its own, which is the cross-process path below and is not model-reachable:
 * such a caller composed this port and already holds the run store and the
 * control plane it reads and steers through.
 *
 * The one thing it does not do is park the caller. `await` waits by re-reading
 * the child's run row on an interval rather than suspending the run, so a cell
 * that awaits a long child holds its round open. That is a bounded, honest cost of
 * the port's shape — `Children.await` answers with a value — and the note is
 * here rather than in a comment on the loop because it is the operation's
 * contract, not an implementation detail.
 *
 * @since 0.1.0
 */

import { Control } from "@smthrs/control/Control"
import type { ControlError } from "@smthrs/control/ControlError"
import type { Flow } from "@smthrs/flow"
import { Action, FlowRuntime } from "@smthrs/flow"
import { RunStore } from "@smthrs/run-store"
import * as Cause from "effect/Cause"
import * as Crypto from "effect/Crypto"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { ChildError } from "./ChildFlows.ts"
import * as ChildFlows from "./ChildFlows.ts"

/**
 * How a host wires detached children onto its engine.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options {
  /**
   * The flows a child may run, by `_tag`.
   *
   * This is the authority behind `ChildError { code: "not_found" }`: a name
   * that is not here names nothing this host can start, and saying so is
   * data the cell can route around. Registering the flow with the runtime is
   * separate and still required — this list is what the child lifecycle is
   * allowed to reach, not what the engine knows how to run.
   */
  readonly flows: ReadonlyArray<Flow.Any>
  /**
   * How long `await` waits before re-reading a child that has not settled,
   * and how long `spawn` waits between checks for the child's run row.
   *
   * Defaults to 250 ms.
   */
  readonly pollInterval?: Duration.Input | undefined
  /**
   * How long `spawn` waits for the child's run row to exist before reporting
   * that the child never started.
   *
   * `spawn` returns an id, so the id has to name something durable by the time
   * it does — otherwise a later `await` from another process would be waiting
   * on a run that was never created. Defaults to 30 seconds.
   */
  readonly startTimeout?: Duration.Input | undefined
  /**
   * How long `await` polls a child that has not settled before answering
   * `still_running`, when the call names no `timeoutSeconds`.
   *
   * A child parked on an approval nobody answers would otherwise hold the
   * parent's cell call in a poll loop forever. Defaults to 10 minutes.
   */
  readonly awaitTimeout?: Duration.Input | undefined
}

/**
 * The execution id a labelled child of `parentExecutionId` runs under.
 *
 * Derived rather than minted, so a parent that is re-driven — a resume, a
 * reclaim, a replayed cell — spawns the SAME child rather than a second one:
 * the engine's create is idempotent on the execution id. The label is
 * therefore the child's identity within its parent, and two concurrent
 * children need two labels.
 *
 * @category constructors
 * @since 0.1.0
 */
export const childExecutionId = (
  parentExecutionId: string,
  label: string
): string => `child-v2:${parentExecutionId.length}:${parentExecutionId}${label.length}:${label}`

/** Checks ancestry through the length-delimited parent component. */
const ownsChild = (parentExecutionId: string, child: string): boolean => {
  let current = child
  while (true) {
    const prefix = /^child-v2:(\d+):/.exec(current)
    if (prefix === null) return false
    const start = prefix[0].length
    const length = Number(prefix[1])
    const parent = current.slice(start, start + length)
    const label = /^(\d+):([\s\S]*)$/.exec(current.slice(start + length))
    if (label === null || childExecutionId(parent, label[2]!) !== current) return false
    if (parent === parentExecutionId) return true
    current = parent
  }
}

const notFound = (message: string): ChildError => new ChildError({ code: "not_found", message })

const failed = (message: string): ChildError => new ChildError({ code: "failed", message })

/**
 * The refusal a lifecycle call gets when it names a run outside its children.
 *
 * `not_found`, deliberately: a cell that asked for a run it does not own has no
 * business learning whether that run exists, and `not_found` is the code that
 * tells a cell to stop asking rather than to retry. The message names the shape
 * of an id this run CAN use, which is what a cell that mistyped a label needs,
 * and says nothing about the run it asked for.
 */
const unowned = (operation: string, parentExecutionId: string, child: string): ChildError =>
  notFound(
    `${operation} knows no child run ${child}. A child of this run is named ` +
      `${childExecutionId(parentExecutionId, "<label>")}, so that id belongs to another run.`
  )

/**
 * The largest rendered child cause returned to a cell.
 *
 * 2,048 characters preserve a useful typed error and its immediate context
 * without copying an unbounded engine stack into the cell transcript and its
 * durable call record.
 */
const maxChildFailureCauseCharacters = 2_048

const boundedCause = (cause: Cause.Cause<unknown>): string =>
  Cause.pretty(cause).slice(0, maxChildFailureCauseCharacters)

/**
 * The one thing this port reads out of a child run's state document.
 *
 * `RunStore` publishes a run's state as `RunRow.stateJson`, an opaque string
 * it neither writes nor interprets, and a runtime fills it with whatever it
 * needs to resume the run. `await` needs exactly one key out of it: the name
 * of the flow the child is running, because `FlowRuntime.poll` addresses an
 * execution by declaration and a cell only ever has the child's id.
 *
 * Declared here, narrow, rather than imported from an engine: a projection
 * that names one field is a dependency on that field, which is the smallest
 * one that can answer the question. Excess keys decode away, so a runtime
 * that records more than this — every runtime does — still satisfies it.
 *
 * @category schemas
 * @since 0.1.0
 */
export const ChildState = Schema.Struct({
  flowName: Schema.String
})

const decodeChildState = Schema.decodeUnknownEffect(Schema.fromJsonString(ChildState))

/**
 * Renders a child's success value as the text `agent/await` answers with.
 *
 * A string child answers with its own text rather than with a quoted JSON
 * string, because the value is going into a model's context and the quotes
 * would be noise.
 */
const asText = (value: unknown): string => typeof value === "string" ? value : JSON.stringify(value ?? null)

/**
 * Builds the durable child port over this host's engine and run store.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (
  options: Options
): Effect.Effect<
  ChildFlows.Children,
  never,
  Control | Crypto.Crypto | FlowRuntime.FlowRuntime | RunStore.RunStore
> =>
  Effect.gen(function*() {
    const runtime = yield* FlowRuntime.FlowRuntime
    const store = yield* RunStore.RunStore
    const control = yield* Control
    /**
     * Captured at construction, not required per call.
     *
     * `ChildFlows.Children` fixes every method's requirement channel at
     * `never`, so a service a method needs has to be resolved here. Hashing is
     * one: `send` names its message with the canonical step key, and that
     * derivation takes its digest from injected cryptography rather than a
     * global, so the port has to hold the service to be able to run it.
     */
    const crypto = yield* Crypto.Crypto
    const pollInterval = Duration.fromInputUnsafe(options.pollInterval ?? "250 millis")
    const startTimeout = Duration.fromInputUnsafe(options.startTimeout ?? "30 seconds")
    const awaitTimeout = Duration.fromInputUnsafe(options.awaitTimeout ?? "10 minutes")
    const declarations = new Map(options.flows.map((flow) => [flow._tag, flow]))

    /**
     * The child's run row, or nothing if no such run exists yet.
     *
     * Only `not_found_row` becomes "nothing". A store that cannot answer is a
     * typed `failed`, logged with its cause: reporting it as an absent child
     * would tell a cell its child never existed, which is a different and much
     * worse claim, and a transient store error (a busy database, an I/O
     * failure) is not a defect in the calling cell.
     */
    const rowOf = (executionId: string): Effect.Effect<Option.Option<RunStore.RunRow>, ChildError> =>
      store.get(executionId).pipe(
        Effect.map(Option.some),
        Effect.catch((error) =>
          error.code === "not_found_row"
            ? Effect.succeedNone
            : Effect.logWarning(`agent: the run store could not read child run ${executionId}`, error).pipe(
              Effect.andThen(Effect.fail(failed(`The run store could not read the child run ${executionId}.`)))
            )
        )
      )

    /**
     * The parent run this operation belongs to.
     *
     * Read from the ambient context rather than injected: a `Children` method
     * is invoked inside the flow body that called it, so the instance is
     * whatever run is executing. A call from outside any run has no parent to
     * link a child to and no identity to derive one's id from, which the
     * refusal says.
     */
    const parentInstance = (operation: string) =>
      Effect.serviceOption(FlowRuntime.FlowInstance).pipe(
        Effect.flatMap(Option.match({
          onNone: () =>
            Effect.fail(
              new ChildError({
                code: "unsupported",
                message: `${operation} needs a running flow to attach the child to, and none is executing.`
              })
            ),
          onSome: Effect.succeed
        }))
      )

    /**
     * Refuses a lifecycle call that names a run the caller did not start.
     *
     * `await` and `send` are reachable by a model: `ChildFlows.source` binds
     * them as tools whose `child` is a plain string the cell writes. Checking
     * only that the id names an existing row made that string a selector over
     * every run on the host, so a cell that learned another run's id read its
     * result and steered it. The ambient instance is the run this call is
     * executing inside — the same identity `spawn` derived the child's id from
     * — so comparing the two is the whole ownership question.
     *
     * A call from OUTSIDE any run is the host collecting a child of its own,
     * which is the documented cross-process path and is not model-reachable:
     * such a caller composed this port and already holds the run store and the
     * control plane the operations read and steer through, so refusing it
     * would take nothing away from anyone.
     */
    const ownedByCaller = (operation: string, child: string): Effect.Effect<void, ChildError> =>
      Effect.serviceOption(FlowRuntime.FlowInstance).pipe(
        Effect.flatMap(Option.match({
          onNone: () => Effect.void,
          onSome: (parent: FlowRuntime.FlowInstance["Service"]) =>
            ownsChild(parent.executionId, child)
              ? Effect.void
              : Effect.fail(unowned(operation, parent.executionId, child))
        }))
      )

    const declarationOf = (flowName: string, operation: string) => {
      const flow = declarations.get(flowName)
      return flow === undefined
        ? Effect.fail(notFound(`${operation} does not know the flow ${flowName}.`))
        : Effect.succeed(flow)
    }

    /**
     * Waits for the run row a forked spawn is creating, or for the start
     * attempt to end without one.
     *
     * The fiber is polled BEFORE the row on purpose. A row read that follows a
     * finished start attempt is final — nothing is left to write one — so an
     * absent row at that point means the runtime refused to start the flow and
     * created nothing. Reading in the other order would race a child that
     * settles the instant it starts and report a working child as missing.
     *
     * Every refusal here is `failed`, never `not_found`. `declarationOf` has
     * already proved the flow is one this port was given, so nothing about a
     * start that produced no row says the flow is absent. `not_found` belongs
     * to the one question it answers, "is there such a flow", and a cell that
     * reads it decides never to ask again; spending it on an engine that
     * declined to create a row told the cell to give up on a flow that exists.
     */
    const awaitStarted = (
      child: string,
      flowName: string,
      fiber: Fiber.Fiber<unknown, unknown>,
      remaining: Duration.Duration
    ): Effect.Effect<void, ChildError> =>
      Effect.gen(function*() {
        const ended = yield* Effect.sync(() => fiber.pollUnsafe())
        const row = yield* rowOf(child)
        if (Option.isSome(row)) return
        if (ended !== undefined) {
          if (Exit.isFailure(ended)) {
            return yield* Effect.fail(
              failed(
                `agent/spawn could not start ${flowName}, so the child run ${child} was never created.\n` +
                  boundedCause(ended.cause)
              )
            )
          }
          return yield* Effect.fail(
            failed(
              `agent/spawn could not start ${flowName}: this host's runtime answered without creating ` +
                `the child run ${child}. The flow is declared here, so this is the runtime's refusal ` +
                `to run it rather than a missing flow.`
            )
          )
        }
        if (Duration.isLessThanOrEqualTo(remaining, Duration.zero)) {
          return yield* Effect.fail(
            failed(`The child run ${child} was not created within its start budget.`)
          )
        }
        yield* Effect.sleep(pollInterval)
        return yield* awaitStarted(child, flowName, fiber, Duration.subtract(remaining, pollInterval))
      })

    const spawn: ChildFlows.Children["spawn"] = (input) =>
      Effect.gen(function*() {
        const parent = yield* parentInstance("agent/spawn")
        const flow = yield* declarationOf(input.flow, "agent/spawn")
        const label = input.label ?? input.flow
        const child = childExecutionId(parent.executionId, label)
        // Detached on purpose, and detached in the durable sense: `discard`
        // is what the engine records as the child's `onParentExit` policy, so
        // this child survives its parent's completion instead of being
        // cancelled with it.
        //
        // Forked, because `execute` returns only once the child has settled or
        // parked, and a spawn that waited for that would leave `await` with
        // nothing to do. The fork is not what makes the child durable — the
        // run row is — so the id is only answered once the row exists.
        // Acquire the fiber with an atomic cleanup registration. It belongs
        // to this start attempt until admission succeeds; every failed exit,
        // including defects and interruption, interrupts and joins it.
        yield* Effect.acquireUseRelease(
          Effect.forkDetach(
            // `Flow.Any` erases the payload and result schemas the typed
            // signature reads its requirements from, so the declaration is
            // passed opaquely: this port addresses flows by NAME, and the name
            // is all a cell ever has. What the schemas would have given is
            // checked where it matters — the engine encodes the payload against
            // the real declaration it registered.
            (runtime.execute(flow as never, {
              executionId: child,
              payload: input.input ?? {},
              discard: true
            }) as Effect.Effect<unknown, unknown>).pipe(
              Effect.tapCause((cause) => Effect.logWarning(`agent: detached child ${child} ended abnormally`, cause))
            )
          ),
          (fiber) => awaitStarted(child, input.flow, fiber, startTimeout),
          (fiber, exit) => Exit.isFailure(exit) ? Fiber.interrupt(fiber) : Effect.void
        )
        return { child }
      })

    /** The settled outcome of a child, or nothing while it is still going. */
    const outcomeOf = (
      child: string
    ): Effect.Effect<Option.Option<typeof ChildFlows.AwaitOutput.Type>, ChildError> =>
      Effect.gen(function*() {
        const row = yield* rowOf(child)
        if (Option.isNone(row)) {
          return yield* Effect.fail(notFound(`agent/await knows no child run ${child}.`))
        }
        if (row.value.status === "cancelled") {
          return yield* Effect.fail(failed(`The child run ${child} was cancelled.`))
        }
        const state = yield* Effect.orDie(decodeChildState(row.value.stateJson))
        const flow = yield* declarationOf(state.flowName, "agent/await")
        const result = yield* (Effect.orDie(runtime.poll(flow as never, child)) as Effect.Effect<
          Option.Option<Flow.Result<unknown, unknown>>
        >)
        // Nothing recorded yet: the round has not settled even once.
        if (Option.isNone(result)) return Option.none()
        const settled = result.value
        // A parked round records its suspension on the row, so this is the
        // ordinary "still going" answer for a child waiting on a deferred, a
        // timer, or an approval. Look again.
        if (settled._tag === "Suspended") return Option.none()
        if (settled._tag === "Handoff") {
          // The round continued its lineage under a NEW execution id. This id
          // will never hold a value, and an await that kept polling it would
          // wait forever, so say so instead.
          return yield* Effect.fail(
            failed(`The child run ${child} handed its lineage to ${settled.flow} and holds no value.`)
          )
        }
        if (settled.exit._tag === "Failure") {
          return yield* Effect.fail(
            failed(`The child run ${child} failed.\n${boundedCause(settled.exit.cause)}`)
          )
        }
        return Option.some({ child, output: asText(settled.exit.value) })
      })

    const awaitChild: ChildFlows.Children["await"] = (input) => {
      const attempt: Effect.Effect<typeof ChildFlows.AwaitOutput.Type, ChildError> = Effect.flatMap(
        outcomeOf(input.child),
        Option.match({
          onNone: () => Effect.sleep(pollInterval).pipe(Effect.andThen(Effect.suspend(() => attempt))),
          onSome: Effect.succeed
        })
      )
      const timeout = input.timeoutSeconds === undefined
        ? awaitTimeout
        : Duration.seconds(input.timeoutSeconds)
      return Effect.andThen(
        ownedByCaller("agent/await", input.child),
        Effect.timeoutOrElse(attempt, {
          duration: timeout,
          orElse: () =>
            Effect.fail(
              new ChildError({
                code: "still_running",
                message: `The child run ${input.child} is still running after ${
                  Duration.format(timeout)
                }; await it again to keep waiting.`
              })
            )
        })
      )
    }

    const send: ChildFlows.Children["send"] = (input) =>
      Effect.gen(function*() {
        const parent = yield* parentInstance("agent/send")
        if (!ownsChild(parent.executionId, input.child)) {
          return yield* Effect.fail(unowned("agent/send", parent.executionId, input.child))
        }
        const row = yield* rowOf(input.child)
        if (Option.isNone(row)) {
          return yield* Effect.fail(notFound(`agent/send knows no child run ${input.child}.`))
        }
        // The canonical step key of this call site, not a counter and not a
        // digest of what was said. `Action.idempotencyKey` folds the parent's
        // execution id, the allocation scope, and the scope's replay-ordered
        // ordinal into one string, which is the same identity the engine gives
        // any other internal durable operation: a re-driven round that reaches
        // this send again derives the same key and the control plane admits it
        // once, while the NEXT send in the same scope gets the next ordinal and
        // is delivered as its own message. A counter held in this port's memory
        // could do neither — it restarts at 1 in the process that resumes the
        // parent.
        //
        // The scope is the enclosing dispatch, because the ordinal counter is
        // rebuilt at zero on every drive and only advances when a send's code
        // actually RUNS. A send inside a durable step is skipped on the drive
        // that replays that step's recorded outcome, so a run-global counter
        // handed the ordinal that step's send took to the next live send, and
        // the control plane deduplicated the live message away while `send`
        // still answered `delivered`. Keyed by the dispatch, a replayed step's
        // sends and a later live send number in different scopes and cannot
        // collide, while a re-driven dispatch re-derives its own keys — the
        // engine allocates the same invocation key on every dispatch of a
        // node, replays included.
        //
        // A send with no dispatch around it — one written straight into a flow
        // body — falls back to the run-level scope, which is correct there: a
        // body re-runs from the top on every drive, so its sends re-derive
        // their own ordinals in order. Only a step the engine replays instead
        // of running can skip one, and such a step always has a key.
        const dispatch = yield* Action.CurrentInvocationKey
        const messageId = yield* Action.idempotencyKey(
          "agent/send",
          dispatch === undefined ? undefined : { parentScope: dispatch }
        ).pipe(
          Effect.provideService(FlowRuntime.FlowInstance, parent),
          Effect.provideService(Crypto.Crypto, crypto)
        )
        // The clock is read inside a SEALED step, so the message a re-drive
        // submits is byte-identical to the one the first drive submitted.
        // The control plane fingerprints the whole steer input and answers
        // `Conflict` when a key arrives carrying different material, so a
        // wall-clock reading taken here on every drive made the SECOND
        // submission of one message look like a different message under a
        // used key. Recorded once and replayed, the stamp is still the real
        // instant the send ran; it just stops moving underneath its own
        // identity. The steer itself is deliberately left outside the step:
        // the control plane is the authority on whether this message was
        // already applied, and a sealed steer would replay a recorded
        // `delivered` without ever asking it.
        const stampedAt = yield* Action.make({
          name: "agent/send",
          tier: "sealed",
          idempotencyKey: messageId,
          success: Schema.Number,
          execute: Effect.clockWith((clock) => clock.currentTimeMillis)
        }).pipe(
          Effect.provideService(FlowRuntime.FlowInstance, parent),
          Effect.provideService(FlowRuntime.FlowRuntime, runtime),
          Effect.provideService(Crypto.Crypto, crypto)
        )
        const receipt = yield* control.steer({
          runId: input.child,
          message: {
            messageId,
            runId: input.child,
            body: input.message,
            principal: { id: parent.executionId, kind: "flow", stampedAt },
            createdAt: stampedAt
          },
          idempotencyKey: messageId
        }).pipe(
          Effect.mapError((cause: ControlError) =>
            cause._tag === "/control/RunNotFound"
              ? notFound(`agent/send knows no child run ${input.child}.`)
              : failed(`agent/send could not steer ${input.child}: ${cause._tag}`)
          )
        )
        // The receipt is the answer, not a formality. `Accepted` admitted the
        // message and `AlreadyApplied` recognised the one this same step
        // submitted before, so both mean the child has it exactly once.
        // Everything else means it does NOT, and reporting `delivered` for
        // those hid a real message loss behind a success: a `Conflict` says
        // the key already carries different material, which is a collision no
        // retry can resolve, and a `Terminal` says the child ended before the
        // message could reach it.
        switch (receipt._tag) {
          case "Accepted":
          case "AlreadyApplied":
            return { delivered: true }
          case "Conflict":
            return yield* Effect.fail(
              failed(
                `agent/send could not steer ${input.child}: the message key ${messageId} already carries a ` +
                  `different message (${receipt.message}).`
              )
            )
          case "Terminal":
            return yield* Effect.fail(
              failed(`agent/send could not steer ${input.child}: the child run is ${receipt.status}.`)
            )
          default:
            return yield* Effect.fail(
              failed(`agent/send could not steer ${input.child}: the control plane answered ${receipt._tag}.`)
            )
        }
      })

    return ChildFlows.Children.of({ spawn, send, await: awaitChild })
  })

/**
 * Provides {@link ChildFlows.Children} over this host's durable engine.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = (
  options: Options
): Layer.Layer<
  ChildFlows.Children,
  never,
  Control | Crypto.Crypto | FlowRuntime.FlowRuntime | RunStore.RunStore
> => Layer.effect(ChildFlows.Children)(make(options))
