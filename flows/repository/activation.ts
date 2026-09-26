/** Live trials use the same event dispatcher and prove the resulting native run. */
import { ControlRuntime } from "@smthrs/control/ControlRuntime"
import * as RunCatalogRead from "@smthrs/engine-store/RunCatalogRead"
import { Action, Flow, Interpreter, Poll, Sleep } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Effect, Layer, Option, Schema } from "effect"
import { registrationScopeProblems, storedSetupCandidate } from "../../packages/rpc/src/RepositorySetup.ts"
import * as Jj from "../../packages/smithers/flows/jj/src/Jj.ts"
import { NativeCoding } from "../coding/native.ts"
import { CodingError, Revision } from "../coding/schema.ts"
import { evaluatedCandidate } from "./evaluation.ts"
import { deploymentMinutes, deploymentTokens } from "./inspection.ts"
import { completedJob } from "./receipts.ts"
import { RepositoryRemote } from "./remote.ts"
import { type JobInput, JobResult, SetupInput } from "./schema.ts"

const invalid = (message: string) => new CodingError({ code: "invalid_receipt", message })
const json = (value: unknown): Schema.Json => JSON.parse(JSON.stringify(value))
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
const requireRemote = Effect.gen(function*() {
  const remote = yield* Effect.serviceOption(RepositoryRemote)
  return Option.isSome(remote) ? remote.value : yield* invalid("Connect the repository host before activation")
})
const RegistrationRow = Schema.Struct({
  id: Schema.NonEmptyString,
  job: Schema.String,
  mode: Schema.Literals(["trial", "enabled"]),
  revision: Schema.Int,
  digest: Schema.String,
  source_revision: Schema.String,
  enabled: Schema.Boolean
})
const registrationRows = (response: unknown): ReadonlyArray<typeof RegistrationRow.Type> => {
  const listed = Array.isArray(response) ? response : object(response).items
  return (Array.isArray(listed) ? listed : []).flatMap((value) => {
    const row = Schema.decodeUnknownOption(RegistrationRow)(value)
    return Option.isSome(row) ? [row.value] : []
  })
}
/** The registry keeps one row per job and mode, so the job's enabled-mode row
 * is its active policy whatever revision the local draft has reached. */
const policyRow = (response: unknown, input: SetupInput) =>
  registrationRows(response).find((row) => row.job === input.job && row.mode === "enabled")
/** The registration a pause is asked to stop, read before the registry is written. */
export const activeRegistration = (response: unknown, input: SetupInput) => {
  const row = policyRow(response, input)
  return row?.enabled === true ? row : undefined
}
/** The paused row a pause receipt may speak for. The request carries the local
 * draft's revision, which moves on while the active policy stays where it was
 * applied, so that revision identifies nothing in the registry. */
export const pausedRegistration = (response: unknown, input: SetupInput) => {
  const row = policyRow(response, input)
  return row !== undefined && !row.enabled ? row : undefined
}
/** A paused policy whose reviewed draft this candidate still carries. Cloud
 * re-enables a row only at a newer revision, so a restart applies the next
 * revision of the same draft and keeps that row's evaluation and live trial. */
export const restartedRegistration = (response: unknown, input: SetupInput) => {
  const row = policyRow(response, input)
  return row !== undefined && !row.enabled && row.revision < input.revision
      && storedSetupCandidate({
        repo: input.repo,
        job: input.job,
        revision: row.revision,
        draft: JSON.parse(JSON.stringify(input.draft))
      }, row.digest) ?
    row :
    undefined
}
export const TrialIssue = Schema.Struct({
  source: Schema.Literal("smithers-cloud"),
  number: Schema.Int.check(Schema.isGreaterThan(0)),
  issue_id: Schema.Number,
  request_id: Schema.String,
  api_path: Schema.String
})
export const Registration = Schema.Struct({
  registration_id: Schema.String,
  revision: Schema.Int,
  digest: Schema.String,
  source_revision: Schema.String,
  mode: Schema.Literals(["trial", "enabled"]),
  enabled: Schema.Boolean
})
export const Activated = Schema.Struct({
  registration: Registration,
  source: Revision,
  trialIssue: Schema.optionalKey(TrialIssue)
})
export const Register = Action.make("repository/register-candidate", {
  payload: { input: SetupInput, mode: Schema.Literals(["trial", "enabled"]), deadlineAt: Schema.Number },
  success: Activated,
  error: CodingError,
  nondeterministic: true
})
export const RegisterCandidate = Flow.make("repository/RegisterCandidate", {
  payload: Register.payloadSchema,
  success: Activated,
  error: CodingError,
  body: (value) => Register.call(value)
})
export const TrialResult = Schema.Struct({
  status: Schema.Literals(["completed", "failed", "pending"]),
  runId: Schema.String,
  executionId: Schema.String,
  evidence: Schema.Array(Schema.String),
  result: Schema.optionalKey(JobResult),
  error: Schema.optionalKey(Schema.String)
})
const Probe = Action.make("repository/probe-trial", {
  payload: { input: SetupInput, activation: Activated, deadlineAt: Schema.Number, attempt: Schema.Number },
  success: Poll.CheckResult(TrialResult),
  error: Schema.Never,
  nondeterministic: true
})
export const WaitTrial = Poll.make("repository/WaitTrial", {
  input: { input: SetupInput, activation: Activated, deadlineAt: Schema.Number },
  result: TrialResult,
  intervalMs: 3000,
  maxAttempts: 2401,
  onTimeout: "return-last",
  check: Node.capture({ action: Probe.name, policy: "repository-trial/v1" }, (input) => Probe.call(input))
})
export const ManualDispatch = Schema.Struct({
  dispatch_id: Schema.Union([Schema.String, Schema.Number]),
  registration_id: Schema.String,
  revision: Schema.Int,
  digest: Schema.String,
  status: Schema.String,
  run_id: Schema.optionalKey(Schema.String)
})
const RequestManual = Action.make("repository/request-manual", {
  payload: { input: SetupInput, deadlineAt: Schema.Number },
  success: ManualDispatch,
  error: CodingError,
  nondeterministic: true
})
export const DispatchManual = Flow.make("repository/DispatchManual", {
  payload: RequestManual.payloadSchema,
  success: ManualDispatch,
  error: CodingError,
  body: (value) => RequestManual.call(value)
})
const ProbeManual = Action.make("repository/probe-manual", {
  payload: { input: SetupInput, dispatch: ManualDispatch, deadlineAt: Schema.Number, attempt: Schema.Number },
  success: Poll.CheckResult(TrialResult),
  error: Schema.Never,
  nondeterministic: true
})
export const WaitManual = Poll.make("repository/WaitManual", {
  input: { input: SetupInput, dispatch: ManualDispatch, deadlineAt: Schema.Number },
  result: TrialResult,
  intervalMs: 3000,
  maxAttempts: 2401,
  onTimeout: "return-last",
  check: Node.capture({ action: ProbeManual.name, policy: "repository-manual/v1" }, (value) => ProbeManual.call(value))
})
// The feature step's own mode is the only authority for issue-triggered
// feature work, and a comment is never a request to build another feature.
export const normalEvents = (input: SetupInput) =>
  input.job === "review"
    ? [{ type: "pull_request", actions: ["opened", "synchronize", "reopened"] }]
    : input.job === "ci" ?
    [{ type: "pull_request", actions: ["opened", "synchronize", "reopened"] }, { type: "push", actions: [] }]
    : input.job === "chores" ?
    input.draft.choreEvent === "push" ?
      [{ type: "push", actions: [] }]
      : input.draft.choreEvent === "labeled"
      ? [{ type: "issues", actions: ["labeled"] }]
      : []
    : input.job === "feature" ?
    input.draft.steps.some((step) => step.id === "feature" && (step.mode === "automatic" || step.mode === "approved"))
      ? [{ type: "issues", actions: ["opened", "edited", "reopened", "labeled"] }] :
      []
    : [{ type: "issues", actions: ["opened", "edited", "reopened", "labeled"] }, {
      type: "issue_comment",
      actions: ["created"]
    }]
export const activationLayers = Layer.mergeAll(
  Interpreter.layer(RegisterCandidate),
  Interpreter.layer(WaitTrial),
  Interpreter.layer(DispatchManual),
  Interpreter.layer(WaitManual),
  Poll.layer,
  Sleep.layer,
  RequestManual.toLayer(({ input, deadlineAt }) =>
    Effect.gen(function*() {
      const manual = input.manual, remote = yield* requireRemote
      if (input.operation !== "run" || !manual || !remote.manual || Date.now() >= deadlineAt) {
        return yield* invalid("The manual request is unavailable or expired")
      }
      if (
        input.repo !== remote.repo || (input.workspaceId !== undefined && input.workspaceId !== remote.workspaceId)
      ) return yield* invalid("The manual request belongs to another workspace")
      const response = yield* remote.manual(
        input.job,
        input.requestId,
        json({
          repo: input.repo,
          workspace_id: remote.workspaceId,
          revision: input.revision,
          digest: input.digest,
          step_id: manual.stepId,
          prompt: manual.prompt,
          ...(manual.subject ? { subject: manual.subject } : {})
        })
      )
      const dispatch = yield* Schema.decodeUnknownEffect(ManualDispatch)(response)
      if (
        dispatch.revision !== input.revision || dispatch.digest !== input.digest || !dispatch.registration_id ||
        !String(dispatch.dispatch_id)
      ) {
        return yield* invalid("The manual dispatch did not retain the exact active configuration")
      }
      return dispatch
    }).pipe(
      Effect.mapError((error) =>
        error instanceof CodingError ? error : invalid("The selected work could not be dispatched")
      )
    )
  ),
  ProbeManual.toLayer(({ input, dispatch, deadlineAt }) =>
    Effect.gen(function*() {
      const pending = {
        satisfied: false,
        output: { status: "pending" as const, runId: dispatch.run_id ?? "", executionId: "", evidence: [] }
      }
      if (Date.now() >= deadlineAt) {
        return {
          satisfied: true,
          output: {
            ...pending.output,
            status: "failed" as const,
            error: "The manual request reached its configured time limit"
          }
        }
      }
      const manual = input.manual
      if (!manual) return yield* invalid("The retained manual request is missing")
      const response = yield* (yield* requireRemote).dispatches(input.job)
      const rows = Array.isArray(response) ? response : object(response).items
      if (!Array.isArray(rows)) return yield* invalid("The dispatcher did not return a receipt list")
      const row = rows.map(object).find((row) => String(row.id) === String(dispatch.dispatch_id))
      if (!row) return pending
      if (
        row.registration_id !== dispatch.registration_id || row.revision !== input.revision ||
        row.digest !== input.digest ||
        row.source !== (manual.subject?.source ?? "smithers-cloud") ||
        (row.issue_number ?? 0) !== (manual.subject?.number ?? 0) ||
        typeof row.delivery_key !== "string" || !row.delivery_key
      ) return yield* invalid("The manual dispatch belongs to different work")
      if (row.status === "failed") {
        return yield* invalid(
          typeof row.error === "string" ? row.error : "The manual dispatch failed"
        )
      }
      if (typeof row.run_id !== "string" || !row.run_id) return pending
      return yield* completedJob(row.run_id, input, {
        source: manual.subject?.source ?? "smithers-cloud",
        issueNumber: manual.subject?.number ?? 0,
        manualStep: manual.stepId,
        deliveryKey: row.delivery_key
      }).pipe(
        Effect.map((proof) =>
          proof
            ? {
              satisfied: true,
              output: {
                status: "completed" as const,
                runId: proof.run.runId,
                executionId: proof.executionId,
                evidence: [
                  `run:${proof.run.runId}`,
                  `execution:${proof.executionId}`,
                  `source:${proof.output.sourceRevision}`
                ],
                result: proof.output
              }
            }
            : { ...pending, output: { ...pending.output, runId: row.run_id as string } }
        ),
        Effect.catch((error) =>
          Effect.succeed({
            satisfied: true,
            output: {
              status: "failed" as const,
              runId: row.run_id as string,
              executionId: "",
              evidence: [],
              error: error instanceof CodingError ? error.message : "The manual job's result could not be verified"
            }
          })
        )
      )
    }).pipe(Effect.catch((error) =>
      Effect.succeed({
        satisfied: true,
        output: {
          status: "failed" as const,
          runId: "",
          executionId: "",
          evidence: [],
          error: error instanceof CodingError ? error.message : "The manual dispatch could not be verified"
        }
      })
    ))
  ),
  Register.toLayer(({ input, mode, deadlineAt }) =>
    Effect.gen(function*() {
      // The same configuration invariant the card applies. A trigger whose steps
      // never run only ever reports skipped, and a label-scoped registration with
      // no label selects every labeled issue instead of the maintainer's own.
      const scoped = mode === "enabled" ? registrationScopeProblems(input)[0] : undefined
      if (scoped) return yield* invalid(scoped)
      if (Date.now() >= deadlineAt) return yield* invalid("Setup reached its configured time limit")
      const remote = yield* requireRemote
      if (
        remote.repo !== input.repo || (input.workspaceId !== undefined && input.workspaceId !== remote.workspaceId)
      ) return yield* invalid("The candidate belongs to another workspace")
      if (input.draft.replies === "automatic") {
        if (
          input.job !== "issues" || !remote.source || (yield* remote.source) !== "smithers-cloud"
        ) {
          return yield* invalid(
            "Automatic replies are currently available for native issue handling only; choose draft replies"
          )
        }
      }
      yield* (yield* Jj.Jj).snapshot("repository automation registration")
      const source = (yield* (yield* NativeCoding).read()).head
      if (source.kind !== "resolved") return yield* invalid("Resolve native source conflicts before registration")
      // One trial artefact per press: a new issue is the event that dispatches a
      // new run, so a failed trial stays retryable. A press that never recorded a
      // receipt keeps its request id and the idempotent request returns its issue.
      const issue = mode === "trial" ?
        yield* remote.createTrial(
          input.job,
          input.requestId,
          json({
            repo: input.repo,
            workspace_id: remote.workspaceId,
            revision: input.revision,
            digest: input.digest,
            title: input.draft.trialTitle,
            body: input.draft.trialBody
          })
        ).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(TrialIssue)),
          Effect.mapError(() => invalid("The trial issue response does not match its request"))
        ) :
        undefined
      if (issue !== undefined && issue.request_id !== input.requestId) {
        return yield* invalid(
          "The trial issue receipt names another request"
        )
      }
      // Planning fixes the exact bundle authority before event dispatch. The input
      // event and the held-out cases vary; executable identity and finite envelope
      // do not, so the probe reads them from the configuration without the answers.
      const jobInput: JobInput = {
        ...evaluatedCandidate(input),
        sourceRevision: source.commitId,
        event: {
          source: "smithers-cloud",
          type: "issues",
          action: "opened",
          deliveryKey: `setup:${input.requestId}`,
          ...(issue ? { issueNumber: issue.number, trial: true } : {}),
          payload: { issue: { number: issue?.number ?? 0, title: input.draft.trialTitle, body: input.draft.trialBody } }
        }
      }
      const planned = yield* (yield* ControlRuntime).plan({
        flowId: `repository-jobs/${input.job}`,
        input: jobInput,
        idempotencyKey: `setup:${input.requestId}:job-plan`
      })
      const card = planned.card
      if (
        !card.executionDigest || card.flowId !== `repository-jobs/${input.job}` ||
        !card.envelope.budget || card.envelope.budget.milliseconds === undefined ||
        card.envelope.budget.tokens === undefined ||
        card.envelope.budget.milliseconds > deploymentMinutes * 60_000 || card.envelope.budget.tokens > deploymentTokens
      ) {
        return yield* invalid("The job declaration has no bounded reviewed execution policy")
      }
      const body = {
        repo: input.repo,
        workspace_id: remote.workspaceId,
        flow_id: card.flowId,
        revision: input.revision,
        digest: input.digest,
        source_revision: source.commitId,
        execution_digest: card.executionDigest,
        envelope: card.envelope,
        mode,
        ...(issue ?
          {
            trial_issue_number: issue.number,
            trial_source: issue.source,
            events: [{ type: "issues", actions: ["opened"] }]
          }
          : {
            events: normalEvents(input),
            ...(input.draft.scope === "label" || (input.job === "chores" && input.draft.choreEvent === "labeled")
              ? { label: input.draft.label }
              : {}),
            ...(input.job === "chores" ? { schedule: input.draft.schedule } : {})
          }),
        input: input.draft
      }
      const registration = yield* remote.register(input.job, json(body)).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Registration))
      )
      if (
        registration.revision !== input.revision || registration.digest !== input.digest ||
        registration.mode !== mode ||
        registration.source_revision !== source.commitId || !registration.enabled
      ) return yield* invalid("Registration did not retain the exact candidate and source")
      return { registration, source, ...(issue ? { trialIssue: issue } : {}) }
    }).pipe(
      Effect.mapError((error) =>
        error instanceof CodingError ? error : invalid("The exact candidate could not be registered")
      )
    )
  ),
  Probe.toLayer(({ input, activation, deadlineAt }) =>
    Effect.gen(function*() {
      const pending = {
        satisfied: false,
        output: { status: "pending" as const, runId: "", executionId: "", evidence: [] }
      }
      if (Date.now() >= deadlineAt) {
        return {
          satisfied: true,
          output: {
            ...pending.output,
            status: "failed" as const,
            error: "The live trial reached its configured time limit"
          }
        }
      }
      const issue = activation.trialIssue
      if (!issue) return yield* invalid("The trial has no retained real issue")
      const remote = yield* requireRemote, response = yield* remote.dispatches(input.job)
      const rows = Array.isArray(response) ? response : object(response).items
      if (!Array.isArray(rows)) return yield* invalid("The dispatcher did not return a receipt list")
      const matches = rows.map(object).filter((row) =>
        row.registration_id === activation.registration.registration_id && row.revision === input.revision &&
        row.digest === input.digest && row.source === issue.source && row.issue_number === issue.number
      )
      const failed = matches.find((row) => row.status === "failed")
      if (failed) {
        return yield* invalid(
          typeof failed.error === "string" ? failed.error : "The live trial dispatch failed"
        )
      }
      const dispatched = matches.find((row) => typeof row.run_id === "string" && row.run_id.length > 0)
      if (!dispatched) return pending
      const proof = yield* completedJob(dispatched.run_id as string, {
        ...input,
        sourceRevision: activation.source.commitId
      }, {
        source: issue.source,
        issueNumber: issue.number,
        trial: true,
        ...(typeof dispatched.delivery_key === "string" ? { deliveryKey: dispatched.delivery_key } : {})
      })
      if (!proof) return { ...pending, output: { ...pending.output, runId: dispatched.run_id as string } }
      return {
        satisfied: true,
        output: {
          status: "completed" as const,
          runId: proof.run.runId,
          executionId: proof.executionId,
          evidence: [
            `run:${proof.run.runId}`,
            `execution:${proof.executionId}`,
            `source:${proof.output.sourceRevision}`
          ],
          result: proof.output
        }
      }
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed({
          satisfied: true,
          output: {
            status: "failed" as const,
            runId: "",
            executionId: "",
            evidence: [],
            error: error instanceof CodingError
              ? error.message
              : "The live trial's native receipt could not be verified"
          }
        })
      )
    )
  )
).pipe(Layer.provideMerge(RunCatalogRead.layer))
