// Deep reviewed and polished by a human on 2026-08-10.

/**
 * The execution contract flow authoring APIs are written against.
 *
 * `FlowRuntime` is the port: the smallest service a `Flow`, an `Action`, a
 * `DurableDeferred`, or a `DurableClock` needs in order to be executed,
 * polled, suspended, and resumed. `@smthrs/flow` declares it and depends on
 * nothing that implements it; `@smthrs/engine` supplies the implementation,
 * so the dependency runs one way only.
 *
 * Every method here takes a flow whatever its requirement channel says, and
 * demands none of it. The channel is a compile-time statement about which
 * action implementations a body names, and this port is below the place that
 * statement is settled: a runtime resolves each call by the tag the node
 * carries, which is the only thing left of a plan read back out of a journal.
 * `Flow.execute` — written against this port, one level up — is where the
 * requirements are collected, so the erasure is deliberate rather than a hole:
 * a caller reaching the port directly has already been asked, or is replaying a
 * persisted plan and has nothing to be asked about.
 *
 * @since 0.1.0
 */

import * as Context from "effect/Context"
import type * as Crypto from "effect/Crypto"
import type * as Effect from "effect/Effect"
import type * as Exit from "effect/Exit"
import type * as Option from "effect/Option"
import type * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import type * as Action from "../Action/index.ts"
import type { DurableClock } from "../DurableClock.ts"
import type * as DurableDeferred from "../DurableDeferred.ts"
import type * as Flow from "../Flow/index.ts"
import type * as RetryPolicy from "../RetryPolicy.ts"
import type { CancelRequestFailed } from "./CancelRequestFailed.ts"
import type { FlowCycleDetected } from "./FlowCycleDetected.ts"
import type { FlowExecutionNotFound } from "./FlowExecutionNotFound.ts"
import type { FlowInstance } from "./FlowInstance.ts"
import type * as NodeRecord from "./NodeRecord.ts"

/**
 * Result of atomically completing a deferred only while its run is parked.
 *
 * @category models
 * @since 1.0.0
 */
export type DeferredDoneIfWaitingOutcome = "Completed" | "Existing" | "NotWaiting"

/**
 * Service that represents a flow runtime, responsible for registering and
 * executing flows and coordinating actions, durable deferreds,
 * interrupts, resumes, and clocks.
 *
 * @category services
 * @since 0.1.0
 */
export class FlowRuntime extends Context.Service<
  FlowRuntime,
  {
    /** Storage capability advertised by the runtime implementation. Absence is volatile. */
    readonly durability?: "durable" | undefined
    /**
     * Register a flow with the runtime.
     */
    readonly register: <
      Name extends string,
      Payload extends Flow.AnyStructSchema,
      Success extends Schema.Top,
      Error extends Schema.Top,
      R
    >(
      flow: Flow.Flow<Name, Payload, Success, Error, any>,
      execute: (
        payload: Payload["Type"],
        executionId: string
      ) => Effect.Effect<Success["Type"], Error["Type"], R>
    ) => Effect.Effect<
      void,
      never,
      | Scope.Scope
      | Exclude<
        R,
        | FlowRuntime
        | FlowInstance
        | Flow.Execution<Name>
        | Scope.Scope
      >
      | Payload["DecodingServices"]
      | Payload["EncodingServices"]
      | Success["DecodingServices"]
      | Success["EncodingServices"]
      | Error["DecodingServices"]
      | Error["EncodingServices"]
    >

    /**
     * Execute a registered flow.
     */
    readonly execute: <
      Name extends string,
      Payload extends Flow.AnyStructSchema,
      Success extends Schema.Top,
      Error extends Schema.Top,
      const Discard extends boolean = false
    >(
      flow: Flow.Flow<Name, Payload, Success, Error, any>,
      options: {
        readonly executionId: string
        readonly payload: Payload["Type"]
        readonly discard?: Discard | undefined
        readonly suspendedRetryPolicy?:
          | RetryPolicy.RetryPolicy
          | undefined
      }
    ) => Effect.Effect<
      Discard extends true ? string : Success["Type"],
      Error["Type"] | FlowCycleDetected,
      | Payload["EncodingServices"]
      | Success["DecodingServices"]
      | Error["DecodingServices"]
    >

    /**
     * Poll the current status of a registered flow execution.
     *
     * `Option.none` means the execution is known and has not settled;
     * {@link FlowExecutionNotFound} means the runtime has no record of the
     * execution id at all. Folding the two together would leave a caller
     * unable to tell a run still in flight from an id that names nothing.
     */
    readonly poll: <
      Name extends string,
      Payload extends Flow.AnyStructSchema,
      Success extends Schema.Top,
      Error extends Schema.Top
    >(
      flow: Flow.Flow<Name, Payload, Success, Error, any>,
      executionId: string
    ) => Effect.Effect<
      Option.Option<Flow.Result<Success["Type"], Error["Type"]>>,
      FlowExecutionNotFound,
      Success["DecodingServices"] | Error["DecodingServices"]
    >

    /**
     * Requests cancellation of a registered execution while preserving normal
     * cleanup, compensation, and child-flow handling. This is not a pause, and
     * a later `resume` does not undo the cancellation request.
     *
     * A durable runtime records the request before it interrupts anything, and
     * reports {@link CancelRequestFailed} when that record could not be
     * written: the execution is then still running and still cancellable, so
     * the caller must see the failure rather than a false success. An
     * in-memory runtime has nothing to record and never raises it.
     */
    readonly interrupt: (
      flow: Flow.Any,
      executionId: string
    ) => Effect.Effect<void, CancelRequestFailed>

    /**
     * Immediately cancels a registered execution, potentially ignoring
     * compensation finalizers and orphaning child flows. This unsafe operation
     * is intended for forced shutdown, not ordinary cancellation or pausing.
     *
     * It reports {@link CancelRequestFailed} on the same terms as
     * `interrupt`: forcing cancellation without a durable record would leave a
     * run that nothing later re-cancels.
     */
    readonly interruptUnsafe: (
      flow: Flow.Any,
      executionId: string
    ) => Effect.Effect<void, CancelRequestFailed>

    /**
     * Re-drives a registered execution that returned `Suspended`, allowing it
     * to replay durable history and continue after an awaited condition becomes
     * ready. It does not undo `interrupt` and is not a general unpause operation.
     */
    readonly resume: (
      flow: Flow.Any,
      executionId: string
    ) => Effect.Effect<void>

    /**
     * Execute an action from a flow.
     */
    readonly actionExecute: <
      Success extends Schema.Constraint,
      Error extends Schema.Constraint,
      R
    >(
      action: Action.Action<Success, Error, R>,
      attempt: number
    ) => Effect.Effect<
      Flow.Result<Success["Type"], Error["Type"]>,
      never,
      | Success["DecodingServices"]
      | Error["DecodingServices"]
      | R
      | Crypto.Crypto
      | FlowInstance
    >

    /**
     * Try to retrieve the result of an DurableDeferred
     */
    readonly deferredResult: <
      Success extends Schema.Constraint,
      Error extends Schema.Constraint
    >(
      deferred: DurableDeferred.DurableDeferred<Success, Error>
    ) => Effect.Effect<
      Option.Option<Exit.Exit<Success["Type"], Error["Type"]>>,
      never,
      FlowInstance
    >

    /**
     * Records the result of a DurableDeferred and schedules waiting flows to
     * resume. Returning acknowledges delivery; it does not wait for the resumed
     * flow to complete. Use `poll` to observe the flow's eventual result.
     */
    readonly deferredDone: <
      Success extends Schema.Constraint,
      Error extends Schema.Constraint
    >(
      deferred: DurableDeferred.DurableDeferred<Success, Error>,
      options: {
        readonly flowName: string
        readonly executionId: string
        readonly deferredName: string
        readonly exit: Exit.Exit<Success["Type"], Error["Type"]>
      }
    ) => Effect.Effect<
      void,
      never,
      Success["EncodingServices"] | Error["EncodingServices"]
    >

    /**
     * Completes a deferred only when the addressed execution is currently
     * parked on the exact reason and token supplied. The check and the
     * first-writer completion are one runtime mutation, preventing guessed,
     * stale, or already-advanced approval tokens from pre-answering a run.
     */
    readonly deferredDoneIfWaiting: <
      Success extends Schema.Constraint,
      Error extends Schema.Constraint
    >(
      deferred: DurableDeferred.DurableDeferred<Success, Error>,
      options: {
        readonly flowName: string
        readonly executionId: string
        readonly deferredName: string
        readonly reason: string
        readonly token: string
        readonly exit: Exit.Exit<Success["Type"], Error["Type"]>
      }
    ) => Effect.Effect<
      DeferredDoneIfWaitingOutcome,
      never,
      Success["EncodingServices"] | Error["EncodingServices"]
    >

    /**
     * Records what a driven graph is and how its nodes settled.
     *
     * OPTIONAL, and optional in the strong sense: a runtime that keeps no
     * history has nothing to record, and the interpreter skips journal preflight when none does. An engine with a journal implements it by
     * writing the record; an in-memory or test runtime leaves it absent and
     * the walk is unchanged. That is also why it is not `void`-returning
     * bookkeeping bolted onto `actionExecute`: a node is not an action, and
     * three of the four records describe nodes no action ever dispatched.
     *
     * The record carries its own replay-stable `sourceId`. An implementation
     * MUST use it as the record's producer identity rather than minting one,
     * because that is what makes a resumed walk collapse onto the rows the
     * first walk wrote instead of doubling every node.
     */
    readonly recordNode?:
      | ((record: NodeRecord.NodeRecord) => Effect.Effect<void, never, FlowInstance>)
      | undefined

    /**
     * Upper bound on UTF-8 bytes for a node record's persisted journal entry,
     * including the writer's envelope. Used to page a plan before any writes.
     * Must be deterministic for the execution so resume keeps page identities.
     */
    readonly nodeRecordBytes?:
      | ((record: NodeRecord.NodeRecord) => Effect.Effect<number, never, FlowInstance>)
      | undefined

    /**
     * Schedule a wake up for a DurableClock
     */
    readonly scheduleClock: (
      flow: Flow.Any,
      options: {
        readonly executionId: string
        readonly clock: DurableClock
      }
    ) => Effect.Effect<void>
  }
>()("@smthrs/flow/FlowRuntime/FlowRuntime") {}
