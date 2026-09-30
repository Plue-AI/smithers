/**
 * The low-level engine contract a durable store implements. `makeUnsafe`
 * adapts it into the typed `FlowRuntime` port that `@smthrs/flow` declares;
 * stores implement this interface, never the typed port directly.
 *
 * The name is narrower than it looks: only SOME members carry encoded values,
 * and an implementation that encodes the decoded ones produces a silently
 * wrong system, because those members are typed `Flow.Result<unknown, unknown>`
 * and nothing decodes them on the way out.
 *
 * - `actionExecute` and `deferredResult` return ENCODED values, which
 *   `makeUnsafe` decodes through the action's `exitSchemaPartial` and the
 *   deferred's `exitSchema`.
 * - `deferredDone` and `deferredDoneIfWaiting` receive ENCODED exits, which
 *   `makeUnsafe` encodes before the call.
 * - `execute` and `poll` return DECODED results. The implementation decodes
 *   them itself, through
 *   `Flow.Result({ success: flow.successSchema, error: flow.errorSchema })`.
 * - Every other member, optional ones included, carries no flow-declared
 *   payload at all.
 *
 * `docs/reference/engine.md` tabulates every member with its optionality.
 *
 * @since 0.1.0
 */

import type { Action, DurableClock, DurableDeferred, Flow, FlowRuntime } from "@smthrs/flow"
import type * as Crypto from "effect/Crypto"
import type * as Effect from "effect/Effect"
import type * as Exit from "effect/Exit"
import type * as Option from "effect/Option"
import type * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import type * as Round from "./Round.ts"

/**
 * The identity and boundary information supplied to an encoded action
 * executor.
 *
 * @category models
 * @since 0.1.0
 */
export interface ActionExecuteOptions {
  readonly action: Action.Any
  readonly attempt: number
  readonly key: string
  readonly tier: Action.Tier
  /** Allows a cache put race to retain the first row without failing this run. */
  readonly nondeterministic?: true | undefined
  readonly metadata: unknown
  /**
   * Prepares a compensable attempt that will actually execute. Only supplied
   * when the driver implements `actionSnapshot`. After checking the journal,
   * run this effect once and durably record its handle with the attempt BEFORE
   * executing the action. Never evaluate it for a journal hit or a joined
   * dispatch. The engine diffs only attempts that evaluated this effect.
   */
  readonly snapshot?: Effect.Effect<unknown, never, FlowRuntime.FlowInstance | Crypto.Crypto> | undefined
}

/**
 * The low-level flow engine contract a durable store implements, over which
 * `makeUnsafe` builds the typed `FlowRuntime` port.
 *
 * Only `actionExecute`, `deferredResult`, `deferredDone`, and
 * `deferredDoneIfWaiting` carry encoded values. `execute` and `poll` return
 * decoded results the implementation produced itself; the rest carry no
 * flow-declared payload. See the module header for the whole split.
 *
 * @category models
 * @since 0.1.0
 */
export interface Encoded {
  readonly register: (
    flow: Flow.Any,
    execute: (
      payload: object,
      executionId: string
    ) => Effect.Effect<unknown, unknown, FlowRuntime.FlowInstance | FlowRuntime.FlowRuntime>
  ) => Effect.Effect<void, never, Scope.Scope>
  /**
   * Starts, or joins, one execution of `flow` and answers with its settlement.
   *
   * Returns a DECODED `Flow.Result`: the implementation decodes it through
   * `Flow.Result({ success: flow.successSchema, error: flow.errorSchema })`,
   * because `makeUnsafe` passes this member straight through.
   *
   * `executionId` is caller-supplied identity. A repeated id joins the run
   * that already owns it, which is what makes a retried submission
   * idempotent; an implementation refuses a reuse that names a different flow
   * declaration or arrives with a different payload, rather than answering
   * one caller with another's result.
   */
  readonly execute: <const Discard extends boolean>(
    flow: Flow.Any,
    options: {
      readonly executionId: string
      readonly payload: object
      readonly discard: Discard
      readonly parent?: FlowRuntime.FlowInstance["Service"] | undefined
      /**
       * The execution's trampoline position. `makeUnsafe` supplies it on every
       * call: round zero for a fresh execution, and the advanced round after a
       * handoff. Later rounds name the preceding execution so durable stores
       * can verify the continue-as-new chain.
       */
      readonly round: Round.Round & {
        readonly previousExecutionId?: string | undefined
      }
      /**
       * Follows a round scheduled by admission, handoff, wake, or an elapsed
       * poll's `resume`. The implementation must still admit or verify the
       * round, including on this caller's first dispatch after a handoff.
       * Durable adapters schedule an undriven pending round, then join its
       * drive; they do not replay an idle suspended round. Memory adapters
       * admit missing rounds and join their fibers. Absent, `execute` drives
       * as before.
       */
      readonly follow?: boolean | undefined
    }
  ) => Effect.Effect<
    Discard extends true ? void : Flow.Result<unknown, unknown>,
    FlowRuntime.FlowCycleDetected
  >
  /**
   * The settlement of one execution of `flow`, when it has one.
   *
   * Returns a DECODED `Flow.Result` for the same reason `execute` does.
   *
   * `Option.none` is a known, unsettled execution, and also an execution that
   * belongs to a DIFFERENT flow declaration: from this flow's view that run
   * has no result, and answering with it would hand one flow's value to
   * another flow's schemas. An execution id no engine knows fails with
   * `FlowRuntime.FlowExecutionNotFound`.
   */
  readonly poll: (
    flow: Flow.Any,
    executionId: string
  ) => Effect.Effect<
    Option.Option<Flow.Result<unknown, unknown>>,
    FlowRuntime.FlowExecutionNotFound
  >
  /**
   * Requests cancellation with normal cleanup and compensation semantics.
   * This is not a pause operation.
   * The execution ID may name any trampoline round: cancel its logical lineage
   * and linked child lineages, including successors admitted during a race.
   * Returning acknowledges intent, not completed cleanup. Preserve terminal
   * predecessor results and keep fork ancestry separate from child ownership.
   *
   * Reports `FlowRuntime.CancelRequestFailed` when a durable implementation
   * could not record the request; an in-memory one never raises it.
   *
   * An unknown execution id is a silent no-op rather than a typed failure,
   * unlike `poll`: the request is idempotent, and a mistyped or reaped run has
   * nothing left to cancel.
   */
  readonly interrupt: (
    flow: Flow.Any,
    executionId: string
  ) => Effect.Effect<void, FlowRuntime.CancelRequestFailed>
  /**
   * Forces cancellation without guaranteeing cleanup or compensation.
   *
   * An unknown execution id is a silent no-op, for the same reason
   * `interrupt` treats one that way.
   */
  readonly interruptUnsafe: (
    flow: Flow.Any,
    executionId: string
  ) => Effect.Effect<void, FlowRuntime.CancelRequestFailed>
  /**
   * Re-drives a durably suspended execution; it does not undo cancellation.
   *
   * An unknown execution id is a silent no-op: a re-drive request carries no
   * state of its own, so there is nothing to report to a caller that named a
   * run this engine does not hold.
   * `poll` marks an automatic follower retry, without operator authority to
   * clear a quarantine park. `delegated` marks a background control
   * delegation: it schedules the wake without operator authority, and a
   * quarantine park refuses it in the same transaction that reads the park.
   * Omitted, this is an explicit recovery request.
   */
  readonly resume: (
    flow: Flow.Any,
    executionId: string,
    options?: FlowRuntime.ResumeOptions & { readonly poll?: boolean | undefined } | undefined
  ) => Effect.Effect<void>
  readonly resumeSignal?:
    | ((
      flow: Flow.Any,
      executionId: string
    ) => Effect.Effect<void>)
    | undefined
  /**
   * Resolve a fork's copied attempt identity before retry and dispatch lookup.
   * The engine supplies its canonical derivation; persistence selects an
   * ancestor only when the child's own history contains that attempt.
   * Fresh fork work uses run-scoped keys so a parent's future cache cannot
   * answer it. Ordinary runs retain their declared cache environment.
   */
  readonly actionReplayKey?:
    | ((
      derive: (
        executionId: string,
        runScoped: boolean
      ) => Effect.Effect<string, Schema.SchemaError, Crypto.Crypto>
    ) => Effect.Effect<string, Schema.SchemaError, FlowRuntime.FlowInstance | Crypto.Crypto>)
    | undefined
  readonly actionExecute: (
    options: ActionExecuteOptions
  ) => Effect.Effect<
    Flow.Result<unknown, unknown>,
    never,
    FlowRuntime.FlowInstance | Crypto.Crypto
  >
  /**
   * The durable wall-clock origin of an action's retry sequence: the
   * persisted start time of the first attempt for `key`, when one exists.
   *
   * Durable drivers implement it so a `RetryPolicy.expirationMs`
   * (schedule-to-close) bound survives park/resume and process death
   * (issue #45); when absent the engine falls back to an in-process origin.
   *
   * `Option.none()` means no attempt row for `key` survives at all (for
   * example a retention job pruned every attempt). The engine then falls
   * back to the current clock — restarting the budget rather than failing
   * the run, because turning benign retention pruning into spurious
   * failures is worse than granting a fresh window — and logs a warning so
   * the restarted budget is observable (issue #69). Drivers are expected to
   * keep `Option.some` as long as any attempt row survives, using the
   * earliest surviving row when attempt 1 itself was pruned.
   */
  readonly actionRetryOrigin?:
    | ((options: {
      readonly key: string
    }) => Effect.Effect<Option.Option<number>, never, FlowRuntime.FlowInstance | Crypto.Crypto>)
    | undefined
  /**
   * The highest persisted attempt number for `key`, when attempts survive.
   *
   * Durable drivers implement it so the attempt counter resumes from the
   * persisted sequence after process death (issue #59): a replayed failed
   * attempt keeps its original attempt number, the backoff ladder is not
   * re-slept from attempt 1, and a persisted `nonRetryable` failure is
   * decided against the original attempt instead of re-dispatching.
   */
  readonly actionLatestAttempt?:
    | ((options: {
      readonly key: string
    }) => Effect.Effect<Option.Option<number>, never, FlowRuntime.FlowInstance | Crypto.Crypto>)
    | undefined
  /**
   * The pre-attempt snapshot of the earliest recorded compensable attempt for
   * this key. `Option.none()` means no handle survives. Preserve the first
   * handle for the lifetime of the retry sequence, including unfinished
   * attempts; an opaque handle may itself be null or undefined.
   *
   * Implementing this hook opts into `ActionExecuteOptions.snapshot`: the
   * driver must evaluate and persist that effect only for actual execution,
   * after journal lookup and before the action can mutate the world. Handles
   * must remain usable by the host boundary across process restarts. Without
   * this hook, snapshot/restore remains process-local and surrounds replay too.
   */
  readonly actionSnapshot?:
    | ((options: {
      readonly key: string
    }) => Effect.Effect<Option.Option<unknown>, never, FlowRuntime.FlowInstance | Crypto.Crypto>)
    | undefined
  readonly deferredResult: (
    deferred: DurableDeferred.Any
  ) => Effect.Effect<
    Option.Option<Exit.Exit<unknown, unknown>>,
    never,
    FlowRuntime.FlowInstance
  >
  readonly deferredDone: (options: {
    readonly flowName: string
    readonly executionId: string
    readonly deferredName: string
    readonly exit: Exit.Exit<unknown, unknown>
  }) => Effect.Effect<void>
  readonly deferredDoneIfWaiting?:
    | ((options: {
      readonly flowName: string
      readonly executionId: string
      readonly deferredName: string
      readonly reason: string
      readonly token: string
      readonly exit: Exit.Exit<unknown, unknown>
    }) => Effect.Effect<FlowRuntime.DeferredDoneIfWaitingOutcome>)
    | undefined
  readonly scheduleClock: (
    flow: Flow.Any,
    options: {
      readonly executionId: string
      readonly clock: DurableClock.DurableClock
    }
  ) => Effect.Effect<void>
  /**
   * Records what a driven graph is and how its nodes settled.
   *
   * Optional, and `makeUnsafe` forwards it only when a store supplies one, so
   * the typed port stays absent on a store that keeps no history and the
   * interpreter's walk is unchanged. A store that supplies one MUST address
   * the record by the `sourceId` the record carries rather than minting its
   * own: a resumed walk re-derives the same ids, and that is what makes the
   * journal hold one row per node across a resume instead of one per
   * observation.
   */
  readonly recordNode?:
    | ((record: FlowRuntime.NodeRecord) => Effect.Effect<void, never, FlowRuntime.FlowInstance>)
    | undefined
  /** Deterministic UTF-8 upper bound including the store's journal envelope. */
  readonly nodeRecordBytes?:
    | ((record: FlowRuntime.NodeRecord) => Effect.Effect<number, never, FlowRuntime.FlowInstance>)
    | undefined
}
