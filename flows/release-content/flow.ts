/** The release-content flow's graph: the file discovery reads, and the value a host runs. */
import * as AgentAction from "@smthrs/agent/AgentAction"
import { type Action, Flow, HumanTask } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import type * as Planned from "@smthrs/plan/Planned"
import { Schema } from "effect"
import {
  type Analysis, type Brief, ContentInput, ContentResult, type Draft, type Evidence, ReleaseError, type Review
} from "../release-support/schema.ts"
import {
  Analyze, Check, Collect, CommitFiles, DraftBlog, DraftChangelog, DraftThread, Outcome, OutlineBlog,
  OutlineTemplate, PickTemplate, PostThread, Preview, PublishFiles, QualityGate, RecordApproval,
  RecordUi, Revise, Score
} from "./workflow.ts"

const emptyCopy = { text: "", claimIds: [] }
type Requirements = Action.Requirement<(
  typeof Score | typeof Check | typeof Revise | typeof QualityGate | typeof Preview |
  typeof RecordApproval | typeof PublishFiles | typeof PostThread | typeof CommitFiles | typeof Outcome
)["name"]>
/** The brief the drafting steps read: Jev's narrative beside the seat's
 * outline, assembled by the flow rather than produced by one step. */
type PlannedBrief = Action.PlannedPayload<typeof Brief.Type>
type Failure = ReleaseError | AgentAction.AgentFailure | HumanTask.HumanTaskFailed

const reviewRound = (
  input: ContentInput,
  evidence: Planned.Planned<Evidence>,
  analysis: Planned.Planned<Analysis>,
  brief: PlannedBrief,
  draft: Planned.Planned<Draft>,
  round: number
): Node.Node<ContentResult, Failure, Requirements> =>
  Node.bindPlanned(Score.call({ input, evidence, analysis, draft, round }), (review) =>
    Node.branch(Check.call({ input, evidence, analysis, draft, review }), {
      if: (checked) => checked.passed,
      then: (checked) => finish(input, evidence, analysis, brief, draft, checked),
      else: (checked) => round >= input.maxRevisions
        ? Node.bindPlanned(QualityGate.call({ review: checked, draft }), () =>
          finish(input, evidence, analysis, brief, draft, checked))
        : Node.bindPlanned(Revise.call({ input, evidence, analysis, brief, draft, review: checked, round }), (revised) =>
          reviewRound(input, evidence, analysis, brief, revised, round + 1))
    }))

const finish = (
  input: ContentInput,
  evidence: Planned.Planned<Evidence>,
  analysis: Planned.Planned<Analysis>,
  brief: PlannedBrief,
  draft: Planned.Planned<Draft>,
  review: Planned.Planned<Review>
): Node.Node<ContentResult, Failure, Requirements> =>
  Node.bindPlanned(Preview.call({ input, evidence, analysis, brief, draft, review }), (artifact) => {
    if (input.dryRun) return Outcome.call({ status: "preview" as const, artifact, files: [], tweetIds: [] })
    return Node.branch(HumanTask.action.call({
      name: "release-content", kind: "confirm", prompt: artifact.approvalPrompt, maxAttempts: 3
    }), {
      if: (answer) => answer === true,
      else: () => Outcome.call({ status: "declined" as const, artifact, files: [], tweetIds: [] }),
      then: () => Node.bindPlanned(RecordApproval.call({ artifact }), (approved) => {
        if (!input.publish) return Outcome.call({ status: "approved" as const, artifact: approved, files: [], tweetIds: [] })
        return Node.bindPlanned(PublishFiles.call({ artifact: approved }), (files) => {
          const complete = (written: Planned.Planned<ReadonlyArray<string>>): Node.Node<ContentResult, Failure, Requirements> => {
            if (!input.postX) return Outcome.call({ status: "published" as const, artifact: approved, files: written, tweetIds: [] })
            return Node.bindPlanned(PostThread.call({ artifact: approved }), (tweetIds) =>
              Outcome.call({ status: "published" as const, artifact: approved, files: written, tweetIds }))
          }
          return input.autoCommit ? Node.bindPlanned(CommitFiles.call({ artifact: approved, files }), complete) : complete(files)
        })
      })
    })
  })

/** Models draft and review; durable actions own evidence, artifacts and side effects. */
export default Flow.make("smithers/ReleaseContent", {
  description: "Analyze a release, draft changelog/blog/thread content, revise against quality gates, render previews and wait for approval before publication.",
  capabilities: ["*"],
  effects: { reads: ["**"], writes: ["**"], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  payload: ContentInput,
  success: ContentResult,
  error: Schema.Union([ReleaseError, AgentAction.AgentFailure, HumanTask.HumanTaskFailed]),
  body: (input) => Node.bindPlanned(Collect.call({ version: input.version, from: input.from }), (collected) => {
    const compose = (evidence: Planned.Planned<Evidence>) => Node.bindPlanned(Analyze.call({ input, evidence }), (analysis) =>
      Node.bindPlanned(PickTemplate.call({ input, evidence, analysis }), (picked) =>
        Node.bindPlanned(OutlineTemplate.call({ input, evidence, analysis, template: picked.template }), (outlined) => {
          // Jev's narrative beside the seat's outline. The seat has no
          // template field, so this is the only place the brief's narrative
          // is written.
          const brief: PlannedBrief = { template: picked.template, angle: outlined.angle, outline: outlined.outline }
          return Node.bindPlanned(Node.all({
            changelog: input.channels.changelog ? DraftChangelog.call({ input, evidence, analysis, brief }) : Node.succeed(emptyCopy),
            thread: input.channels.thread ? DraftThread.call({ input, evidence, analysis, brief }) : Node.succeed({ tweets: [] }),
            blog: input.channels.blog
              ? Node.bindPlanned(OutlineBlog.call({ input, evidence, analysis, brief }), (outline) =>
                DraftBlog.call({ input, evidence, analysis, brief, outline }))
              : Node.succeed(emptyCopy)
          }), (draft) => reviewRound(input, evidence, analysis, brief, draft, 0))
        })))
    return input.recording ? Node.bindPlanned(RecordUi.call({ input, evidence: collected }), compose) : compose(collected)
  })
})
