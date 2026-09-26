/** Repository jobs use the same editable setup contract as the app and Worker. */
import * as Digest from "@smthrs/core/Digest"
import { Effect, Schema } from "effect"
import { SetupHostInputSchema, storedSetupCandidate } from "../../packages/rpc/src/RepositorySetup.ts"
import { Source } from "../coding/planning-sources.ts"
import { Revision } from "../coding/schema.ts"

const text = (maximum: number) => Schema.String.check(Schema.isMaxLength(maximum))
export const Job = Schema.Literals(["issues", "review", "ci", "feature", "chores"])
export const Step = Schema.Struct({
  id: text(100),
  name: text(120),
  mode: Schema.Literals(["automatic", "manual", "off", "approved"]),
  prompt: text(16000)
})
export const Check = Schema.Struct({
  id: text(100),
  name: text(120),
  kind: Schema.Literals(["command", "ai"]),
  rule: text(16000),
  paths: Schema.Array(text(500)).check(Schema.isMaxLength(100)),
  policy: Schema.Literals(["report", "required"])
})
/** `edited` marks a case the maintainer wrote or changed, so its pin is theirs.
 * Every other case belongs to the inspection that authored it, which re-pins it. */
export const EvalCase = Schema.Struct({
  id: text(100),
  name: text(160),
  input: text(16000),
  expected: Schema.NonEmptyString.check(Schema.isMaxLength(8000)),
  source: Schema.optionalKey(text(1000)),
  edited: Schema.optionalKey(Schema.Boolean),
  required: Schema.Boolean
})
export const Draft = Schema.Struct({
  steps: Schema.Array(Step).check(Schema.isMaxLength(30)),
  checks: Schema.Array(Check).check(Schema.isMaxLength(50)),
  cases: Schema.Array(EvalCase).check(Schema.isMaxLength(100)),
  replies: Schema.Literals(["draft", "automatic"]),
  landing: Schema.Literals(["ask", "checks"]),
  scope: Schema.Literals(["future", "label"]),
  label: text(100),
  schedule: text(200),
  choreEvent: Schema.Literals(["none", "push", "labeled"]).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("none" as const))
  ),
  budgetMinutes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 120 })),
  connectIssues: Schema.Boolean,
  trialTitle: text(240),
  trialBody: text(16000)
})
export type Draft = typeof Draft.Type
export const Proposal = Schema.Array(
  Schema.Struct({
    path: text(1000),
    beforeDigest: Schema.NullOr(Schema.String),
    content: Schema.NullOr(Schema.String.check(Schema.isMaxLength(65536)))
  })
).check(Schema.isMaxLength(30))
export const Operation = Schema.Literals(["inspect", "evaluate", "trial", "apply", "pause", "run"])
export const Manual = Schema.Struct({
  stepId: text(100),
  prompt: text(16000),
  subject: Schema.optionalKey(
    Schema.Struct({
      source: Schema.Literals(["github", "smithers-cloud"]),
      kind: Schema.Literals(["issue", "pr"]),
      number: Schema.Int.check(Schema.isGreaterThan(0))
    })
  )
})
export const SetupInput = Schema.Struct({
  requestId: Schema.String,
  repo: Schema.String,
  job: Job,
  operation: Operation,
  revision: Schema.Int,
  digest: Schema.String,
  draft: Draft,
  workspaceId: Schema.optionalKey(Schema.String),
  manual: Schema.optionalKey(Manual)
}).check(
  Schema.makeFilter((value) =>
    SetupHostInputSchema.safeParse(value).success || "Invalid setup input or candidate digest"
  )
)
export type SetupInput = typeof SetupInput.Type
export const Event = Schema.Struct({
  source: Schema.Literals(["github", "smithers-cloud", "schedule"]),
  type: Schema.NonEmptyString,
  action: Schema.String,
  deliveryKey: Schema.NonEmptyString,
  issueNumber: Schema.optionalKey(Schema.Int),
  trial: Schema.optionalKey(Schema.Boolean),
  manualStep: Schema.optionalKey(text(100)),
  payload: Schema.Json
})
export const JobInput = Schema.Struct({
  repo: Schema.NonEmptyString,
  job: Job,
  revision: Schema.Int.check(Schema.isGreaterThan(0)),
  digest: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  sourceRevision: Schema.NonEmptyString,
  configuration: Draft,
  event: Event
}).check(
  Schema.makeFilter((value) =>
    storedSetupCandidate({ ...value, draft: JSON.parse(JSON.stringify(value.configuration)) }, value.digest) ||
    "The job candidate changed"
  )
)
export type JobInput = typeof JobInput.Type
export const Record = Schema.Struct({
  source: Schema.Literals(["github", "smithers-cloud"]),
  kind: Schema.Literals(["issue", "pr"]),
  number: Schema.Int,
  title: text(1000),
  body: text(16000),
  state: Schema.String,
  url: Schema.String,
  revision: Schema.optionalKey(Schema.String)
})
export const SourceStatus = Schema.Struct({
  path: Schema.String,
  status: Schema.Literals(["read", "missing", "failed"]),
  summary: Schema.String,
  revision: Schema.optionalKey(Schema.String)
})
/** What the intake screen decides about one inbound event, before a frontier
 * model reads a word of it. `kind` is deliberately its own vocabulary and not
 * `Observation.classification`: this is a decision-only model's answer about
 * the raw event, not an investigation's finding about the request. */
export const IntakeKind = Schema.Literals(["bug", "feature", "question", "spam", "irrelevant"])
export const IntakeUrgency = Schema.Literals(["low", "medium", "high"])
export const IntakeAnswers = Schema.Struct({ kind: IntakeKind, urgency: IntakeUrgency })
const unitInterval = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }))
export const IntakeAnswer = Schema.Struct({
  /** Which text of the event this answers: `issue`, `pull_request`, `comment` or `authorReplies.<n>`. */
  id: text(100),
  kind: IntakeKind,
  kindConfidence: unitInterval,
  urgency: IntakeUrgency,
  urgencyConfidence: unitInterval,
  /** How probable it is that this text carries instructions aimed at an AI agent. */
  injection: unitInterval,
  withheld: Schema.Boolean
})
export const IntakeScreening = Schema.Struct({
  /** `proceed`, `ignored`, `withheld:<n>` for the number of texts replaced by
   * the placeholder, or `failed` when Jev could not answer and the job stops. */
  action: text(100),
  answers: Schema.Array(IntakeAnswer).check(Schema.isMaxLength(64)),
  kind: Schema.optionalKey(IntakeKind),
  urgency: Schema.optionalKey(IntakeUrgency),
  /** Why the screen failed: the evaluator's own failure code and message, per unanswered text. */
  reason: Schema.optionalKey(text(400))
})
export const RepositoryEvidence = Schema.Struct({
  repo: Schema.NonEmptyString,
  source: Revision,
  files: Schema.Array(Source),
  missing: Schema.Array(Schema.String),
  history: Schema.Array(Schema.Struct({ commitId: Schema.String, description: Schema.String })),
  records: Schema.Array(Record).check(Schema.isMaxLength(120)),
  sources: Schema.Array(SourceStatus),
  subject: Schema.optionalKey(Schema.Json),
  intake: Schema.optionalKey(IntakeScreening)
})
export type RepositoryEvidence = typeof RepositoryEvidence.Type
export const StepResult = Schema.Struct({
  stepId: Schema.String,
  status: Schema.Literals(["completed", "needs-author", "needs-maintainer", "skipped", "error"]),
  summary: Schema.String,
  evidence: Schema.Array(Schema.String),
  output: Schema.Json,
  executionId: Schema.NonEmptyString
})
export const Reply = Schema.Struct({
  body: text(16000),
  issueNumber: Schema.Int,
  state: Schema.Literals(["drafted", "posted", "declined", "undeliverable"]),
  reason: Schema.optionalKey(text(400))
})
export type Reply = typeof Reply.Type
export const JobResult = Schema.Struct({
  repo: Schema.String,
  job: Job,
  revision: Schema.Int,
  digest: Schema.String,
  sourceRevision: Schema.String,
  eventKey: Schema.String,
  status: Schema.Literals(["completed", "partial", "needs-author", "needs-maintainer", "skipped", "error"]),
  results: Schema.Array(StepResult),
  publicActions: Schema.Array(Schema.Json),
  reply: Schema.optionalKey(Reply)
})
export type JobResult = typeof JobResult.Type
export const EvalResult = Schema.Struct({
  caseId: Schema.String,
  status: Schema.Literals(["passed", "failed", "review", "error"]),
  observed: Schema.String,
  evidence: Schema.Array(Schema.String),
  executionId: Schema.NonEmptyString
})
export const Receipt = Schema.Struct({
  requestId: Schema.String,
  runId: Schema.String,
  revision: Schema.Int,
  operation: Operation,
  phase: Schema.Literals(["queued", "running", "waiting", "completed", "failed", "stopped"]),
  digest: Schema.String,
  updatedAt: Schema.Number,
  results: Schema.Array(EvalResult),
  evidence: Schema.Array(Schema.String),
  error: Schema.optionalKey(Schema.String),
  trialIssue: Schema.optionalKey(
    Schema.Struct({
      source: Schema.Literals(["github", "smithers-cloud"]),
      number: Schema.Int,
      url: Schema.optionalKey(Schema.String)
    })
  ),
  registrationId: Schema.optionalKey(Schema.String),
  sourceRevision: Schema.optionalKey(Schema.String),
  jobRunId: Schema.optionalKey(Schema.String)
})
export const OperationResult = Schema.Struct({
  requestId: Schema.String,
  revision: Schema.Int,
  digest: Schema.String,
  receipt: Schema.optionalKey(Receipt),
  inspection: Schema.optionalKey(
    Schema.Struct({ sources: Schema.Array(SourceStatus), suggestedDraft: Draft, inspectedAt: Schema.Number })
  )
})
/** One repository's own name for one schedule. Never the flow id: a repository
 * may register the same flow under two slugs with different inputs. */
export const FlowSlug = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,63}$/))
export const CronUtc = Schema.String.check(Schema.isMaxLength(200))
/** What every unattended fire of one schedule may spend. Smithers Cloud stores
 * it on the registration and refuses one whose envelope names no finite pair
 * (`validateRepositoryJob`), so a registration states it rather than inheriting
 * whatever ceiling the scheduled flow happened to declare for itself. */
export const TriggerBudget = Schema.Struct({ tokens: Schema.Int, milliseconds: Schema.Int })
/** What the app sends the registrar. The approval fields carry the plan a
 * person approved; nothing here names who approved it or when. */
export const TriggerRequest = Schema.Struct({
  requestId: Schema.optionalKey(Schema.NonEmptyString.check(Schema.isMaxLength(200))),
  repo: Schema.NonEmptyString,
  slug: FlowSlug,
  flow: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9_./-]{0,199}$/)),
  schedule: CronUtc,
  input: Schema.Json,
  workspaceId: Schema.optionalKey(Schema.String),
  budget: Schema.optionalKey(TriggerBudget),
  approvedPlanId: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
  approvedPlanDigest: Schema.optionalKey(Schema.String),
  /** A completed run of that exact plan, when the caller made one first. */
  testRunId: Schema.optionalKey(Schema.String),
  operation: Schema.Literals(["register", "fire", "resume"]),
  /** Resume must not overwrite a registration changed after its recovery read. */
  expectedRevision: Schema.optionalKey(Schema.Int)
})
export type TriggerRequest = typeof TriggerRequest.Type
export const TriggerRegistration = Schema.Struct({
  registration_id: Schema.String,
  revision: Schema.Int,
  digest: Schema.String,
  source_revision: Schema.String,
  mode: Schema.Literal("enabled"),
  enabled: Schema.Boolean,
  schedule: CronUtc,
  next_fire_at: Schema.NullOr(Schema.String),
  timezone: Schema.Literal("UTC")
})
export const TriggerResult = Schema.Struct({
  requestId: Schema.String,
  slug: FlowSlug,
  flow: Schema.String,
  planId: Schema.String,
  planDigest: Schema.String,
  executionDigest: Schema.String,
  envelope: Schema.Json,
  sourceRevision: Schema.String,
  testRunId: Schema.optionalKey(Schema.String),
  registration: TriggerRegistration
})
/** 64-hex over the canonical request; Plue requires ^[a-f0-9]{64}$ for `digest`. */
export const triggerCandidate = (request: TriggerRequest): string =>
  Digest.digest(
    Digest.canonical({
      repo: request.repo,
      slug: request.slug,
      flow: request.flow,
      schedule: request.schedule,
      input: request.input
    })
  )
