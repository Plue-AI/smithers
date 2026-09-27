/**
 * Typed failures raised by testing and conformance operations.
 *
 * Every error carries a stable `code` drawn from a closed literal union, so
 * consumers can match on codes without parsing messages. The per-error code
 * schemas and the combined {@link Code} union are exported.
 *
 * Governing design: `packages/testing/docs/concepts/typed-failures.md`.
 *
 * Every literal uses `snake_case`.
 *
 * @since 0.0.0
 */

import { CancelRequestFailed, FlowCycleDetected } from "@smthrs/flow/FlowRuntime"
import { ScoreGateCode } from "@smthrs/scorers/ScoreGate"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

/**
 * The runtime grading schemas and error class, re-exported with their original
 * names and constructor identity for test consumers.
 *
 * @since 0.0.0
 * @category errors
 */
export { InvalidScoreSample, ScoreGateCode, ScoreGateError } from "@smthrs/scorers/ScoreGate"

const constantCode = <const C extends string>(code: C) =>
  Schema.Literal(code).pipe(Schema.withConstructorDefault(Effect.succeed(code)))

/**
 * Codes raised by plan assertions.
 *
 * @since 0.0.0
 * @category codes
 */
export const PlanAssertionCode = Schema.Literals([
  "missing_node",
  "node_count_mismatch",
  "key_mismatch",
  "placement_mismatch",
  "declared_effect_mismatch",
  "envelope_mismatch",
  "missing_edge",
  "unexpected_edge",
  "coverage_mismatch",
  "snapshot_mismatch",
  "key_golden_mismatch",
  "purity_violation",
  "input_decode_failed"
])

/**
 * The decoded form of {@link PlanAssertionCode}.
 *
 * @since 0.0.0
 * @category codes
 */
export type PlanAssertionCode = typeof PlanAssertionCode.Type

/**
 * Codes raised by journal assertions.
 *
 * @since 0.0.0
 * @category codes
 */
export const JournalAssertionCode = Schema.Literals([
  "step_not_executed",
  "execution_order_mismatch",
  "terminal_status_mismatch",
  "effect_not_executed",
  "effect_kind_mismatch",
  "effect_journaled_more_than_once",
  "missing_idempotency_key",
  "idempotency_key_mismatch"
])

/**
 * The decoded form of {@link JournalAssertionCode}.
 *
 * @since 0.0.0
 * @category codes
 */
export type JournalAssertionCode = typeof JournalAssertionCode.Type

/**
 * Every stable code any testing error can carry, as one closed union.
 *
 * @since 0.0.0
 * @category codes
 */
export const Code = Schema.Union([
  PlanAssertionCode,
  JournalAssertionCode,
  ScoreGateCode,
  FlowCycleDetected.fields.code,
  CancelRequestFailed.fields.code,
  Schema.Literals([
    "conformance_violation",
    "unscripted_model",
    "fixture_not_encodable",
    "replay_harness_mismatch",
    "fixture_divergence",
    "exactly_once_unsupported",
    "capability_contract_violation",
    "conformance_skipped",
    "engine_unavailable",
    "execution_conflict",
    "capability_operation_failed",
    "transaction_commit_failed",
    "rewind_failed",
    "flow_hash_mismatch"
  ])
])

/**
 * The decoded form of {@link Code}.
 *
 * @since 0.0.0
 * @category codes
 */
export type Code = typeof Code.Type

/**
 * An assertion failure while inspecting a flow plan.
 *
 * @since 0.0.0
 * @category errors
 */
export class PlanAssertionError extends Schema.TaggedError<PlanAssertionError>()("PlanAssertionError", {
  code: PlanAssertionCode,
  message: Schema.String,
  expected: Schema.optional(Schema.Unknown),
  actual: Schema.optional(Schema.Unknown)
}) {}

/**
 * An assertion failure while inspecting a flow journal.
 *
 * @since 0.0.0
 * @category errors
 */
export class JournalAssertionError extends Schema.TaggedError<JournalAssertionError>()("JournalAssertionError", {
  code: JournalAssertionCode,
  message: Schema.String,
  expected: Schema.optional(Schema.Unknown),
  actual: Schema.optional(Schema.Unknown)
}) {}

/**
 * A failed executable conformance pin.
 *
 * @since 0.0.0
 * @category errors
 */
export class ConformanceViolation extends Schema.TaggedError<ConformanceViolation>()("ConformanceViolation", {
  code: constantCode("conformance_violation"),
  pin: Schema.String,
  message: Schema.String,
  expected: Schema.optional(Schema.Unknown),
  actual: Schema.optional(Schema.Unknown)
}) {}

/**
 * A recorded model received a request with no matching fixture.
 *
 * The fields are a bounded identity, not the request. This error is raised as
 * a defect, so a runner prints it in full: carrying the whole
 * `ModelRequestLike` put every system block, every turn of the conversation,
 * and every tool schema into CI logs and into any attached error reporter — an
 * unbounded payload for a replay double whose whole purpose is long agent
 * conversations, and one that routinely holds file contents and customer data.
 *
 * @since 0.0.0
 * @category errors
 */
export class UnscriptedModelError extends Schema.TaggedError<UnscriptedModelError>()("UnscriptedModelError", {
  code: constantCode("unscripted_model"),
  modelId: Schema.String,
  messageCount: Schema.Number,
  toolNames: Schema.Array(Schema.String)
}) {}

/**
 * A value a fixture must store is not representable as canonical JSON.
 *
 * `path` names the offending value — `$.tools[0].parameters.x` — and `reason`
 * says which rule it broke, so a consumer matches on a stable code and a typed
 * field instead of parsing the prose of a bare `TypeError`.
 *
 * @since 0.0.0
 * @category errors
 */
export class FixtureEncodingError extends Schema.TaggedError<FixtureEncodingError>()("FixtureEncodingError", {
  code: constantCode("fixture_not_encodable"),
  path: Schema.String,
  reason: Schema.Literals([
    "cycle",
    "non-plain-object",
    "non-finite-number",
    "symbol-key",
    "unsupported-type",
    "too-deep"
  ])
}) {}

/**
 * A replay harness produced output different from its recorded expectation.
 *
 * @since 0.0.0
 * @category errors
 */
export class ReplayHarnessMismatchError extends Schema.TaggedError<ReplayHarnessMismatchError>()(
  "ReplayHarnessMismatchError",
  {
    code: constantCode("replay_harness_mismatch"),
    expected: Schema.String,
    actual: Schema.String
  }
) {}

/**
 * The first divergent field in a fixture sequence.
 *
 * @since 0.0.0
 * @category errors
 */
export class FixtureDivergenceError extends Schema.TaggedError<FixtureDivergenceError>()(
  "FixtureDivergenceError",
  {
    code: constantCode("fixture_divergence"),
    index: Schema.Number,
    field: Schema.String,
    expected: Schema.Unknown,
    actual: Schema.Unknown
  }
) {}

/**
 * Exactly-once assertions are unsupported because the assertion vocabulary must
 * not be able to lie: the engine does not provide exactly-once execution.
 *
 * @since 0.0.0
 * @category errors
 */
export class ExactlyOnceUnsupportedError extends Schema.TaggedError<ExactlyOnceUnsupportedError>()(
  "ExactlyOnceUnsupportedError",
  {
    code: constantCode("exactly_once_unsupported"),
    message: Schema.String
  }
) {}

/**
 * An operation violated its declared capability contract.
 *
 * When the violation is a wrong typed capability code, the expectation and the
 * observation are carried as the typed `expectedCode` / `actualCode` fields —
 * never encoded into the operation string.
 *
 * @since 0.0.0
 * @category errors
 */
export class CapabilityContractError extends Schema.TaggedError<CapabilityContractError>()(
  "CapabilityContractError",
  {
    code: constantCode("capability_contract_violation"),
    capability: Schema.String,
    operation: Schema.String,
    expectedCode: Schema.optional(Schema.String),
    actualCode: Schema.optional(Schema.String)
  }
) {}

/**
 * A conformance pin could not run because its subject does not implement the
 * capability named by the pin.
 *
 * This is a failure, not a successful test outcome. Suite adapters may choose
 * not to register capability pins for subjects that declare a narrower
 * contract, but once a pin runs it must either assert behavior or fail with
 * this stable code.
 *
 * @since 0.0.0
 * @category errors
 */
export class ConformanceSkipped extends Schema.TaggedError<ConformanceSkipped>()("ConformanceSkipped", {
  code: constantCode("conformance_skipped"),
  pin: Schema.String,
  capability: Schema.String,
  reason: Schema.String
}) {}

/**
 * The requested engine subject is unavailable for a test or conformance pin.
 *
 * @since 0.0.0
 * @category errors
 */
export class EngineUnavailableError extends Schema.TaggedError<EngineUnavailableError>()("EngineUnavailableError", {
  code: constantCode("engine_unavailable"),
  message: Schema.String
}) {}

/**
 * A `run` named an execution id that already exists, with a different flow or a
 * different payload.
 *
 * An engine that accepted the id and silently ran the *original* flow on the
 * *original* payload would give a caller no signal at all that its arguments
 * were ignored, on the seam that defines engine conformance. `expected` and
 * `actual` are bounded renderings, never the payloads themselves.
 *
 * @since 0.0.0
 * @category errors
 */
export class ExecutionConflictError extends Schema.TaggedError<ExecutionConflictError>()("ExecutionConflictError", {
  code: constantCode("execution_conflict"),
  executionId: Schema.String,
  field: Schema.Literals(["flow", "payload"]),
  expected: Schema.String,
  actual: Schema.String
}) {}

/**
 * Transaction commit-failure injection boundaries.
 *
 * @since 0.0.0
 * @category codes
 */
export const TransactionBoundary = Schema.Literals(["frame", "snapshot", "output", "attempt", "event"])

/**
 * The decoded form of {@link TransactionBoundary}.
 *
 * @since 0.0.0
 * @category codes
 */
export type TransactionBoundary = typeof TransactionBoundary.Type

/**
 * Rewind boundaries at which a conformance subject can inject a failure.
 *
 * @since 0.0.0
 * @category codes
 */
export const RewindBoundary = Schema.Literals([
  "load-frame",
  "validate-frame",
  "truncate-journal",
  "restore-snapshot",
  "restore-output",
  "restore-attempt",
  "append-audit",
  "resume"
])

/**
 * The decoded form of {@link RewindBoundary}.
 *
 * @since 0.0.0
 * @category codes
 */
export type RewindBoundary = typeof RewindBoundary.Type

/**
 * A requested capability operation has no valid subject.
 *
 * @since 0.0.0
 * @category errors
 */
export class CapabilityOperationError
  extends Schema.TaggedError<CapabilityOperationError>()("CapabilityOperationError", {
    code: constantCode("capability_operation_failed"),
    capability: Schema.String,
    operation: Schema.String,
    message: Schema.String
  })
{}

/**
 * A failure raised at an injected transactional commit boundary.
 *
 * @since 0.0.0
 * @category errors
 */
export class TransactionCommitError extends Schema.TaggedError<TransactionCommitError>()("TransactionCommitError", {
  code: constantCode("transaction_commit_failed"),
  boundary: TransactionBoundary
}) {}

/**
 * A failure raised at an injected frame-rewind boundary.
 *
 * @since 0.0.0
 * @category errors
 */
export class RewindFailureError extends Schema.TaggedError<RewindFailureError>()("RewindFailureError", {
  code: constantCode("rewind_failed"),
  executionId: Schema.String,
  frame: Schema.Number,
  boundary: RewindBoundary
}) {}

/**
 * Resume was rejected because the current flow or import graph differs
 * from the stamp recorded for the execution.
 *
 * @since 0.0.0
 * @category errors
 */
export class FlowHashMismatchError extends Schema.TaggedError<FlowHashMismatchError>()("FlowHashMismatchError", {
  code: constantCode("flow_hash_mismatch"),
  executionId: Schema.String,
  expectedFlowHash: Schema.String,
  actualFlowHash: Schema.String,
  expectedImportHash: Schema.String,
  actualImportHash: Schema.String
}) {}

/**
 * Every typed failure an engine subject (or one of its optional capabilities)
 * may raise. The conformance seam never carries an `unknown` error channel: a
 * subject that laundered a foreign cause into `unknown` could not be matched on
 * by a pin.
 *
 * `FlowCycleDetected` is re-declared here because it is part of the engine's
 * typed `execute` contract: a recoverable failure carrying the cycle `path`,
 * which pins must be able to match on rather than a stringified dump.
 * `CancelRequestFailed` is part of the engine's typed interrupt contract for
 * the same reason.
 *
 * @since 0.0.0
 * @category errors
 */
export type EngineSubjectError =
  | EngineUnavailableError
  | ExecutionConflictError
  | CapabilityContractError
  | ConformanceSkipped
  | CapabilityOperationError
  | TransactionCommitError
  | RewindFailureError
  | FlowHashMismatchError
  | FlowCycleDetected
  | CancelRequestFailed
