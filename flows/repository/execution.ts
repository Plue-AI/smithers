/** Native step execution retains measured output and never promotes a proposal to a fact. */
import * as Budget from "@smthrs/agent/Budget"
import * as Digest from "@smthrs/core/Digest"
import { FlowRuntime } from "@smthrs/flow"
import type * as Evaluator from "@smthrs/model/Evaluator"
import { Effect, Layer, Option, Path, Schema } from "effect"
import { ModuleOwner } from "../../packages/smithers/src/internal/ModuleOwner.ts"
import {
  contained,
  type ImmutableSourceOptions,
  runSourceProcess,
  withImmutableSource
} from "../coding/immutable-source.ts"
import { normalizePath } from "../coding/planning-sources.ts"
import { CodingError } from "../coding/schema.ts"
import { ProposalStep } from "./changes.ts"
import { CheckStep, reviewCheck } from "./checks.ts"
import { captureCiPolicy, composeCiChecks, inheritsCiPolicy, revalidateCiPolicy } from "./ci-policy.ts"
import { sourceEvent } from "./events.ts"
import { captureRepository, currentExecutionId } from "./inspection.ts"
import { screenEvent } from "./intake.ts"
import { jevDuplicates } from "./jev-duplicates.ts"
import { jevReproduction } from "./jev-reproduction.ts"
import {
  ApproveStep,
  AwaitReply,
  CaptureFollowup,
  CaptureJob,
  CheckReply,
  ContinueAuthor,
  ExecuteRepro,
  FailedStep,
  FinishJob,
  Investigate,
  InvestigateStep,
  JevDuplicates,
  JevReproduction,
  type Observation,
  type ReproductionReview,
  retainedStepError,
  RetainObservation,
  RetainReproductionReview,
  RunSteps,
  ValidateReply,
  type Work
} from "./jobs.ts"
import { RepositoryRemote } from "./remote.ts"
import { PublishReply } from "./replies.ts"
import { ensureSource } from "./retention.ts"
import { Event, type IntakeScreening, type JobInput, type StepResult } from "./schema.ts"
import { admitSourcePath } from "./source.ts"

const invalid = (message: string) => new CodingError({ code: "invalid_receipt", message })
const allowedReferences = (work: typeof Work.Type) =>
  new Set([
    ...work.evidence.files.map((file) => file.path),
    ...work.evidence.records.map((record) => record.url).filter(Boolean)
  ])
export const verifyObservation = (work: typeof Work.Type, observation: typeof Observation.Type) => {
  const refs = allowedReferences(work)
  if (observation.citations.some((reference) => !refs.has(reference))) {
    throw invalid("A model cited source that this execution did not read")
  }
  if (
    observation.duplicates.some((candidate) =>
      !work.evidence.records.some((record) =>
        record.source === candidate.source && record.number === candidate.number && record.kind === "issue"
      )
    )
  ) {
    throw invalid("A proposed duplicate was not present in the captured issue history")
  }
}
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
const json = (value: unknown): Schema.Json => JSON.parse(JSON.stringify(value))
/** An unknown first model call reserves the approved run's entire allowance.
 * Wait for a real positive measurement before starting concurrent children.
 * The native owner binds this read to the same durable account as each child. */
export const runIndependentSteps = <A, B, E, R>(
  steps: ReadonlyArray<A>,
  execute: (step: A) => Effect.Effect<B, E, R>
) =>
  Effect.gen(function*() {
    const budget = yield* Effect.serviceOption(Budget.Budget)
    const owner = yield* Effect.serviceOption(ModuleOwner)
    const usage = Option.isSome(budget) ?
      Option.isSome(owner) ? budget.value.usageOf(owner.value.rootId) : budget.value.usage
      : Effect.succeed({ tokens: 0, calls: 0, largestCall: 0 })
    const completed: Array<B> = []
    let cursor = 0
    while (cursor < steps.length && (yield* usage).largestCall === 0) {
      completed.push(yield* execute(steps[cursor++]!))
    }
    return [...completed, ...(yield* Effect.forEach(steps.slice(cursor), execute, { concurrency: 3 }))]
  })
// Plue's push rule carries no ref filter, so a registered chore would otherwise
// start on every branch and tag. Only the repository's own default branch may.
const defaultBranchPush = (event: typeof Event.Type) => {
  const payload = object(event.payload), branch = object(payload.repository).default_branch
  return typeof branch === "string" && branch !== "" && payload.ref === `refs/heads/${branch}`
}
// Plue's rule filter is not the only authority. A chore starts on the event its
// own draft chose, on its schedule, or by a manual dispatch or a trial.
const choreEventStarts = (configuration: JobInput["configuration"], event: typeof Event.Type) =>
  event.type === "push" ?
    configuration.choreEvent === "push" && defaultBranchPush(event)
    : event.type === "issues" ?
    configuration.choreEvent === "labeled" && event.action === "labeled"
    : event.type === "schedule" || event.type === "manual"
export const selectedSteps = (
  input: Pick<JobInput, "job" | "configuration" | "event">,
  intake?: typeof IntakeScreening.Type | undefined
) => {
  // An event the intake screen dropped ends this job exactly where an
  // already-ignored one does: no step is selected, so no model is asked.
  if (intake?.action === "ignored" || sourceEvent(input.event).ignored) return []
  if (
    input.job === "chores" && input.event.trial !== true && input.event.manualStep === undefined &&
    !choreEventStarts(input.configuration, input.event)
  ) return []
  const manualStep = input.event.manualStep
  if (
    manualStep !== undefined && (input.event.type !== "manual" || input.event.action !== `manual:${manualStep}` ||
      !input.configuration.steps.some((step) => step.id === manualStep && step.mode !== "off"))
  ) throw invalid("The manual event does not select an enabled step")
  const core = { review: "review", ci: "checks", feature: "feature", chores: "chore" } as const
  return input.configuration.steps.filter((step) => {
    // Only the dispatcher may attach manualStep; neither an issue body nor an
    // action string can start a privileged manual action.
    if (manualStep !== undefined) return step.id === manualStep && step.mode !== "off"
    if (input.event.trial === true && input.job !== "issues") return step.id === core[input.job] && step.mode !== "off"
    // Ordinary feature work answers the issue lifecycle its step mode
    // registered, never a comment or a fabricated action string.
    if (input.job === "feature" && input.event.type !== "issues") return false
    // An issue setup trial exercises automatic handling. Deliberately manual
    // fixes, POCs and splitting remain available through their own run action.
    return step.mode === "automatic" || step.mode === "approved"
  })
}
export const assessReproduction = (
  work: typeof Work.Type,
  observation: typeof Observation.Type,
  measured: typeof StepResult.Type,
  review: typeof ReproductionReview.Type,
  executionId: string
): typeof StepResult.Type => {
  const output = object(measured.output), repro = observation.reproduction
  if (
    !repro || measured.stepId !== work.step.id || object(output.source).commitId !== work.evidence.source.commitId ||
    JSON.stringify(output.fixture) !== JSON.stringify(repro.files) ||
    JSON.stringify(output.argv) !== JSON.stringify(repro.argv)
  ) {
    throw invalid("The reproduction review does not match its measured execution")
  }
  const source = new Map(work.evidence.files.map((file) => [file.path, file]))
  const fixtures = new Map(repro.files.map((file) => [file.path, file]))
  if (review.citations.some((path) => !source.has(path) && !fixtures.has(path))) {
    throw invalid("The reproduction reviewer cited unread source")
  }
  const observedFailure = output.status === "failure-observed" && typeof output.exitCode === "number" &&
    output.exitCode !== 0 &&
    `${String(output.stdout)}\n${String(output.stderr)}`.includes(repro.failureContains)
  const demonstrated = observedFailure && output.truncated === false && review.verdict === "demonstrates" &&
    review.citations.some((path) => source.has(path) && !source.get(path)!.truncated)
  const negative = !observedFailure && review.verdict === "unrelated"
  return {
    ...measured,
    status: demonstrated || negative ? "completed" : "needs-maintainer",
    summary: demonstrated ? "Reproduced" : review.summary,
    executionId,
    evidence: [
      ...measured.evidence,
      `execution:${executionId}`,
      ...review.citations.map((path) =>
        source.has(path)
          ? `source:${path}@${source.get(path)!.digest}` :
          `fixture:${path}@${Digest.digest(fixtures.get(path)!.content)}`
      )
    ],
    output: json({
      ...output,
      status: demonstrated ? "reproduced" : negative ? "not-reproduced" : "needs-review",
      review
    })
  }
}
const result = (
  work: typeof Work.Type,
  observation: typeof Observation.Type,
  executionId: string
): typeof StepResult.Type => ({
  stepId: work.step.id,
  // Every observation carries the screen's own classification, so there is no
  // "the model could not tell" escalation left to make here.
  status: observation.question.trim() ? "needs-author" : "completed",
  summary: observation.summary,
  evidence: observation.citations.map((reference) => {
    const file = work.evidence.files.find((file) => file.path === reference)
    return file ? `source:${file.path}@${file.digest}` : reference
  }),
  output: json(observation),
  executionId
})
export const captureJobSource = (options: ImmutableSourceOptions, input: typeof CaptureJob.payloadSchema.Type) =>
  Effect.gen(function*() {
    const normalized = yield* Effect.try({
      try: () => sourceEvent(input.event),
      catch: (error) => error instanceof CodingError ? error : invalid("Invalid source event")
    })
    const payload = object(normalized.payload), pr = object(payload.pull_request), head = object(pr.head)
    const available = yield* Effect.serviceOption(RepositoryRemote)
    const needsPR = input.job === "review" ||
      (input.job === "ci" &&
        (input.event.manualStep !== undefined || input.event.trial === true || input.event.type === "pull_request"))
    const review = needsPR && Option.isSome(available) && available.value.resolveReview
      ? yield* available.value.resolveReview(input.event) :
      undefined
    if (needsPR && !review && !(input.event.type === "pull_request" && typeof head.sha === "string")) {
      return yield* invalid("Select the actual PR and immutable candidate for review")
    }
    const sourceRevision = review?.sourceRevision ?? normalized.sourceRevision ??
      (typeof head.sha === "string" ? head.sha : undefined)
    if (sourceRevision !== undefined) {
      yield* ensureSource(options, input.event, review?.payload ?? normalized.payload, yield* currentExecutionId)
    }
    // The one place the event's own untrusted text becomes model evidence.
    // Jev reads it here, before any prompt is built, and what it withholds is
    // replaced for source selection and for every Work this evidence carries.
    const screened = yield* screenEvent({
      repo: input.repo,
      event: input.event,
      payload: review?.payload ?? normalized.payload
    })
    const evidence = yield* captureRepository(
      options,
      {
        repo: input.repo,
        prompt: JSON.stringify(screened.payload),
        ...(sourceRevision === undefined ? {} : { sourceRevision })
      },
      selectedSteps(input, screened.screening).some((step) => ["fix", "feature", "chore"].includes(step.id))
        ? "immutable"
        : "snapshot"
    )
    return { ...evidence, subject: screened.payload, intake: screened.screening }
  }).pipe(
    Effect.timeoutOrElse({
      duration: Math.max(1, (input.deadlineAt ?? Date.now() + input.configuration.budgetMinutes * 60_000) - Date.now()),
      orElse: () =>
        Effect.fail(
          new CodingError({
            code: "source_unavailable",
            message: "Source capture reached this job's configured deadline"
          })
        )
    })
  )
/** Every composition must supply its judge. Omitting it is a type error;
 * an offline fixture supplies an evidence-based script, never a gateway key. */
export const executionLayers = (
  options: ImmutableSourceOptions & { readonly evaluator: Layer.Layer<Evaluator.Evaluator> }
) =>
  Layer.mergeAll(
    CaptureJob.toLayer((input) => captureJobSource(options, input)),
    JevDuplicates.toLayer(({ work, classification }) => jevDuplicates(work, classification)).pipe(
      Layer.provide(options.evaluator)
    ),
    JevReproduction.toLayer(({ work, observation, result }) => jevReproduction(work, observation, result.output)).pipe(
      Layer.provide(options.evaluator)
    ),
    RetainObservation.toLayer(({ work, observation }) =>
      Effect.gen(function*() {
        yield* Effect.try({
          try: () => verifyObservation(work, observation),
          catch: (error) => error instanceof CodingError ? error : invalid("Invalid step evidence")
        })
        return result(work, observation, yield* currentExecutionId)
      })
    ),
    ExecuteRepro.toLayer(({ work, observation }) =>
      Effect.gen(function*() {
        yield* Effect.try({
          try: () => verifyObservation(work, observation),
          catch: (error) => error instanceof CodingError ? error : invalid("Invalid reproduction evidence")
        })
        const repro = observation.reproduction
        if (!repro || observation.classification !== "bug" || observation.question.trim()) {
          return yield* invalid("A reproduction needs a bug report with sufficient input")
        }
        const remaining = work.deadlineAt - Date.now()
        if (remaining <= 0) return yield* invalid("The configured job deadline expired before reproduction")
        const fs = options.fs, path = yield* Path.Path
        if (
          repro.files.some((file) => normalizePath(file.path) !== file.path) || path.isAbsolute(repro.cwd) ||
          repro.cwd.split(/[\\/]/).includes("..")
        ) {
          return yield* invalid("Reproduction files and cwd must remain inside the isolated source tree")
        }
        const executionId = yield* currentExecutionId
        return yield* withImmutableSource(options, work.evidence.source, (_tree, root) =>
          Effect.gen(function*() {
            for (const file of repro.files) {
              const target = yield* admitSourcePath(options, root, file.path)
              yield* fs.makeDirectory(path.dirname(target), { recursive: true })
              const parent = yield* fs.realPath(path.dirname(target))
              if (!contained(root, parent, path)) return yield* invalid("Reproduction fixture escaped isolated source")
              if (yield* fs.exists(target)) {
                return yield* invalid("A reproduction fixture cannot overwrite existing source")
              }
              yield* fs.writeFileString(target, file.content, { flag: "wx" })
            }
            const cwd = yield* fs.realPath(path.resolve(root, repro.cwd || "."))
            if (!contained(root, cwd, path)) return yield* invalid("Reproduction cwd escaped isolated source")
            const measured = yield* runSourceProcess(options, repro.argv, cwd, Math.min(repro.timeoutMs, remaining))
            const combined = `${measured.stdout.text}\n${measured.stderr.text}`
            const reproduced = measured.exitCode !== 0 && combined.includes(repro.failureContains)
            return {
              stepId: work.step.id,
              status: "completed" as const,
              summary: reproduced ? "Observed failure" : "Not reproduced",
              evidence: [`execution:${executionId}`, `source:${work.evidence.source.commitId}`],
              executionId,
              output: json({
                status: reproduced ? "failure-observed" : "not-reproduced",
                source: work.evidence.source,
                fixture: repro.files,
                argv: repro.argv,
                cwd: repro.cwd,
                expected: repro.expected,
                exitCode: measured.exitCode,
                stdout: measured.stdout.text,
                stderr: measured.stderr.text,
                truncated: measured.stdout.truncated || measured.stderr.truncated
              })
            }
          }))
      }).pipe(Effect.mapError((error) =>
        error instanceof CodingError
          ? error
          : new CodingError({
            code: "execution",
            message: "Reproduction could not execute; inspect the maintainer run"
          })
      ))
    ),
    RetainReproductionReview.toLayer(({ work, observation, result, review }) =>
      currentExecutionId.pipe(Effect.flatMap((id) =>
        Effect.try({
          try: () => assessReproduction(work, observation, result, review, id),
          catch: (error) =>
            error instanceof CodingError ? error : invalid("The reproduction review could not be verified")
        })
      ))
    ),
    RunSteps.toLayer(({ input: job, evidence, deadlineAt, evaluation }) =>
      Effect.gen(function*() {
        const runtime = yield* FlowRuntime.FlowRuntime, instance = yield* FlowRuntime.FlowInstance
        const ids = job.configuration.steps.map((step) => step.id)
        if (new Set(ids).size !== ids.length || ids.some((id) => !/^[a-zA-Z0-9_-]+$/.test(id))) {
          return yield* invalid("Configured steps need unique safe IDs")
        }
        const selected = yield* Effect.try({
          try: () => selectedSteps(job, evidence.intake),
          catch: (error) => error instanceof CodingError ? error : invalid("Invalid step selection")
        })
        // The reviewed CI policy is read once for this job, pinned into every Work
        // it produces, and composed under reserved ids a local check cannot take.
        const inherits = inheritsCiPolicy(job, selected, evaluation === true)
        const policy = inherits ? yield* captureCiPolicy(job.repo) : { kind: "none" as const }
        const composed = yield* Effect.try({
          try: () => composeCiChecks(job.configuration.checks, policy),
          catch: (error) =>
            error instanceof CodingError ? error : invalid("The reviewed CI checks could not be composed")
        })
        const recheck = inherits ? revalidateCiPolicy(job.repo, policy) : Effect.void
        const input = { ...job, configuration: { ...job.configuration, checks: composed } }
        const execute = (step: typeof input.configuration.steps[number]) =>
          Effect.gen(function*() {
            const executionId = Digest.digest(
              Digest.canonical([
                "repository/step/v1",
                instance.executionId,
                input.digest,
                input.event.deliveryKey,
                step.id
              ])
            )
            const work = {
              repo: input.repo,
              job: input.job,
              event: { ...input.event, payload: evidence.subject ?? input.event.payload },
              step,
              evidence,
              deadlineAt,
              policy,
              checks: input.configuration.checks,
              landing: input.configuration.landing,
              replies: input.configuration.replies,
              executionMode: evaluation
                ? "evaluation" as const
                : input.event.trial
                ? "trial" as const
                : "live" as const,
              // The screen's answers ride along. `kind` is the authority for every
              // Observation.classification this step produces, so a step that needs
              // one and finds none here refuses instead of asking a seat.
              ...(evidence.intake?.kind === undefined || evidence.intake.urgency === undefined ?
                {}
                : { intake: { kind: evidence.intake.kind, urgency: evidence.intake.urgency } })
            }
            const subject = object(object(work.event.payload).issue)
            const performed = Effect.gen(function*() {
              if (
                step.mode === "approved" && !evaluation &&
                !(yield* runtime.execute(ApproveStep, {
                  executionId: `${executionId}-approval`,
                  payload: {
                    name: step.name,
                    prompt: step.prompt,
                    repo: input.repo,
                    sourceRevision: evidence.source.commitId,
                    ...(input.event.issueNumber === undefined ? {} : { issueNumber: input.event.issueNumber }),
                    ...(typeof subject.title === "string" ? { issueTitle: subject.title } : {})
                  }
                }))
              ) {
                return yield* invalid("The selected step was not approved")
              }
              if (step.id === "checks") return yield* runtime.execute(CheckStep, { executionId, payload: { work } })
              if (input.job === "review") {
                return yield* runtime.execute(CheckStep, {
                  executionId,
                  payload: { work: { ...work, checks: [reviewCheck(step), ...work.checks] } }
                })
              }
              if (["poc", "fix", "split", "feature", "chore"].includes(step.id)) {
                return yield* runtime.execute(ProposalStep, { executionId, payload: { work } })
              }
              if (
                !["research", "duplicates", "reproduce", "review", "followup"].includes(step.id)
              ) return yield* invalid("This configured step has no repository execution adapter")
              return yield* runtime.execute(InvestigateStep, { executionId, payload: { work } })
            })
            return yield* performed.pipe(
              Effect.catch((error) =>
                runtime.execute(FailedStep, {
                  executionId: `${executionId}-failure`,
                  payload: { stepId: step.id, error: retainedStepError(error) }
                })
              )
            )
          })
        const mutates = (step: typeof input.configuration.steps[number]) =>
          ["fix", "feature", "chore"].includes(step.id)
        const parallel = yield* runIndependentSteps(selected.filter((step) => !mutates(step)), execute)
        const serial = yield* Effect.forEach(
          selected.filter(mutates),
          (step) => recheck.pipe(Effect.andThen(execute(step))),
          { concurrency: 1 }
        )
        const values = new Map([...parallel, ...serial].map((value) => [value.stepId, value]))
        return Object.fromEntries(selected.map((step) => [step.id, values.get(step.id)!]))
      }).pipe(
        Effect.mapError((error) =>
          error instanceof CodingError ? error : invalid("The configured step graph could not complete")
        )
      )
    ),
    FinishJob.toLayer(({ input, evidence, results, deadlineAt }) =>
      Effect.gen(function*() {
        if (Date.now() >= deadlineAt) return yield* invalid("This repository job reached its configured time limit")
        const values = Object.values(results)
        const status = values.length === 0 ? "skipped" : values.some((value) => value.status === "error") ?
          "partial"
          : values.some((value) => value.status === "needs-author") ?
          "needs-author"
          : values.some((value) => value.status === "needs-maintainer")
          ? "needs-maintainer"
          : "completed"
        return {
          repo: input.repo,
          job: input.job,
          revision: input.revision,
          digest: input.digest,
          sourceRevision: evidence.source.commitId,
          eventKey: input.event.deliveryKey,
          status,
          results: values,
          publicActions: []
        }
      })
    ),
    ValidateReply.toLayer(({ input, reply, previous }) =>
      Effect.gen(function*() {
        const decoded = Schema.decodeUnknownOption(Event)(reply)
        if (Option.isNone(decoded)) return null
        const event = decoded.value
        if (
          event.source !== input.event.source || event.issueNumber !== input.event.issueNumber ||
          event.type !== "issue_comment" || event.action !== "created"
        ) {
          return null
        }
        const payload = object(event.payload), original = object(input.event.payload)
        const comment = object(payload.comment)
        // The backend decides whether a comment is a maintainer's own text (its
        // author and its last writer are maintainer people) and stamps it; a
        // run credential or chat sync writes as the owner's user id, so neither
        // the author's identity nor GitHub's author_association is trust.
        if (
          comment.smithers_text_by_maintainer !== true ||
          previous.publicActions.some((action) => object(action).comment_id === comment.id)
        ) {
          return null
        }
        const replies = Array.isArray(original.authorReplies) ? original.authorReplies : []
        if (replies.some((prior) => object(prior).id === comment.id)) return null
        return {
          ...input,
          event: {
            ...event,
            ...(input.event.manualStep === undefined ? {} : {
              type: "manual",
              action: `manual:${input.event.manualStep}`,
              manualStep: input.event.manualStep
            }),
            payload: json({ ...original, authorReplies: [...replies, comment] })
          }
        }
      })
    ),
    ContinueAuthor.toLayer(({ input, result, deadlineAt }) =>
      Effect.gen(function*() {
        const runtime = yield* FlowRuntime.FlowRuntime, instance = yield* FlowRuntime.FlowInstance
        let current = input, previous = result
        for (let attempt = 0; attempt < 32 && previous.status === "needs-author"; attempt++) {
          const key = Digest.digest(Digest.canonical(["repository/author/v1", instance.executionId, attempt]))
          // The journaled wait already settled the deadline; a fresh clock reading here
          // discarded every round after the first on any replay past it.
          const reply = yield* runtime.execute(AwaitReply, { executionId: `${key}-wait`, payload: { deadlineAt } })
          if (reply === null) {
            return { ...previous, eventKey: input.event.deliveryKey, status: "needs-maintainer" as const }
          }
          const updated = yield* runtime.execute(CheckReply, {
            executionId: `${key}-validate`,
            payload: { input: current, reply, previous }
          })
          if (updated === null) {
            continue
          }
          current = updated
          const evidence = yield* runtime.execute(CaptureFollowup, {
            executionId: `${key}-capture`,
            payload: { ...current, deadlineAt }
          })
          const investigated = yield* runtime.execute(Investigate, {
            executionId: `${key}-investigate`,
            payload: { input: current, evidence, deadlineAt }
          })
          const published = yield* runtime.execute(PublishReply, {
            executionId: `${key}-reply`,
            payload: { input: current, result: investigated, deadlineAt }
          })
          previous = { ...published, publicActions: [...previous.publicActions, ...published.publicActions] }
        }
        return {
          ...previous,
          eventKey: input.event.deliveryKey,
          status: previous.status === "needs-author" ? "needs-maintainer" as const : previous.status
        }
      }).pipe(
        Effect.mapError((error) =>
          error instanceof CodingError ? error : invalid("The author continuation did not retain its result")
        )
      )
    )
  )
