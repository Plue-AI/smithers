/** Automatic native replies use the dispatch-bound idempotent repository API. */
import * as Digest from "@smthrs/core/Digest"
import { Action, Flow, FlowRuntime, HumanTask, Interpreter } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Effect, Layer, Option, Schema } from "effect"
import { CodingError } from "../coding/schema.ts"
import { RepositoryRemote } from "./remote.ts"
import { JobInput, JobResult, Reply } from "./schema.ts"

const invalid = (message: string) => new CodingError({ code: "invalid_receipt", message })
const object = (value: Schema.Json): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
const CommentReceipt = Schema.Struct({
  registration_id: Schema.String,
  revision: Schema.Int,
  digest: Schema.String,
  delivery_key: Schema.String,
  step: Schema.String,
  source: Schema.Literal("smithers-cloud"),
  issue_number: Schema.Int,
  comment_id: Schema.Number,
  api_path: Schema.String
})
/** A cut between a surrogate pair is not well-formed text, and a prompt that
 * carries one cannot be asked, so the last whole character wins. */
const clip = (value: string, limit: number) => {
  if (value.length <= limit) return value
  const last = value.charCodeAt(limit - 1)
  return value.slice(0, last >= 0xd800 && last <= 0xdbff ? limit - 1 : limit)
}
/** One consolidated evidence-grounded draft per job run; this posts nothing. */
export const consolidatedReply = (input: JobInput, result: JobResult): JobResult => {
  const issueNumber = input.event.issueNumber
  if (input.job !== "issues" || !issueNumber || result.status === "skipped") return result
  const body = clip(
    result.results.filter((step) => step.status === "completed" || step.status === "needs-author")
      .map((step) =>
        `${input.configuration.steps.find((value) => value.id === step.stepId)?.name ?? step.stepId}\n${step.summary}${
          step.status === "needs-author" &&
            typeof object(step.output).question === "string" ?
            `\n${object(step.output).question}` :
            ""
        }`
      ).join("\n\n"),
    16000
  )
  if (!body.trim()) return result
  return {
    ...result,
    reply: input.event.source === "smithers-cloud" ?
      { body, issueNumber, state: "drafted" }
      : { body, issueNumber, state: "undeliverable", reason: "This release does not deliver replies to GitHub issues." }
  }
}
/** The publication step of one author round.
 *
 * A dispatch consolidates once per round, and the step is what plue keys a
 * comment by. The identity is the ROUND, never its text: two rounds can reach
 * the same words and are still two approved publications, which a content key
 * silently collapsed into one comment that both results called posted. The
 * round's execution id is durable - `ContinueAuthor` derives it from the
 * instance and the attempt (`flows/repository/execution.ts:212`), and a first
 * reply from the parent execution and payload - so a retry, a replay or a
 * restart of one round asks for the same step and plue returns that round's
 * receipt, while its body equality check under that step refuses a changed
 * body with HTTP 409. */
const publicationStep = (round: string) => `response-${Digest.digest(Digest.canonical(round)).slice(0, 12)}`
const post = (input: JobInput, result: JobResult, reply: Reply, round: string) =>
  Effect.gen(function*() {
    const remote = yield* Effect.serviceOption(RepositoryRemote)
    if (Option.isNone(remote) || !remote.value.comment || remote.value.repo !== input.repo) {
      return yield* invalid("The repository has no idempotent reply adapter")
    }
    const step = publicationStep(round)
    const receipt = yield* remote.value.comment(input.job, step, {
      repo: input.repo,
      workspace_id: remote.value.workspaceId,
      revision: input.revision,
      digest: input.digest,
      delivery_key: input.event.deliveryKey,
      source: "smithers-cloud",
      issue_number: reply.issueNumber,
      body: reply.body
    }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(CommentReceipt)))
    if (
      receipt.revision !== input.revision || receipt.digest !== input.digest ||
      receipt.delivery_key !== input.event.deliveryKey ||
      receipt.step !== step || receipt.issue_number !== reply.issueNumber
    ) return yield* invalid("The public reply receipt belongs to another dispatch")
    return {
      ...result,
      reply: { ...reply, state: "posted" as const },
      publicActions: [...result.publicActions, JSON.parse(JSON.stringify(receipt))]
    }
  })
/** One journaled reading of the clock, so a replay asks the question with the
 * duration it was first armed with and never a fresh one. */
const RemainingBudget = Action.make("repository/reply-budget", {
  payload: { deadlineAt: Schema.Number },
  success: Schema.Int,
  error: Schema.Never,
  nondeterministic: true
})
/** The maintainer confirms the drafted text itself; no source text can answer it.
 * The question is bounded by what is LEFT of the job's own deadline, so a second
 * round cannot hold a sandbox past the budget the maintainer configured, and a
 * deadline already spent settles as a timeout without asking anyone. */
export const ConfirmReply = Flow.make("repository/ConfirmReply", {
  payload: { reply: Reply, deadlineAt: Schema.Number },
  success: Schema.Boolean,
  error: HumanTask.HumanTaskFailed,
  body: ({ reply, deadlineAt }) =>
    RemainingBudget.call({ deadlineAt }).pipe(Node.bindPlanned((timeoutMs) =>
      Node.succeed(reply).pipe(
        Node.map((value) => `Post this reply to issue #${value.issueNumber}?\n\n${value.body}`),
        Node.bindPlanned((prompt) =>
          HumanTask.action.call({ name: "repository-reply", kind: "confirm", prompt, maxAttempts: 1, timeoutMs })
        ),
        Node.map((answer) => answer === true)
      )
    ))
})
/** Nobody refused a question that was never answered: the draft is retained
 * with the reason, and a failure never reads as a maintainer's decision. */
const unanswered = (reply: Reply, error: unknown): Reply => ({
  ...reply,
  reason: error instanceof HumanTask.HumanTaskFailed && error.code === "timeout"
    ? "No decision before the job's time limit." :
    "The confirmation could not be asked."
})
const Publish = Action.make("repository/publish-reply", {
  payload: { input: JobInput, result: JobResult, deadlineAt: Schema.Number },
  success: JobResult,
  error: CodingError,
  nondeterministic: true
})
export const PublishReply = Flow.make("repository/PublishReply", {
  payload: Publish.payloadSchema,
  success: JobResult,
  error: CodingError,
  body: (input) => Publish.call(input)
})
export const replyLayers = Layer.mergeAll(
  Interpreter.layer(PublishReply),
  Interpreter.layer(ConfirmReply),
  RemainingBudget.toLayer(({ deadlineAt }) => Effect.sync(() => Math.max(0, deadlineAt - Date.now()))),
  Publish.toLayer(({ input, result, deadlineAt }) =>
    Effect.gen(function*() {
      const drafted = consolidatedReply(input, result), reply = drafted.reply
      if (reply === undefined || reply.state !== "drafted" || input.event.trial === true) return drafted
      const runtime = yield* FlowRuntime.FlowRuntime, instance = yield* FlowRuntime.FlowInstance
      if (input.configuration.replies === "automatic") return yield* post(input, drafted, reply, instance.executionId)
      const decision = yield* runtime.execute(ConfirmReply, {
        executionId: `${instance.executionId}-approval`,
        payload: { reply, deadlineAt }
      })
        .pipe(Effect.catch((error) => Effect.succeed(unanswered(reply, error))))
      if (decision === true) return yield* post(input, drafted, reply, instance.executionId)
      return { ...drafted, reply: decision === false ? { ...reply, state: "declined" as const } : decision }
    }).pipe(
      Effect.mapError((error) =>
        error instanceof CodingError
          ? error
          : invalid("The public reply could not be verified; retry the same dispatch")
      )
    )
  )
)
