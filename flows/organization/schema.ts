/**
 * What the organization flows share: the request a person makes, what the
 * host admits it as, and the host-implemented steps the flows call between
 * role tasks.
 *
 * Every trust decision is the host's. A request names only its text, where
 * it came from, and optionally a repository; the principals, the gate
 * policy, the checks, and the branch come from the host's loaded
 * configuration through {@link Admit}, and every principal a later step names
 * is re-resolved against the pinned roster by the step that names it.
 */
import * as AgentAction from "@smthrs/agent/AgentAction"
import { Action } from "@smthrs/flow"
import { Schema } from "effect"
import { IntegrationFailure } from "../../packages/smithers/agent/integrations/src/core/ActionFailure.ts"
import * as Actions from "../../packages/smithers/agent/organization/src/Actions.ts"
import * as Authority from "../../packages/smithers/agent/organization/src/Authority.ts"
import * as Gates from "../../packages/smithers/agent/organization/src/Gates.ts"
import * as Profile from "../../packages/smithers/agent/organization/src/Profile.ts"
import * as Prompt from "../../packages/smithers/agent/organization/src/Prompt.ts"
import * as Workspace from "../../packages/smithers/agent/organization/src/Workspace.ts"
import { Ref } from "./links.ts"

/** A request key: the durable deduplication key of one request, such as `slack:T1:Ev1` or `cli:<uuid>`. */
export const RequestKey = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/, { expected: "a request key" })
)

/** The Slack thread a request arrived in, which replies go to. */
export const Conversation = Schema.Struct({
  provider: Schema.Literal("slack"),
  channel: Schema.NonEmptyString,
  thread: Schema.NonEmptyString,
  /** The message itself, which the host reacts to; the thread's parent when absent. */
  message: Schema.optionalKey(Schema.NonEmptyString)
})
export type Conversation = typeof Conversation.Type

/** The GitHub issue a request works, and the claim it holds on it. */
export const IssueRef = Schema.Struct({
  /** The GitHub repository, `owner/name`. */
  github: Schema.NonEmptyString,
  number: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  url: Schema.NonEmptyString
})
export type IssueRef = typeof IssueRef.Type

/**
 * One request, as a channel received it: a person's (the local CLI or
 * Slack), or the organization's own (an issue it took, a routine, an
 * accepted proposal).
 */
export const Request = Schema.Struct({
  key: RequestKey,
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8_000)),
  source: Schema.Literals(["cli", "slack", "github", "routine", "proposal"]),
  /** The Slack user who wrote it; absent for the local CLI, whose caller holds the control credential. */
  user: Schema.optionalKey(Schema.NonEmptyString),
  conversation: Schema.optionalKey(Conversation),
  /** A configured repository name; the host's only repository when absent. */
  repository: Schema.optionalKey(Profile.Container),
  /** The role the host hands the request to, instead of the assistant routing it. Never from Slack. */
  role: Schema.optionalKey(Profile.PrincipalId),
  /** The issue the request works. Never from Slack. */
  issue: Schema.optionalKey(IssueRef)
})
export type Request = typeof Request.Type

/** What the host admitted a request as: everything a delivery needs that no requester may choose. */
export const Admission = Schema.Struct({
  assistant: Profile.PrincipalId,
  repository: Profile.Container,
  /** The commit-ish the workspace is seeded from; the host resolves it to a full id. */
  commit: Schema.NonEmptyString,
  /** The branch a landed change goes to. Never the repository's checked-out branch. */
  branch: Schema.NonEmptyString,
  checks: Schema.Array(Workspace.Check),
  gates: Gates.GatePolicy,
  maxRounds: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5 })),
  /** When the request was admitted; fixes the landed commit's timestamps. */
  at: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  /** A landed branch is pushed to `remote` and opened as a pull request on `github`. Absent: the branch stays local. */
  pull: Schema.optionalKey(Schema.Struct({ remote: Schema.NonEmptyString, github: Schema.NonEmptyString }))
})
export type Admission = typeof Admission.Type

/** Why the host refused a request before any role saw it. */
export class IntakeRefused extends Schema.TaggedError<IntakeRefused>()("organization/IntakeRefused", {
  reason: Schema.Literals(["not-owner", "unknown-repository", "no-repository", "host-only"]),
  message: Schema.String
}) {}

/** Admits a request under the host's configuration, or refuses it. Recorded, so a replay reads the admission. */
export const Admit = Action.make("organization/admit", {
  implementationVersion: "admit/v1",
  payload: { request: Request },
  success: Admission,
  error: IntakeRefused,
  nondeterministic: true
})

/** How a delivery ended. */
export const OutcomeStatus = Schema.Literals(["landed", "answered", "changes-requested", "blocked", "failed"])
export type OutcomeStatus = typeof OutcomeStatus.Type

/** The next role and the task it is given, or why the chain stops before it. */
export const Stage = Schema.Struct({
  proceed: Schema.Boolean,
  /** How the delivery ends when the chain stops here. */
  outcome: OutcomeStatus,
  /** Why the chain stops; empty when it proceeds. */
  reason: Schema.String,
  principal: Profile.PrincipalId,
  task: Profile.TaskContract,
  context: Schema.Array(Prompt.ContextEntry),
  /** Whether the principal works in the delivery's workspace machine. */
  workspace: Schema.optionalKey(Schema.Boolean)
})
export type Stage = typeof Stage.Type

/** A role's checked answer: the result, its charter check, and what the check found. */
export const Answer = Schema.Struct({
  principal: Profile.PrincipalId,
  result: Profile.RoleResult,
  valid: Schema.Boolean,
  violations: Schema.Array(Schema.String)
})
export type Answer = typeof Answer.Type

/**
 * The same stage asked again, once, after a `done` result broke the
 * principal's charter: the violations and the rejected result join its
 * context.
 */
export const CorrectTask = Action.make("organization/correct-task", {
  implementationVersion: "correct-task/v1",
  payload: { stage: Stage, result: Profile.RoleResult, validation: Actions.Validation },
  success: Stage
})

/**
 * The same task asked once more under an id of its own, with `reason` joining
 * its context: a builder whose turn left no change is asked again once.
 */
export const AgainTask = Action.make("organization/again-task", {
  implementationVersion: "again-task/v1",
  payload: { stage: Stage, reason: Schema.String },
  success: Stage
})

/** The assistant's routing task for a request. */
export const RouteTask = Action.make("organization/route-task", {
  implementationVersion: "route-task/v3",
  payload: { revision: Schema.NonEmptyString, assistant: Profile.PrincipalId, request: Request },
  success: Stage,
  error: Authority.DispatchRefused
})

/**
 * The task of the role the assistant routed a question to: answer it in
 * `fields.answer`, with no contract, workspace, or checks.
 */
export const AnswerTask = Action.make("organization/answer-task", {
  implementationVersion: "answer-task/v1",
  payload: { revision: Schema.NonEmptyString, request: Request, routed: Answer },
  success: Stage,
  error: Authority.DispatchRefused
})

/** The lead's contract task, for the role the assistant handed the request to. */
export const LeadTask = Action.make("organization/lead-task", {
  implementationVersion: "lead-task/v5",
  payload: { revision: Schema.NonEmptyString, request: Request, repository: Profile.Container, routed: Answer },
  success: Stage,
  error: Authority.DispatchRefused
})

/** Who builds and who checks, as the lead's contract names them, resolved against the pinned roster. */
export const Assignment = Schema.Struct({
  proceed: Schema.Boolean,
  reason: Schema.String,
  lead: Profile.PrincipalId,
  builder: Profile.PrincipalId,
  checker: Profile.PrincipalId,
  objective: Schema.String,
  acceptance: Schema.Array(Schema.String),
  /** The landed commit's message. */
  message: Schema.NonEmptyString,
  /** Whether the checker holds a workspace in the repository, to reproduce the change in. */
  checkerWorkspace: Schema.Boolean,
  /**
   * The lead's handoff to a specialist it hired (directly or below), run as
   * an `organization/delegate` child instead of a build; `null` for a build.
   */
  delegate: Schema.NullOr(Schema.Struct({
    key: RequestKey,
    parent: Profile.PrincipalId,
    specialist: Profile.PrincipalId,
    objective: Schema.String,
    inputs: Schema.Array(Schema.String),
    acceptance: Schema.Array(Schema.String)
  }))
})
export type Assignment = typeof Assignment.Type

/**
 * The host fields a role result may carry besides its charter's: asks the
 * host acts on, and a question's answer (`answer`) or its routing to the
 * role that knows (`question`).
 */
export const hostFields = ["hire", "meeting", "answer", "question"] as const

/**
 * What a result asks the host for: a hire (`fields.hire`: `{ need, task?,
 * acceptance? }`), extra time with the owner (`fields.meeting`: `{ purpose,
 * minutes }`), nothing, or a malformed ask and why.
 */
export const HostAsk = Schema.Struct({
  kind: Schema.Literals(["hire", "meeting", "none", "invalid"]),
  reason: Schema.String,
  hire: Schema.NullOr(Schema.Struct({
    key: RequestKey,
    parent: Profile.PrincipalId,
    need: Schema.String,
    task: Schema.optionalKey(Schema.String),
    acceptance: Schema.optionalKey(Schema.Array(Schema.String))
  })),
  meeting: Schema.NullOr(Schema.Struct({
    key: RequestKey,
    requestedBy: Profile.PrincipalId,
    purpose: Schema.String,
    minutes: Schema.Int
  }))
})
export type HostAsk = typeof HostAsk.Type

/** Reads a valid `done` answer's host fields into the child flow payload they ask for. */
export const ReadAsk = Action.make("organization/read-ask", {
  implementationVersion: "read-ask/v1",
  payload: { key: RequestKey, answer: Answer },
  success: HostAsk
})

/** Resolves the lead's contract into the builder and checker it names. */
export const Assign = Action.make("organization/assign", {
  implementationVersion: "assign/v4",
  payload: { revision: Schema.NonEmptyString, key: RequestKey, repository: Profile.Container, contract: Answer },
  success: Assignment,
  error: Authority.DispatchRefused
})

/** The builder's task for one round, with the checker's findings from the round before. */
export const BuildTask = Action.make("organization/build-task", {
  implementationVersion: "build-task/v2",
  payload: {
    request: Request,
    assignment: Assignment,
    workdir: Schema.NonEmptyString,
    round: Schema.Int,
    findings: Schema.Array(Schema.String)
  },
  success: Stage
})

/** The checker's task: the diff and the fresh-machine check receipts, as data. */
export const CheckTask = Action.make("organization/check-task", {
  implementationVersion: "check-task/v6",
  payload: {
    request: Request,
    assignment: Assignment,
    workdir: Schema.NonEmptyString,
    round: Schema.Int,
    build: Answer,
    diff: Workspace.Diff,
    checks: Workspace.Checks
  },
  success: Stage
})

/** What the checker decided about one round. */
/** One configured check as a receipt shows it: what ran, how it ended, and the end of its output. */
export const CheckSummary = Schema.Struct({
  name: Schema.String,
  exitCode: Schema.NullOr(Schema.Int),
  timedOut: Schema.Boolean,
  durationMs: Schema.Number,
  tail: Schema.String
})
export type CheckSummary = typeof CheckSummary.Type

export const Verdict = Schema.Struct({
  approved: Schema.Boolean,
  /** Why not, as lines the next round's builder reads. */
  findings: Schema.Array(Schema.String),
  /** The round's configured checks. */
  checks: Schema.Array(CheckSummary)
})
export type Verdict = typeof Verdict.Type

/** Reads the checker's answer and the check receipts into a verdict. Only a valid `done` over passing checks approves. */
export const Decide = Action.make("organization/decide", {
  implementationVersion: "decide/v3",
  payload: { build: Answer, check: Answer, checks: Workspace.Checks, diff: Workspace.Diff },
  success: Verdict
})

/**
 * Writes a role's own answer as a wiki document under the organization's
 * generated directory: for a request whose output is a brief, a triage, a
 * reply, or any page rather than a repository change. Only a principal
 * holding `wiki-write` at the pinned revision may own one; otherwise nothing
 * is written and `reason` says why.
 */
export const WriteDocument = Action.make("organization/write-document", {
  implementationVersion: "write-document/v1",
  payload: { revision: Schema.NonEmptyString, key: RequestKey, answer: Answer },
  success: Schema.Struct({ written: Schema.Boolean, path: Schema.String, reason: Schema.String }),
  error: Schema.Union([Authority.DispatchRefused, Actions.ReceiptFailed])
})

/**
 * Removes every workspace machine a delivery prepared: the builder's and each
 * round's checker's (`null` for a round whose checker held none). A machine
 * already gone is not an error, so every ending may call it.
 */
export const DisposeWorkspaces = Action.make("organization/dispose-workspaces", {
  implementationVersion: "dispose-workspaces/v1",
  payload: { workspaces: Schema.Array(Schema.NullOr(Workspace.Prepared)) },
  error: Workspace.WorkspaceError
})

/** A pull request the host opened. */
export const PullRef = Schema.Struct({ number: Schema.Int, url: Schema.NonEmptyString })
export type PullRef = typeof PullRef.Type

/**
 * Pushes a landed branch to the repository's remote and opens it as a pull
 * request, once: a retried landing reuses the remote branch and the pull
 * request. Never pushes to another branch, never forces, never merges.
 */
export const PublishChange = Action.make("organization/publish-change", {
  implementationVersion: "publish-change/v1",
  payload: {
    key: RequestKey,
    repository: Profile.Container,
    remote: Schema.NonEmptyString,
    github: Schema.NonEmptyString,
    applied: Workspace.Applied,
    /** The pull request's title: the landed commit's message. */
    title: Schema.NonEmptyString,
    /** The role accountable for the change, labelled `org:<role>`. */
    lead: Profile.PrincipalId,
    issue: Schema.optionalKey(IssueRef),
    checks: Schema.Array(CheckSummary)
  },
  success: PullRef,
  error: IntegrationFailure,
  tier: "irreversible",
  idempotencyKey: (payload) =>
    `organization/publish-change:${payload.github}:${payload.applied.branch}:${payload.applied.commit}`
})

/** The request's route when the host names its role: the role's handoff, as the assistant would have written it. */
export const HostRoute = Action.make("organization/host-route", {
  implementationVersion: "host-route/v1",
  payload: { revision: Schema.NonEmptyString, assistant: Profile.PrincipalId, request: Request },
  success: Schema.Struct({
    principal: Profile.PrincipalId,
    result: Profile.RoleResult,
    valid: Schema.Boolean,
    violations: Schema.Array(Schema.String)
  }),
  error: Authority.DispatchRefused
})

/** The delivery's report: what happened, who did it, and the receipts it rests on. */
export const Report = Schema.Struct({
  key: RequestKey,
  status: OutcomeStatus,
  summary: Schema.String,
  principals: Schema.Record(Schema.String, Schema.String),
  rounds: Schema.Int,
  applied: Schema.optionalKey(Workspace.Applied),
  /** The pull request a landed branch was opened as. */
  pull: Schema.optionalKey(PullRef),
  /** The wiki document an answered request produced, relative to the organization root. */
  document: Schema.optionalKey(Schema.String),
  /** The last round's findings, for a change the checker never approved. */
  findings: Schema.optionalKey(Schema.Array(Schema.String)),
  /** The last round's configured checks. */
  checks: Schema.optionalKey(Schema.Array(CheckSummary)),
  /** The hire, delegation, or booking a delivery handed to its child flow, as that flow reported it. */
  child: Schema.optionalKey(Schema.Struct({
    flow: Schema.String,
    status: Schema.String,
    summary: Schema.String,
    paths: Schema.Array(Schema.String)
  })),
  receipt: Schema.optionalKey(Schema.String),
  /** A question's answer and the role that gave it: the thread's one reply. */
  answer: Schema.optionalKey(Schema.Struct({ principal: Profile.PrincipalId, text: Schema.String }))
})
export type Report = typeof Report.Type

/** The one line a delivery's thread ends with: the outcome, the pull request or branch, and the receipt. */
export const Headline = Action.make("organization/headline", {
  implementationVersion: "headline/v1",
  payload: { report: Report, receipt: Schema.String },
  success: Schema.NonEmptyString
})

/**
 * How a delivery's thread ends: who says the one line, the line, what it
 * points to (the pull request or branch and commit, the document, the
 * receipt), and the reaction the owner's message ends with.
 */
export const Closing = Action.make("organization/closing", {
  implementationVersion: "closing/v1",
  payload: { report: Report, receipt: Schema.String, assistant: Profile.PrincipalId, repository: Profile.Container },
  success: Schema.Struct({
    speaker: Profile.PrincipalId,
    text: Schema.NonEmptyString,
    refs: Schema.Array(Ref),
    reaction: Schema.NonEmptyString
  })
})

/**
 * Reacts to a Slack message: `remove` first, then `add`. A reaction already
 * there, or already gone, is no error, so a retry repeats nothing. `reacted`
 * is false when Slack is not connected or refused (a missing
 * `reactions:write` most often), with the reason.
 */
export const React = Action.make("organization/react", {
  implementationVersion: "react/v1",
  payload: {
    channel: Schema.NonEmptyString,
    ts: Schema.NonEmptyString,
    add: Schema.Array(Schema.NonEmptyString),
    remove: Schema.Array(Schema.NonEmptyString)
  },
  success: Schema.Struct({ reacted: Schema.Boolean, reason: Schema.String }),
  tier: "irreversible",
  idempotencyKey: (payload) =>
    `organization/react:${payload.channel}:${payload.ts}:${payload.remove.join(",")}:${payload.add.join(",")}`
})

/** Every failure a delivery step can raise. */
export const StepFailure = Schema.Union([
  Authority.DispatchRefused,
  Workspace.WorkspaceError,
  Gates.GateRefused,
  AgentAction.AgentFailure,
  Actions.ReceiptFailed,
  IntegrationFailure
])

/** Describes a failure a delivery caught, for its receipt and its reply. */
export const Describe = Action.make("organization/describe-failure", {
  implementationVersion: "describe-failure/v1",
  payload: { failure: StepFailure },
  success: Schema.Struct({ code: Schema.String, message: Schema.String })
})

/** A failure a delivery reports after its receipt and reply are written. */
export class DeliveryFailed extends Schema.TaggedError<DeliveryFailed>()("organization/DeliveryFailed", {
  status: OutcomeStatus,
  message: Schema.String
}) {}

/** Ends a delivery: a landed change or an answer succeeds; every other status fails with {@link DeliveryFailed}. */
export const Settle = Action.make("organization/settle", {
  implementationVersion: "settle/v1",
  payload: { report: Report, receipt: Schema.String },
  success: Report,
  error: DeliveryFailed
})

/** A reply in the request's thread, under the persona of the role that speaks. */
export const Reply = Schema.Struct({
  text: Schema.NonEmptyString,
  persona: Schema.Struct({ username: Schema.NonEmptyString })
})

/** Renders a report or a stage as a thread reply, its references as Slack links (`links.ts`). */
export const RenderReply = Action.make("organization/render-reply", {
  implementationVersion: "render-reply/v2",
  payload: { speaker: Schema.String, text: Schema.String, refs: Schema.optionalKey(Schema.Array(Ref)) },
  success: Reply
})

/** A status page that could not be written. */
export class StatusFailed extends Schema.TaggedError<StatusFailed>()("organization/StatusFailed", {
  message: Schema.String
}) {}

/** Rewrites the status page from the delivery receipts: the newest first, one line each. */
export const WriteStatus = Action.make("organization/write-status", {
  implementationVersion: "write-status/v1",
  payload: {},
  success: Schema.Struct({ path: Schema.String, deliveries: Schema.Int }),
  error: StatusFailed,
  nondeterministic: true
})
