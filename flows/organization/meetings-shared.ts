/**
 * What the meetings flows share: the receipt every run writes before it
 * ends, and the ending itself.
 */
import { Node } from "@smthrs/plan"
import type * as Planned from "@smthrs/plan/Planned"
import * as Actions from "../../packages/smithers/agent/organization/src/Actions.ts"
import { type MeetingReport, SettleMeeting } from "./meetings.ts"
import { Describe, type StepFailure } from "./schema.ts"

const implementationVersion = "organization/meetings/v1"

/** Writes `<generatedDir>/<run>/<name>.json` with the request and the report, then ends the run on the report. */
export const finish = (
  runId: Planned.Planned<string> | string,
  name: string,
  request: unknown,
  outcome: Planned.Planned<MeetingReport> | MeetingReport
) =>
  Actions.WriteReceipt.call({ runId: runId as string, name, receipt: { request, report: outcome } as never }).pipe(
    Node.bindPlanned(Node.capture({ implementationVersion }, (written) =>
      SettleMeeting.call({ report: outcome as MeetingReport, receipt: written.path })))
  )

/** A report node; `fields` may hold planned references, which the engine resolves wherever they sit. */
export const report = (fields: Readonly<Record<string, unknown>>): Node.Node<MeetingReport> =>
  Node.succeed({ paths: [], ...fields } as unknown as MeetingReport)

/**
 * The report of a meetings step a failure ended (a refused principal, a
 * failed model turn, a Slack refusal): `blocked`, with the failure as its
 * summary, so the receipt says why.
 */
export const blocked = (
  key: Planned.Planned<string> | string,
  principal: string
) =>
  Node.catch({
    onFailure: Node.capture({ implementationVersion }, (failure) =>
      Describe.call({ failure: failure as Planned.Planned<typeof StepFailure.Type> }).pipe(
        Node.bindPlanned(Node.capture({ implementationVersion }, (described) =>
          report({ key, status: "blocked", summary: described.message, principal })))
      ))
  })
