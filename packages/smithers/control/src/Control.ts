/**
 * Transport-independent control-plane vtable.
 *
 * @since 0.1.0
 */

import type { NotificationError } from "@smthrs/notifications/NotificationQueue"
import { Context, Effect, Layer, Stream } from "effect"
import type {
  AlreadyResolved,
  ClaimLost,
  CodeDrift,
  ControlError,
  EnvelopeMismatch,
  FlowNotFound,
  InvalidInput,
  LaunchFailed,
  NoMatchingWait,
  PersistenceError,
  PlanDenied,
  PlanDigestMismatch,
  PlanNotFound,
  RunNotFound,
  TransportError,
  Unauthorized,
  Unavailable
} from "./ControlError.ts"
import { Unavailable as UnavailableError } from "./ControlError.ts"
import type {
  ApprovalPayload,
  ControlEvent,
  Envelope,
  FlowId,
  IdempotencyKey,
  ListRequest,
  ListResponse,
  PlanCard,
  Principal,
  Receipt,
  RunId,
  RunInputSchema,
  SignalInputSchema,
  SteerInputSchema,
  WatchFilter
} from "./ControlSchema.ts"

/**
 * Raw input submitted to planning. Decoding is owned by `ControlRuntime`.
 *
 * This local contract accepts `unknown` so the selected flow can decode its
 * own input. `ControlSchema.PlanInputSchema` is the narrower JSON wire
 * contract used by RPC clients.
 *
 * @category models
 * @since 0.1.0
 */
export interface PlanInput {
  readonly flowId: FlowId
  readonly input: unknown
  readonly idempotencyKey?: IdempotencyKey | undefined
  /** Budget fields that replace the flow's declared ones on this plan's envelope. */
  readonly budget?: Envelope["budget"] | undefined
}

/**
 * Starts an approved plan or joins/resumes an existing run.
 *
 * @category models
 * @since 0.1.0
 */
export type RunInput = typeof RunInputSchema.Type & {
  /** Authenticated actor used only to scope durable idempotency. */
  readonly principal?: Principal | undefined
}

/**
 * @category models
 * @since 0.1.0
 */
export type { ApprovalTarget } from "./ControlSchema.ts"

/**
 * Full approval decision submitted to the authenticated server boundary.
 *
 * The local service may receive a runtime-stamped principal.
 * `ControlSchema.ApprovalInputSchema` excludes it from the wire so a remote
 * client cannot claim another identity.
 *
 * @category models
 * @since 0.1.0
 */
export interface ApprovalInput extends ApprovalPayload {
  readonly principal?: Principal | undefined
}

/**
 * Steering mutation arguments.
 *
 * @category models
 * @since 0.1.0
 */
export type SteerInput = typeof SteerInputSchema.Type

/**
 * Signal mutation arguments.
 *
 * @category models
 * @since 0.1.0
 */
export type SignalInput = typeof SignalInputSchema.Type & {
  /** Authenticated actor used only to scope durable idempotency. */
  readonly principal?: Principal | undefined
}

/**
 * Run lifecycle mutation arguments.
 *
 * The local contract includes the runtime-stamped principal.
 * `ControlSchema.ReasonedMutationInputSchema` carries only the caller's reason
 * over RPC.
 *
 * @category models
 * @since 0.1.0
 */
export interface RunMutationInput {
  readonly runId: RunId
  readonly idempotencyKey: IdempotencyKey
  /**
   * Why the run is being cancelled or resumed.
   *
   * Free text, recorded on the journal entry the mutation writes and projected
   * back onto `RunSummary.cancellation`. An operator reading a cancelled run a
   * week later asks "why", and a control plane that never carried the answer
   * cannot produce one afterwards.
   */
  readonly reason?: string | undefined
  /**
   * Who is asking. Stamped by the runtime, which supplies its own principal
   * when the caller names none.
   */
  readonly principal?: Principal | undefined
  /**
   * Resume only: run the flow's current code even when its execution digest
   * differs from the one the run started with. Without it such a resume fails
   * `CodeDrift` and leaves the run where it was.
   */
  readonly allowCodeDrift?: boolean | undefined
}

/**
 * Transport-independent control operations.
 *
 * Every operation admits transport and authentication failures so the same
 * service key can be provided by either a local implementation or an RPC client.
 *
 * @category models
 * @since 0.1.0
 */
export interface Service {
  readonly plan: (
    input: PlanInput
  ) => Effect.Effect<
    PlanCard,
    FlowNotFound | InvalidInput | PersistenceError | Unavailable | TransportError | Unauthorized
  >
  readonly run: (
    input: RunInput
  ) => Effect.Effect<
    Receipt,
    | RunNotFound
    | PlanNotFound
    | PlanDenied
    | PlanDigestMismatch
    | EnvelopeMismatch
    | ClaimLost
    | CodeDrift
    | InvalidInput
    | LaunchFailed
    | PersistenceError
    | Unavailable
    | TransportError
    | Unauthorized
  >
  readonly approve: (
    input: ApprovalInput
  ) => Effect.Effect<
    Receipt,
    | PlanDigestMismatch
    | EnvelopeMismatch
    | AlreadyResolved
    | PlanNotFound
    | RunNotFound
    | CodeDrift
    | InvalidInput
    | Unauthorized
    | PersistenceError
    | Unavailable
    | TransportError
  >
  readonly deny: (
    input: ApprovalInput
  ) => Effect.Effect<
    Receipt,
    | PlanDigestMismatch
    | EnvelopeMismatch
    | AlreadyResolved
    | PlanNotFound
    | RunNotFound
    | CodeDrift
    | InvalidInput
    | Unauthorized
    | PersistenceError
    | Unavailable
    | TransportError
  >
  readonly steer: (
    input: SteerInput
  ) => Effect.Effect<
    Receipt,
    RunNotFound | InvalidInput | PersistenceError | Unavailable | TransportError | Unauthorized | NotificationError
  >
  readonly signal: (
    input: SignalInput
  ) => Effect.Effect<
    Receipt,
    RunNotFound | NoMatchingWait | InvalidInput | PersistenceError | Unavailable | TransportError | Unauthorized
  >
  readonly cancel: (
    input: RunMutationInput
  ) => Effect.Effect<
    Receipt,
    RunNotFound | ClaimLost | InvalidInput | PersistenceError | Unavailable | TransportError | Unauthorized
  >
  readonly resume: (
    input: RunMutationInput
  ) => Effect.Effect<
    Receipt,
    RunNotFound | ClaimLost | CodeDrift | InvalidInput | PersistenceError | Unavailable | TransportError | Unauthorized
  >
  readonly list: (input: ListRequest) => Effect.Effect<ListResponse, ControlError>
  /** Checkpoint `event.cursor` after processing each event and resume with `afterCursor`. */
  readonly watch: (filter: WatchFilter) => Stream.Stream<ControlEvent, ControlError>
}

/**
 * Service key for the authoritative control-plane vtable.
 *
 * @category services
 * @since 0.1.0
 */
export class Control extends Context.Service<Control, Service>()("/control/Control") {}

/**
 * Constructs a control service from an implementation record.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (implementation: Service): Service => Control.of(implementation)

const unavailable = (feature: string): Unavailable =>
  new UnavailableError({ feature, ticket: "control-runtime-engine-integration" })

/**
 * Provides an unavailable control implementation for optional integrations.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerNoop: Layer.Layer<Control> = Layer.succeed(
  Control,
  make({
    plan: Effect.fn("Control.plan")(() => Effect.fail(unavailable("plan"))),
    run: Effect.fn("Control.run")(() => Effect.fail(unavailable("run"))),
    approve: Effect.fn("Control.approve")(() => Effect.fail(unavailable("approve"))),
    deny: Effect.fn("Control.deny")(() => Effect.fail(unavailable("deny"))),
    steer: Effect.fn("Control.steer")(() => Effect.fail(unavailable("steer"))),
    signal: Effect.fn("Control.signal")(() => Effect.fail(unavailable("signal"))),
    cancel: Effect.fn("Control.cancel")(() => Effect.fail(unavailable("cancel"))),
    resume: Effect.fn("Control.resume")(() => Effect.fail(unavailable("resume"))),
    list: Effect.fn("Control.list")(() => Effect.fail(unavailable("list"))),
    watch: () => Stream.fail(unavailable("watch"))
  })
)
