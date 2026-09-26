/** Append exactly the checked native change through the existing landing policy. */
import { Action, Flow, Interpreter, Poll, Sleep } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Effect, Layer, Option, Schema } from "effect"
import { AppendObservation, AppendPreparation, LandingIdentity, QueuedAppend } from "../coding/landing-schema.ts"
import { Landing } from "../coding/landing.ts"
import { NativeCoding, requestIdFor, SourceCreation } from "../coding/native.ts"
import { CodingError, Revision } from "../coding/schema.ts"
import { CheckReceipt, pinnedPolicy, RepositoryCheckReceipts, verifiedCheckStep } from "./check-receipt.ts"
import { currentExecutionId } from "./inspection.ts"
import { retainedStepError, Work } from "./jobs.ts"
import { StepResult } from "./schema.ts"
const invalid = (message: string) => new CodingError({ code: "invalid_receipt", message })
const unavailable = (message: string) => new CodingError({ code: "unavailable", message })
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
const service = Effect.gen(function*() {
  const value = yield* Effect.serviceOption(Landing)
  return Option.isSome(value)
    ? value.value
    : yield* invalid("Connect the native landing adapter to submit this checked change")
})
const Input = Schema.Struct({ work: Work, result: StepResult })
const Prepared = Schema.Struct({ input: Input, source: Revision, preparation: AppendPreparation })
const Prepare = Action.make("repository/prepare-landing", {
  payload: Input,
  success: Prepared,
  error: CodingError,
  nondeterministic: true
})
const Reported = Schema.Struct({ prepared: Prepared, receipt: Schema.NullOr(CheckReceipt) })
const Report = Action.make("repository/report-check-receipt", {
  payload: Prepared,
  success: Reported,
  error: CodingError,
  nondeterministic: true
})
const Create = Action.make("repository/create-landing", {
  payload: Prepared,
  success: LandingIdentity,
  error: CodingError,
  nondeterministic: true
})
const Queue = Action.make("repository/queue-landing", {
  payload: { prepared: Prepared, identity: LandingIdentity },
  success: QueuedAppend,
  error: CodingError,
  nondeterministic: true
})
const Observed = Schema.Union([
  AppendObservation,
  Schema.Struct({ status: Schema.Literal("unobserved"), reason: Schema.String })
])
const Observe = Action.make("repository/observe-landing", {
  payload: { queued: QueuedAppend, deadlineAt: Schema.Number, attempt: Schema.Number },
  success: Poll.CheckResult(Observed),
  error: Schema.Never,
  nondeterministic: true
})
const AwaitLanding = Poll.make("repository/AwaitLanding", {
  input: { queued: QueuedAppend, deadlineAt: Schema.Number },
  result: Observed,
  intervalMs: 5000,
  maxAttempts: 1441,
  onTimeout: "return-last",
  check: Node.capture({ action: Observe.name, policy: "repository-delivery/v1" }, (input) => Observe.call(input))
})
const Retain = Action.make("repository/retain-landing", {
  payload: { prepared: Prepared, queued: QueuedAppend, observed: Observed },
  success: StepResult,
  error: CodingError
})
const RetainFailure = Action.make("repository/retain-delivery-failure", {
  payload: { input: Input, error: Schema.Json },
  success: StepResult,
  error: CodingError
})
export const DeliverChange = Flow.make("repository/DeliverChange", {
  payload: Input,
  success: StepResult,
  error: Schema.Union([CodingError, Poll.Failure]),
  body: (input) =>
    Prepare.call(input).pipe(
      Node.bindPlanned((prepared) =>
        Report.call(prepared).pipe(
          Node.bindPlanned((reported) => Create.call(reported.prepared)),
          Node.bindPlanned((identity) => Queue.call({ prepared, identity })),
          Node.bindPlanned((queued) =>
            AwaitLanding.child({ queued, deadlineAt: input.work.deadlineAt }).pipe(
              Node.bindPlanned((observed) => Retain.call({ prepared, queued, observed }))
            )
          )
        )
      ),
      Node.catch({
        error: Schema.Union([CodingError, Poll.Failure]),
        onFailure: (error) =>
          Node.succeed(error).pipe(
            Node.map(retainedStepError),
            Node.bindPlanned((error) => RetainFailure.call({ input, error }))
          )
      })
    )
})
export const deliveryLayers = Layer.mergeAll(
  Interpreter.layer(DeliverChange),
  Interpreter.layer(AwaitLanding),
  Poll.layer,
  Sleep.layer,
  RetainFailure.toLayer(({ input, error }) =>
    Effect.succeed({
      ...input.result,
      status: "needs-maintainer" as const,
      summary: typeof object(error).message === "string"
        ? object(error).message as string
        : "The checked source needs landing inspection",
      output: JSON.parse(JSON.stringify({ ...object(input.result.output), landed: false, deliveryError: error }))
    })
  ),
  Prepare.toLayer((input) =>
    Effect.gen(function*() {
      const { work, result } = input, source = Schema.decodeUnknownOption(Revision)(object(result.output).source)
      if (
        work.executionMode !== "live" || work.step.id === "poc" || work.step.id === "split" ||
        result.status !== "completed" ||
        object(result.output).status !== "implemented" || Option.isNone(source) || Date.now() >= work.deadlineAt
      ) return yield* invalid("Landing requires the live implemented change and fresh checks")
      const checked = object(object(result.output).checks), checkDetail = object(checked.output)
      if (
        checked.status !== "completed" || checkDetail.gate !== "passed" ||
        checkDetail.candidate !== source.value.commitId
      ) return yield* invalid("Landing checks do not name this exact native source")
      const creation = Schema.decodeUnknownOption(SourceCreation)(object(result.output).creation)
      if (
        Option.isNone(creation) || !creation.value.publicationReady ||
        creation.value.source.commitId !== source.value.commitId ||
        creation.value.source.treeId !== source.value.treeId ||
        creation.value.source.changeId !== source.value.changeId ||
        creation.value.source.operationId !== source.value.operationId ||
        source.value.parentCommitIds.length !== 1 ||
        source.value.parentCommitIds[0] !== work.evidence.source.commitId ||
        creation.value.base.commitId !== work.evidence.source.commitId ||
        creation.value.base.treeId !== work.evidence.source.treeId
      ) return yield* invalid("Landing requires the exact owned native creation receipt")
      const native = yield* NativeCoding, landing = yield* service, executionId = yield* currentExecutionId
      if (
        creation.value.workspaceId !== landing.binding.workspaceId ||
        creation.value.repositoryId !== landing.binding.repositoryId
      ) return yield* invalid("The source creation belongs to another landing workspace")
      const main = yield* landing.readMain
      if (main !== work.evidence.source.commitId) {
        return yield* invalid("Main changed before landing; retain the checked source")
      }
      // Main is already public. The new source is published only through its
      // owned native creation receipt; the editor remains on its prior head.
      yield* native.publishOriginalSource({
        requestId: requestIdFor(executionId, "repository-checked-source"),
        source: creation.value.source,
        creation: { requestId: creation.value.requestId, requestDigest: creation.value.requestDigest }
      })
      const preparation = yield* landing.prepare({
        target_bookmark: "main",
        expected_commit_id: main,
        source_commit_id: source.value.commitId,
        source_base_commit_id: work.evidence.source.commitId
      })
      // Plue anchors the suffix on the previous append's source, so main's own
      // published tip leads it on every landing after a repository's first one.
      const delivered = preparation.changes.at(-1)!,
        outside = preparation.changes.filter((change) => change !== delivered && change.commit_id !== main)
      if (
        delivered.change_id !== source.value.changeId || delivered.commit_id !== source.value.commitId ||
        outside.length !== 0
      ) {
        return yield* invalid(
          `Landing includes work outside this checked native change: ${
            (outside.length === 0 ? [delivered] : outside).map((change) => `${change.change_id}@${change.commit_id}`)
              .join(", ")
          }`
        )
      }
      return { input, source: source.value, preparation }
    }).pipe(
      Effect.mapError((error) =>
        error instanceof CodingError ? error : invalid("Checked source retention or landing preparation failed")
      )
    )
  ),
  Report.toLayer((prepared) =>
    Effect.gen(function*() {
      const policy = yield* pinnedPolicy(prepared.input.work)
      if (policy.kind === "none") return { prepared, receipt: null }
      const receipts = yield* Effect.serviceOption(RepositoryCheckReceipts)
      // A landing request the worker could only ever refuse is a slower refusal.
      if (Option.isNone(receipts)) {
        return yield* unavailable(
          "Connect the repository CI check receipt publisher before landing under a pinned CI policy"
        )
      }
      const executionId = object(object(prepared.input.result.output).checks).executionId
      if (typeof executionId !== "string" || !executionId) {
        return yield* invalid(
          "The checked step names no durable check execution"
        )
      }
      const verified = yield* verifiedCheckStep({
        executionId,
        commitId: prepared.source.commitId,
        work: prepared.input.work,
        baseCommitId: prepared.preparation.source_base_commit_id,
        source: object(prepared.input.result.output).source,
        ref: policy.ref,
        checks: policy.checks
      })
      const receipt = yield* receipts.value.report(requestIdFor(verified.executionId, "repository-ci-receipt"), {
        repo: prepared.input.work.repo,
        workspace_id: (yield* service).binding.workspaceId,
        registration_id: policy.ref.registrationId,
        revision: policy.ref.revision,
        digest: policy.ref.digest,
        execution_digest: policy.ref.executionDigest,
        run_id: verified.runId,
        execution_id: verified.executionId,
        commit_id: prepared.source.commitId,
        change_id: prepared.source.changeId,
        base_commit_id: prepared.preparation.source_base_commit_id,
        checks: verified.checks,
        gate: "passed"
      })
      return { prepared, receipt }
    })
  ),
  Create.toLayer((prepared) =>
    Effect.gen(function*() {
      return yield* (yield* service).create(
        requestIdFor(yield* currentExecutionId, "repository-landing"),
        prepared.preparation,
        prepared.input.work.step.name + "\n\n" + prepared.input.result.summary
      )
    })
  ),
  Queue.toLayer(({ prepared, identity }) =>
    Effect.gen(function*() {
      return yield* (yield* service).queue(identity, prepared.preparation, {
        commit_id: prepared.source.commitId,
        source_base_commit_id: prepared.preparation.source_base_commit_id,
        expected_commit_id: prepared.preparation.expected_commit_id,
        description: prepared.input.work.step.name + "\n\n" + prepared.input.result.summary
      })
    })
  ),
  Observe.toLayer(({ queued, deadlineAt }) =>
    Effect.gen(function*() {
      if (Date.now() >= deadlineAt) {
        return {
          satisfied: true,
          output: {
            status: "unobserved" as const,
            reason: "The job deadline expired while the existing landing remained pending"
          }
        }
      }
      const observed = yield* (yield* service).observe(queued)
      return { satisfied: observed.status === "landed" || observed.status === "failed", output: observed }
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed({
          satisfied: Date.now() >= deadlineAt,
          output: {
            status: "unobserved" as const,
            reason: error instanceof CodingError ? error.message : "The landing receipt could not be read"
          }
        })
      )
    )
  ),
  Retain.toLayer(({ prepared, queued, observed }) =>
    Effect.gen(function*() {
      if (
        observed.status !== "landed" || observed.task_id !== queued.taskId ||
        observed.result.landed_count !== queued.preparation.changes.length
      ) return yield* invalid(`Landing ${queued.number} has not completed successfully`)
      return {
        ...prepared.input.result,
        summary: "Landed",
        executionId: yield* currentExecutionId,
        evidence: [
          ...prepared.input.result.evidence,
          `landing:${queued.number}`,
          `main:${observed.result.target_commit_id}`
        ],
        output: JSON.parse(
          JSON.stringify({
            ...object(prepared.input.result.output),
            landed: true,
            landing: queued.number,
            taskId: queued.taskId,
            mainCommitId: observed.result.target_commit_id,
            receipt: observed
          })
        )
      }
    })
  )
)
