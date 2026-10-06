/**
 * Versioned JSON boundary between the Go product backend and the canonical
 * TypeScript Flow/Control host.
 *
 * This module adapts HTTP-shaped commands to `Control`. It owns no graph,
 * scheduler, journal, or lifecycle state of its own.
 *
 * @since 1.0.0
 */

import { Control } from "@smthrs/control/Control"
import * as ControlError from "@smthrs/control/ControlError"
import type { Principal, WatchCursor } from "@smthrs/control/ControlSchema"
import {
  ApprovalPayload,
  ControlEvent,
  MessageSteer,
  Receipt,
  RunSummary,
  SignalPayload
} from "@smthrs/control/ControlSchema"
import * as Fault from "@smthrs/flow/Fault"
import { Effect, Layer, Schema, Stream } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { RunSummaryRow } from "./GatewayProjection.ts"
import * as Projections from "./Projections.ts"

/**
 * The only protocol version accepted by this host.
 * @since 1.0.0
 * @category constants
 */
export const protocol = "smithers.flow-runtime/v1" as const

const Sha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))
const SourceRevision = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/))
const PositiveSafeInteger = Schema.Int.check(
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)
)
const RequestId = Schema.NonEmptyString.check(Schema.isMaxLength(1024))
// A decimal consumes a whole journal entry. v1 preserves an expansion offset;
// the empty seed consumes nothing, including sequence zero.
const observationCursorPattern = /^(?:(0|[1-9][0-9]*)|v1:(0|[1-9][0-9]*):(0|[1-9][0-9]*))?(?![\s\S])/

/**
 * Non-secret identity published by readiness for startup compatibility.
 * @since 1.0.0
 * @category models
 */
export const Identity = Schema.Struct({
  protocol: Schema.Literal(protocol),
  runtimeArtifactDigest: Sha256,
  sourceRevision: SourceRevision,
  ownerGeneration: PositiveSafeInteger
})

/**
 * Non-secret identity published by readiness for startup compatibility.
 * @since 1.0.0
 * @category models
 */
export type Identity = typeof Identity.Type
const common = {
  protocol: Schema.Literal(protocol),
  applicationRequestId: RequestId,
  ownerGeneration: PositiveSafeInteger
}

// The version a launch must run: a flow, the source commit it was chosen
// from and that flow's execution digest. A pinned launch runs only a plan
// with that exact identity.
const LaunchPin = Schema.Struct({
  flow: Schema.NonEmptyString,
  sourceCommit: SourceRevision,
  executionDigest: Sha256
})

/**
 * Launches one immutable named flow. Planning and running stay in Control.
 * @since 1.0.0
 * @category models
 */
export const LaunchCommand = Schema.Struct({
  ...common,
  operation: Schema.Literal("launch"),
  attempt: PositiveSafeInteger,
  runtimeArtifactDigest: Sha256,
  sourceRevision: SourceRevision,
  flowId: Schema.NonEmptyString,
  payload: Schema.Json,
  pin: Schema.optional(LaunchPin)
})

/**
 * Submits an approval or denial payload produced by the same Control host.
 * @since 1.0.0
 * @category models
 */
export const DecisionCommand = Schema.Struct({
  ...common,
  operation: Schema.Literals(["approve", "deny"]),
  approval: ApprovalPayload
})

/**
 * Delivers one durable named signal.
 * @since 1.0.0
 * @category models
 */
export const SignalCommand = Schema.Struct({
  ...common,
  operation: Schema.Literal("signal"),
  runId: Schema.NonEmptyString,
  signal: SignalPayload
})

const Steer = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("Message"), body: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("Seat"), seat: Schema.NonEmptyString }),
  Schema.Struct({
    kind: Schema.Literal("Thinking"),
    thinking: Schema.Literals(["none", "minimal", "low", "medium", "high", "xhigh"])
  }),
  Schema.Struct({ kind: Schema.Literal("Tools"), toolNames: Schema.NonEmptyArray(Schema.NonEmptyString) })
])

/**
 * Enqueues one steer for the runtime's next turn boundary.
 * @since 1.0.0
 * @category models
 */
export const SteerCommand = Schema.Struct({
  ...common,
  operation: Schema.Literal("steer"),
  runId: Schema.NonEmptyString,
  messageId: Schema.NonEmptyString,
  createdAt: Schema.Number,
  attribution: MessageSteer.fields.attribution,
  steer: Steer
})

/**
 * Requests cancellation or explicit resume.
 * @since 1.0.0
 * @category models
 */
export const LifecycleCommand = Schema.Struct({
  ...common,
  operation: Schema.Literals(["cancel", "resume"]),
  runId: Schema.NonEmptyString,
  reason: Schema.optional(Schema.String)
})

/**
 * Every mutating operation accepted by the bridge.
 * @since 1.0.0
 * @category models
 */
export const Command = Schema.Union([
  LaunchCommand,
  DecisionCommand,
  SignalCommand,
  SteerCommand,
  LifecycleCommand
])

/**
 * Every mutating operation accepted by the bridge.
 * @since 1.0.0
 * @category models
 */
export type Command = typeof Command.Type

/**
 * A bounded, reconnectable read of one canonical runtime execution.
 * @since 1.0.0
 * @category models
 */
export const ObserveRequest = Schema.Struct({
  protocol: Schema.Literal(protocol),
  runId: Schema.NonEmptyString,
  afterCursor: Schema.optional(Schema.String.check(Schema.isPattern(observationCursorPattern))),
  limit: Schema.optional(PositiveSafeInteger)
})

/**
 * A bounded, reconnectable read of one canonical runtime execution.
 * @since 1.0.0
 * @category models
 */
export type ObserveRequest = typeof ObserveRequest.Type

/**
 * Host identity fixed for the lifetime of one owning process.
 * @since 1.0.0
 * @category models
 */
export interface Config {
  readonly runtimeArtifactDigest: string
  readonly sourceRevision: string
  /** Captured and verified by native catalog registration, never decoded from a request or environment. */
  readonly verifiedCatalogSourceRevision?: string | undefined
  readonly ownerGeneration: number
  readonly authenticate: (
    headers: Readonly<Record<string, string>>
  ) => Effect.Effect<Principal, ControlError.Unauthorized>
}

/**
 * Stable bridge-only failures. Control failures retain their own code.
 * @since 1.0.0
 * @category errors
 */
export class BridgeError extends Schema.TaggedError<BridgeError>()("@smthrs/gateway/RuntimeBridgeError", {
  code: Schema.Literals([
    "invalid_request",
    "artifact_mismatch",
    "source_mismatch",
    "stale_owner",
    "run_not_found",
    "internal"
  ]),
  message: Schema.String,
  retryable: Schema.Boolean
}) {}

const decodeCommand = Schema.decodeUnknownEffect(Command)
const decodeObserve = Schema.decodeUnknownEffect(ObserveRequest)
const terminal = new Set(["completed", "failed", "cancelled"])
const retryableCodes = new Set(["transport_error", "unavailable", "persistence_failed", "launch_failed"])
const notFoundCodes = new Set(["run_not_found", "flow_not_found", "plan_not_found"])
const conflictCodes = new Set(["stale_owner", "artifact_mismatch", "source_mismatch", "conflict"])
const defaultEventLimit = 250
const maximumEventLimit = 1_000

// Host generation fences who may execute a delivery, but it is not part of
// the durable product request identity. A replacement owner must reconcile a
// lost acknowledgement against the same Control command keys.
const idempotencyKey = (input: Pick<Command, "applicationRequestId">, suffix: string) =>
  `bridge:v1:${input.applicationRequestId}:${suffix}`

const validateOwner = (config: Config, input: Pick<Command, "ownerGeneration">) =>
  input.ownerGeneration === config.ownerGeneration
    ? Effect.void
    : Effect.fail(
      new BridgeError({ code: "stale_owner", message: "Runtime owner generation is stale", retryable: true })
    )

/**
 * Executes one decoded command exclusively through the canonical Control API.
 * @since 1.0.0
 * @category constructors
 */
export const execute = (
  config: Config,
  control: Control["Service"],
  principal: Principal,
  input: Command
) =>
  Effect.gen(function*() {
    yield* validateOwner(config, input)
    switch (input.operation) {
      case "launch": {
        if (input.runtimeArtifactDigest !== config.runtimeArtifactDigest) {
          return yield* Effect.fail(
            new BridgeError({
              code: "artifact_mismatch",
              message: "Runtime artifact digest does not match the owning host",
              retryable: false
            })
          )
        }
        if (input.sourceRevision !== config.sourceRevision) {
          return yield* Effect.fail(
            new BridgeError({
              code: "source_mismatch",
              message: "Flow source revision does not match the owning host",
              retryable: false
            })
          )
        }
        // Every launch of a pinned attempt (its composition and the engine's
        // launches) runs from the pinned source commit: a host serving any
        // other source refuses before planning imports anything.
        if (input.pin !== undefined && input.pin.sourceCommit !== config.sourceRevision) {
          return yield* Effect.fail(
            new BridgeError({
              code: "source_mismatch",
              message: "Flow source revision does not match the pinned launch",
              retryable: false
            })
          )
        }
        const plan = yield* control.plan({
          flowId: input.flowId,
          input: input.payload,
          idempotencyKey: idempotencyKey(input, "plan")
        })
        // Graphs are optional for valid Flow declarations. Only a verified
        // native catalog snapshot can supply the missing provenance; the
        // configured/wire identity by itself cannot stand in for that proof.
        const plannedSource = plan.graph?.sourceRevision ?? config.verifiedCatalogSourceRevision
        if (plannedSource !== input.sourceRevision) {
          return yield* Effect.fail(
            new BridgeError({
              code: "source_mismatch",
              message: "Flow source revision does not match the immutable request",
              retryable: false
            })
          )
        }
        // A pinned launch runs nothing but its pin: a plan with no execution
        // identity, or the pinned flow planned as other code, never starts.
        if (
          input.pin !== undefined &&
          (plan.executionDigest === undefined ||
            (input.pin.flow === input.flowId && plan.executionDigest !== input.pin.executionDigest))
        ) {
          return yield* Effect.fail(
            new BridgeError({
              code: "source_mismatch",
              message: "Flow execution digest does not match the pinned launch",
              retryable: false
            })
          )
        }
        const receipt = yield* control.run({
          _tag: "Plan",
          planId: plan.planId,
          digest: plan.digest,
          envelope: plan.envelope,
          idempotencyKey: idempotencyKey(input, `run:${input.attempt}`),
          principal
        })
        return {
          operation: input.operation,
          applicationRequestId: input.applicationRequestId,
          ownerGeneration: input.ownerGeneration,
          runtimeArtifactDigest: config.runtimeArtifactDigest,
          sourceRevision: input.sourceRevision,
          planId: plan.planId,
          planDigest: plan.digest,
          ...(plan.executionDigest === undefined ? {} : { executionDigest: plan.executionDigest }),
          envelope: plan.envelope,
          approval: plan.approval,
          receipt
        } as const
      }
      case "approve":
      case "deny": {
        const request = {
          ...input.approval,
          idempotencyKey: idempotencyKey(input, input.operation),
          principal
        }
        const receipt = yield* input.operation === "approve" ? control.approve(request) : control.deny(request)
        return { operation: input.operation, applicationRequestId: input.applicationRequestId, receipt } as const
      }
      case "signal": {
        const receipt = yield* control.signal({
          runId: input.runId,
          signal: input.signal,
          idempotencyKey: idempotencyKey(input, "signal"),
          principal
        })
        return { operation: input.operation, applicationRequestId: input.applicationRequestId, receipt } as const
      }
      case "steer": {
        const receipt = yield* control.steer({
          runId: input.runId,
          idempotencyKey: idempotencyKey(input, "steer"),
          message: {
            ...input.steer,
            runId: input.runId,
            messageId: input.messageId,
            createdAt: input.createdAt,
            ...(input.attribution === undefined ? {} : { attribution: input.attribution }),
            principal
          }
        })
        return { operation: input.operation, applicationRequestId: input.applicationRequestId, receipt } as const
      }
      case "cancel":
      case "resume": {
        const request = {
          runId: input.runId,
          idempotencyKey: idempotencyKey(input, input.operation),
          ...(input.reason === undefined ? {} : { reason: input.reason }),
          principal
        }
        const receipt = yield* input.operation === "cancel" ? control.cancel(request) : control.resume(request)
        return { operation: input.operation, applicationRequestId: input.applicationRequestId, receipt } as const
      }
    }
  })

const cursorPosition = (cursor: string | undefined): Effect.Effect<WatchCursor | undefined, BridgeError> => {
  if (cursor === undefined || cursor === "") return Effect.succeed(undefined)
  const match = observationCursorPattern.exec(cursor)
  const sequence = Number(match?.[1] ?? match?.[2])
  const offset = match?.[3] === undefined ? undefined : Number(match[3])
  const valid = (value: number) => Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER
  return match !== null && valid(sequence) && (offset === undefined || valid(offset))
    ? Effect.succeed({ sequence, ...(offset === undefined ? {} : { offset }) })
    : Effect.fail(
      new BridgeError({
        code: "invalid_request",
        message: "Observation cursor is invalid or out of range",
        retryable: false
      })
    )
}

const encodedCursor = (cursor: WatchCursor): string =>
  cursor.offset === undefined ? String(cursor.sequence) : `v1:${cursor.sequence}:${cursor.offset}`

/**
 * Reads a bounded event replay and current canonical run projection.
 * @since 1.0.0
 * @category constructors
 */
export const observe = (control: Control["Service"], input: ObserveRequest) =>
  Effect.gen(function*() {
    const after = yield* cursorPosition(input.afterCursor)
    const limit = Math.min(input.limit ?? defaultEventLimit, maximumEventLimit)
    const listed = yield* control.list({ _tag: "runs", filters: { runId: input.runId }, limit: 1 })
    const summary = listed._tag === "runs" ? listed.items[0] : undefined
    if (summary === undefined) {
      return yield* Effect.fail(
        new BridgeError({ code: "run_not_found", message: "Runtime execution was not found", retryable: true })
      )
    }
    const events = Array.from(
      yield* Stream.runCollect(Stream.take(
        control.watch({
          runId: input.runId,
          ...(after === undefined
            ? {}
            : after.offset === undefined
            ? { afterSequence: after.sequence }
            : { afterCursor: after }),
          follow: false
        }),
        limit + 1
      ))
    )
    const page = events.slice(0, limit)
    const last = page.at(-1)
    // Typed Flow results use the same committed root projection as the app.
    // A terminal status alone never supplies a result, and a bounded event
    // page cannot reconstruct a root result that precedes its cursor.
    let finalOutput: string | undefined
    let failure: { readonly failureFault?: Fault.Class; readonly failureTag?: string } = {}
    if (terminal.has(summary.status)) {
      const projections = yield* Projections.make(control)
      const snapshot = yield* projections.snapshot({ _tag: "run-summary", runId: input.runId })
      const row = snapshot.rows.find(Schema.is(RunSummaryRow))
      if (
        row === undefined || row.runId !== summary.runId || row.flowId !== summary.flowId ||
        row.status !== summary.status || row.planId !== summary.planId || row.planDigest !== summary.planDigest
      ) {
        return yield* Effect.fail(
          new BridgeError({ code: "internal", message: "Terminal result observation changed", retryable: true })
        )
      }
      finalOutput = row.finalOutput
      failure = {
        ...(row.failureFault === undefined ? {} : { failureFault: row.failureFault }),
        ...(row.failureTag === undefined ? {} : { failureTag: row.failureTag })
      }
    }
    return {
      run: { ...summary, ...(finalOutput === undefined ? {} : { finalOutput }), ...failure },
      events: page,
      nextCursor: last === undefined
        ? input.afterCursor ?? ""
        : encodedCursor(last.cursor ?? { sequence: last.sequence }),
      hasMore: events.length > limit,
      terminal: terminal.has(summary.status)
    }
  })

/**
 * Successful command response on the JSON wire.
 * @since 1.0.0
 * @category models
 */
export const CommandResponse = Schema.Struct({
  protocol: Schema.Literal(protocol),
  ok: Schema.Literal(true),
  value: Schema.Struct({
    operation: Schema.String,
    applicationRequestId: Schema.String,
    ownerGeneration: Schema.optional(PositiveSafeInteger),
    runtimeArtifactDigest: Schema.optional(Sha256),
    sourceRevision: Schema.optional(SourceRevision),
    planId: Schema.optional(Schema.String),
    planDigest: Schema.optional(Sha256),
    executionDigest: Schema.optional(Sha256),
    envelope: Schema.optional(Schema.Json),
    approval: Schema.optional(ApprovalPayload),
    receipt: Receipt
  })
})

/**
 * Successful observation response on the JSON wire.
 * @since 1.0.0
 * @category models
 */
export const ObserveResponse = Schema.Struct({
  protocol: Schema.Literal(protocol),
  ok: Schema.Literal(true),
  value: Schema.Struct({
    run: Schema.Struct({
      ...RunSummary.fields,
      finalOutput: Schema.optional(Schema.String),
      failureFault: Schema.optional(Fault.Class),
      failureTag: Schema.optional(Schema.String)
    }),
    events: Schema.Array(ControlEvent),
    nextCursor: Schema.String,
    hasMore: Schema.Boolean,
    terminal: Schema.Boolean
  })
})

/**
 * Stable sanitized failure response on the JSON wire.
 * @since 1.0.0
 * @category models
 */
export const ErrorResponse = Schema.Struct({
  protocol: Schema.Literal(protocol),
  ok: Schema.Literal(false),
  error: Schema.Struct({ code: Schema.String, message: Schema.String, retryable: Schema.Boolean })
})

const errorResponse = (cause: unknown) => {
  const known = Schema.is(ControlError.ControlErrorSchema)(cause)
  const code = cause instanceof BridgeError || known ? cause.code : "internal"
  const retryable = cause instanceof BridgeError
    ? cause.retryable
    : cause instanceof ControlError.TransportError
    ? cause.retryable
    : retryableCodes.has(code)
  // Control errors can contain storage paths, SQL diagnostics, or executor
  // output. The bridge publishes their stable code, never that backend text.
  const message = cause instanceof BridgeError ? cause.message : "Runtime bridge failed"
  const status = code === "unauthorized" ?
    401
    : notFoundCodes.has(code) ?
    404
    : conflictCodes.has(code) ?
    409
    : retryable ?
    503
    : code === "internal" ?
    500
    : 400
  return HttpServerResponse.jsonUnsafe({ protocol, ok: false, error: { code, message, retryable } }, { status })
}

/**
 * Answers a failed bridge request with its sanitized response, logging it first.
 *
 * The wire carries only the stable code. The operator log carries the full
 * cause of every failure the caller did not cause, so a launch that failed in
 * storage or in the executor can be diagnosed from the host.
 */
const respondToFailure = (operation: "runtime-bridge.command" | "runtime-bridge.observe") => (cause: unknown) => {
  const response = errorResponse(cause)
  if (cause instanceof BridgeError) return Effect.succeed(response)
  const code = Schema.is(ControlError.ControlErrorSchema)(cause) ? cause.code : "internal"
  return Effect.logError({ message: "Runtime bridge request failed", operation, code, cause }).pipe(
    Effect.as(response)
  )
}

const readJson = Effect.gen(function*() {
  const request = yield* HttpServerRequest.HttpServerRequest
  const text = yield* request.text
  return yield* Effect.try({
    try: () => JSON.parse(text) as unknown,
    catch: () => new BridgeError({ code: "invalid_request", message: "Request body must be JSON", retryable: false })
  })
})

const authenticated = <A, E, R>(
  config: Config,
  effect: (principal: Principal) => Effect.Effect<A, E, R>
) =>
  Effect.gen(function*() {
    const request = yield* HttpServerRequest.HttpServerRequest
    const principal = yield* config.authenticate(request.headers)
    return yield* effect(principal)
  })

/**
 * Mounts the authenticated JSON bridge beside the existing gateway RPCs.
 * @since 1.0.0
 * @category layers
 */
export const layer = (config: Config) => {
  const command = authenticated(config, (principal) =>
    Effect.gen(function*() {
      const body = yield* readJson
      const input = yield* decodeCommand(body).pipe(Effect.mapError(() =>
        new BridgeError({
          code: "invalid_request",
          message: "Request does not match the runtime bridge contract",
          retryable: false
        })
      ))
      const control = yield* Control
      const value = yield* execute(config, control, principal, input)
      return HttpServerResponse.jsonUnsafe({ protocol, ok: true, value })
    })).pipe(
      Effect.catch(respondToFailure("runtime-bridge.command")),
      Effect.withSpan("runtime-bridge.command")
    )

  const observation = authenticated(config, () =>
    Effect.gen(function*() {
      const body = yield* readJson
      const input = yield* decodeObserve(body).pipe(Effect.mapError(() =>
        new BridgeError({
          code: "invalid_request",
          message: "Request does not match the observation contract",
          retryable: false
        })
      ))
      const control = yield* Control
      const value = yield* observe(control, input)
      return HttpServerResponse.jsonUnsafe({ protocol, ok: true, value })
    })).pipe(
      Effect.catch(respondToFailure("runtime-bridge.observe")),
      Effect.withSpan("runtime-bridge.observe")
    )

  return HttpRouter.add("POST", "/runtime/v1/command", command).pipe(
    Layer.merge(HttpRouter.add("POST", "/runtime/v1/observe", observation))
  )
}
