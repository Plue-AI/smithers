/**
 * `organization/assignment`: one role's host task, whose answer the host
 * writes to the wiki: a routine's report, a role's onboarding page and
 * proposals, its review comments and requests, or the triage role's
 * priorities (`autonomy.ts`).
 *
 * The host gathers the task's context (commits, issues, receipts, proposals,
 * the team channel, the repository's docs), the role answers under its own
 * host, seat, grants, and budget, a `done` answer missing a required field
 * is asked again once, and the host writes what the answer holds. With
 * `workspace` the role works in a machine seeded from the repository's base.
 * Keyed by the assignment's key: a routine run twice, or a restarted host,
 * joins the one assignment.
 */
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import type * as Planned from "@smthrs/plan/Planned"
import { Schema } from "effect"
import * as Actions from "../../../packages/smithers/agent/organization/src/Actions.ts"
import {
  Assignment,
  AssignmentFailed,
  type AssignmentReport,
  AssignmentReport as AssignmentReportSchema,
  AssignmentTask,
  DescribeWork,
  requiredFields,
  SettleAssignment,
  type WorkFailure,
  WriteAssignment
} from "../autonomy.ts"
import { fieldTurn } from "../field-turn.ts"
import type { Answer, Stage } from "../schema.ts"
import { TeamPost } from "../team-channel.ts"

const implementationVersion = "organization/assignment/v2"

const blocked = (
  payload: typeof Assignment.Type,
  summary: Planned.Planned<string> | string
): Node.Node<AssignmentReport> =>
  Node.succeed(
    { key: payload.key, status: "blocked", summary, principal: payload.role, paths: [] } as unknown as AssignmentReport
  )

/** The role's turn, in a machine of its own when the assignment asks for one. */
const answered = (
  payload: typeof Assignment.Type,
  revision: Planned.Planned<string>,
  stage: Planned.Planned<Stage>
): Node.Node<Answer, any, any> => {
  const required = requiredFields[payload.kind]
  if (!payload.workspace || payload.repository === undefined) {
    return fieldTurn(revision, stage, required) as Node.Node<Answer, any, any>
  }
  const repository = payload.repository
  return Actions.ResolveBase.call({ repository, commit: "HEAD" }).pipe(
    Node.bindPlanned(
      Node.capture(
        { implementationVersion },
        (base) => Actions.PrepareWorkspace.call({ repository, commit: base.commit, slug: "assignment" })
      )
    ),
    Node.bindPlanned(Node.capture({ implementationVersion, required }, function(prepared) {
      return fieldTurn(revision, stage, this.required, { key: prepared.key, repository, commit: prepared.commit }).pipe(
        Node.bindPlanned(
          Node.capture(
            { implementationVersion },
            (answer) => Actions.DisposeWorkspace.call({ workspace: prepared }).pipe(Node.andThen(Node.succeed(answer)))
          )
        ),
        Node.catch({
          onFailure: Node.capture(
            { implementationVersion },
            (failure) =>
              Actions.DisposeWorkspace.call({ workspace: prepared }).pipe(Node.andThen(Node.fail(failure as never)))
          )
        })
      )
    }))
  ) as Node.Node<Answer, any, any>
}

/** Run one assignment. */
export default Flow.make("organization/assignment", {
  description:
    "Have one role do a host task (a routine's report, its onboarding page and proposals, a review, the priorities) with the context the host gathered, and write its answer to the organization wiki.",
  capabilities: ["*"],
  effects: { reads: ["**"], writes: ["**"], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  modelInvocable: false,
  idempotencyKey: (payload) => payload.key,
  payload: Assignment.fields,
  success: AssignmentReportSchema,
  error: Schema.Union([AssignmentFailed, Actions.ReceiptFailed]),
  body: (payload) =>
    TeamPost.call({ thread: payload.key, role: payload.role, text: `Started: ${payload.title}` }).pipe(
      Node.andThen(Actions.PinRoster.call({})),
      Node.bindPlanned(Node.capture({ implementationVersion }, (pin) =>
        AssignmentTask.call({ revision: pin.revision, assignment: payload }).pipe(
          Node.bindPlanned(Node.capture({ implementationVersion }, (stage) =>
            answered(payload, pin.revision, stage))),
          Node.bindPlanned(Node.capture({ implementationVersion }, (answer) =>
            WriteAssignment.call({ assignment: payload, answer })))
        ))),
      Node.catch({
        onFailure: Node.capture({ implementationVersion }, (failure) =>
          DescribeWork.call({ failure: failure as Planned.Planned<typeof WorkFailure.Type> }).pipe(
            Node.bindPlanned(Node.capture({ implementationVersion }, (described) =>
              blocked(payload, described)))
          ))
      }),
      Node.bindPlanned(Node.capture({ implementationVersion }, (outcome) =>
        Actions.WriteReceipt.call({
          runId: payload.key,
          name: "assignment",
          receipt: { assignment: payload, report: outcome } as never
        }).pipe(
          Node.bindPlanned(Node.capture({ implementationVersion }, (written) =>
            Node.all({ ended: Node.succeed(outcome), receipt: Node.succeed(written.path) }).pipe(
              // The pages it wrote, then its receipt, as links.
              Node.map(Node.capture({ implementationVersion, title: payload.title }, function({ ended, receipt }) {
                return {
                  text: ended.status === "done" ? `Done: ${this.title}` : `Blocked: ${this.title}: ${ended.summary}`,
                  refs: [...(ended.status === "done" ? ended.paths : []), receipt].map((path) => ({
                    kind: "page" as const,
                    path
                  }))
                }
              })),
              Node.bindPlanned(Node.capture({ implementationVersion }, (post) =>
                TeamPost.call({ thread: payload.key, role: payload.role, text: post.text, refs: post.refs }))),
              Node.andThen(SettleAssignment.call({ report: outcome, receipt: written.path }))
            )))
        )))
    )
})
