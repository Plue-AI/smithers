/**
 * `organization/delegate`: a principal hands a task to a specialist it
 * hired, and reviews the output before it counts.
 *
 * The specialist must be active and hired by the parent (directly or below
 * it); it works under its own host, seat, grants, memory, and budget, and its
 * result is checked against its own charter. The parent then reviews the
 * result (`verdict`: `accept` or `revise`); a revision goes back to the
 * specialist with the parent's findings, for at most two rounds. An accepted
 * output is written to the wiki under the organization's generated directory
 * with the parent's review (by the specialist when it holds `wiki-write`,
 * else published by the parent when it does), and the run's receipt records
 * the outcome and the document.
 */
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import type * as Planned from "@smthrs/plan/Planned"
import { Schema } from "effect"
import * as Actions from "../../../packages/smithers/agent/organization/src/Actions.ts"
import * as Profile from "../../../packages/smithers/agent/organization/src/Profile.ts"
import { turn } from "../deliver/flow.ts"
import { fieldTurn } from "../field-turn.ts"
import { Describe, RequestKey, type StepFailure } from "../schema.ts"
import { DelegateTask, Judge, PublishWork, ReviewTask, SettleStaff, StaffFailed, StaffReport } from "../staff.ts"

const implementationVersion = "organization/delegate/v1"

/** Rounds a parent may ask for before the delegation ends as `revise`. */
export const maxRounds = 2

/** What a delegation carries. */
export const Payload = {
  key: RequestKey,
  parent: Profile.PrincipalId,
  specialist: Profile.PrincipalId,
  objective: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8_000)),
  inputs: Schema.optionalKey(Schema.Array(Schema.String)),
  acceptance: Schema.optionalKey(Schema.Array(Schema.String))
}

type Payload = {
  readonly key: string
  readonly parent: string
  readonly specialist: string
  readonly objective: string
  readonly inputs?: ReadonlyArray<string>
  readonly acceptance?: ReadonlyArray<string>
}

const report = (payload: Payload, fields: Readonly<Record<string, unknown>>): Node.Node<StaffReport> =>
  Node.succeed({ key: payload.key, principal: payload.specialist, paths: [], ...fields } as unknown as StaffReport)

const round = (
  payload: Payload,
  revision: Planned.Planned<string>,
  n: number,
  findings: Planned.Planned<ReadonlyArray<string>> | ReadonlyArray<string>
): Node.Node<StaffReport, any, any> =>
  DelegateTask.call({
    revision,
    key: payload.key,
    parent: payload.parent,
    specialist: payload.specialist,
    objective: payload.objective,
    inputs: payload.inputs ?? [],
    acceptance: payload.acceptance ?? [],
    round: n,
    findings
  }).pipe(
    Node.branch({
      if: Node.capture({ implementationVersion }, (stage) => stage.proceed),
      else: (stage) => report(payload, { status: "refused", summary: stage.reason }),
      then: (stage) =>
        turn(revision, stage).pipe(
          Node.branch({
            // A specialist that could not finish (a limit, a refusal) ends the delegation with its reason.
            if: Node.capture({ implementationVersion }, (work) => work.result.status === "done"),
            else: (work) => report(payload, { status: "blocked", summary: work.result.summary }),
            then: (work) =>
              ReviewTask.call({
                revision,
                key: payload.key,
                parent: payload.parent,
                objective: payload.objective,
                acceptance: payload.acceptance ?? [],
                round: n,
                work
              }).pipe(
                Node.bindPlanned(
                  Node.capture({ implementationVersion }, (stage) => fieldTurn(revision, stage, ["verdict"]))
                ),
                Node.bindPlanned(Node.capture({ implementationVersion }, (review) =>
                  Judge.call({ work, review }).pipe(
                    Node.branch({
                      if: Node.capture({ implementationVersion }, (judged) => judged.accepted),
                      then: () =>
                        PublishWork.call({ revision, key: payload.key, parent: payload.parent, work, review }).pipe(
                          Node.branch({
                            if: Node.capture({ implementationVersion }, (document) => document.written),
                            then: (document) =>
                              report(payload, {
                                status: "accepted",
                                summary: review.result.summary,
                                paths: [document.path]
                              }),
                            else: (document) => report(payload, { status: "blocked", summary: document.reason })
                          })
                        ),
                      else: (judged) =>
                        n >= maxRounds
                          ? report(payload, { status: "revise", summary: review.result.summary })
                          : round(payload, revision, n + 1, judged.findings)
                    })
                  )))
              )
          })
        )
    })
  )

/** The report of a delegation a step failure ended: a refused principal, a failed turn. */
const failed = (payload: Payload, failure: unknown): Node.Node<StaffReport, any, any> =>
  Describe.call({ failure: failure as Planned.Planned<typeof StepFailure.Type> }).pipe(
    Node.map(
      Node.capture({ implementationVersion, key: payload.key, principal: payload.specialist }, function(described) {
        return {
          key: this.key,
          status: "refused",
          summary: `${described.code}: ${described.message}`,
          principal: this.principal,
          paths: []
        }
      })
    )
  )

/** The receipt and the run's ending, for any report. */
export const finish = (key: string, name: string, request: unknown, outcome: Planned.Planned<StaffReport>) =>
  Actions.WriteReceipt.call({ runId: key, name, receipt: { request, report: outcome } as never }).pipe(
    Node.bindPlanned(
      Node.capture({ implementationVersion }, (written) => SettleStaff.call({ report: outcome, receipt: written.path }))
    )
  )

/** Delegate one task to a hire, and review it. */
export default Flow.make("organization/delegate", {
  description:
    "Hand one task to a specialist the parent hired, run it under the specialist's own grants and budget, have the parent review the output before it counts, and write the accepted output to the wiki with a receipt.",
  capabilities: ["*"],
  effects: { reads: ["**"], writes: ["**"], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  modelInvocable: false,
  idempotencyKey: (payload) => payload.key,
  payload: Payload,
  success: StaffReport,
  error: Schema.Union([StaffFailed, Actions.ReceiptFailed]),
  body: (payload) =>
    Actions.PinRoster.call({}).pipe(
      Node.bindPlanned(Node.capture({ implementationVersion }, (pin) => round(payload, pin.revision, 1, []))),
      Node.catch({ onFailure: Node.capture({ implementationVersion }, (failure) => failed(payload, failure)) }),
      Node.bindPlanned(
        Node.capture({ implementationVersion }, (outcome) => finish(payload.key, "delegate", payload, outcome))
      )
    )
})
