/**
 * `organization/hire`: a principal hires a specialist for a need, and
 * optionally hands it its first task.
 *
 * The parent answers a hiring task under its own host with the structured
 * `hire` field (`Hiring.HireSpec`, or null for no hire). The host validates
 * it against the hiring rules (`Hiring.propose`): the hire's grants are a
 * subset of the parent's and never personal accounts or owner contact; its
 * depth, the parent's children and persistent counts, and the parent's daily
 * token allocation stay within limits; the parent and everything above it are
 * active. A hire the rules refuse is asked again once with the rules it
 * broke, as a charter violation is. A valid hire is written to `<rosterDir>/Specialists/<id>.md` with
 * its own memory namespace and budget carved from the parent's, and the
 * roster is pinned with it. With `task`, the new hire's first task runs as an
 * `organization/delegate` child keyed `<key>.task`. The receipt
 * (`<generatedDir>/<key>/hire.json`) holds the request, the parent's answer
 * summary, the outcome, and every violation.
 */
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import type * as Planned from "@smthrs/plan/Planned"
import { Schema } from "effect"
import * as Actions from "../../../packages/smithers/agent/organization/src/Actions.ts"
import * as Profile from "../../../packages/smithers/agent/organization/src/Profile.ts"
import Delegate, { finish } from "../delegate/flow.ts"
import { fieldTurn } from "../field-turn.ts"
import { CorrectTask, Describe, RequestKey, type StepFailure } from "../schema.ts"
import { HireTask, StaffFailed, StaffReport, StoreHire } from "../staff.ts"
import { TeamPost } from "../team-channel.ts"

const implementationVersion = "organization/hire/v2"

type Payload = {
  readonly key: string
  readonly parent: string
  readonly need: string
  readonly task?: string
  readonly acceptance?: ReadonlyArray<string>
}

const failed = (payload: Payload, failure: unknown): Node.Node<StaffReport, any, any> =>
  Describe.call({ failure: failure as Planned.Planned<typeof StepFailure.Type> }).pipe(
    Node.map(Node.capture({ implementationVersion, key: payload.key, principal: payload.parent }, function(described) {
      return {
        key: this.key,
        status: "refused",
        summary: `${described.code}: ${described.message}`,
        principal: this.principal,
        paths: []
      }
    }))
  )

/** Hire one specialist. */
export default Flow.make("organization/hire", {
  description:
    "Have a principal hire a specialist for a need: its structured hire request is validated against the hiring rules, written to the roster with a receipt, and optionally handed its first task.",
  capabilities: ["*"],
  effects: { reads: ["**"], writes: ["**"], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  modelInvocable: false,
  idempotencyKey: (payload) => payload.key,
  payload: {
    key: RequestKey,
    parent: Profile.PrincipalId,
    need: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8_000)),
    /** The new hire's first task, delegated once it is hired. */
    task: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8_000))),
    /** The first task's acceptance criteria. */
    acceptance: Schema.optionalKey(Schema.Array(Schema.String))
  },
  success: StaffReport,
  error: Schema.Union([StaffFailed, Actions.ReceiptFailed]),
  body: (payload) => {
    const task = payload.task
    return Actions.PinRoster.call({}).pipe(
      Node.bindPlanned(Node.capture({ implementationVersion }, (pin) =>
        HireTask.call({ revision: pin.revision, parent: payload.parent, key: payload.key, need: payload.need }).pipe(
          Node.bindPlanned(Node.capture({ implementationVersion }, (stage) =>
            fieldTurn(pin.revision, stage, ["hire"]).pipe(
              Node.bindPlanned(Node.capture({ implementationVersion }, (answer) =>
                StoreHire.call({ key: payload.key, attempt: 1, parent: payload.parent, answer }).pipe(
                  // A hire the rules refuse is asked again once, with the rules it broke.
                  Node.branch({
                    if: Node.capture({ implementationVersion }, (seen) => !seen.hired && seen.violations.length > 0),
                    else: (seen) => Node.succeed(seen),
                    then: (seen) =>
                      CorrectTask.call({
                        stage,
                        result: answer.result,
                        validation: { valid: false, violations: seen.violations } as never
                      }).pipe(
                        Node.bindPlanned(Node.capture({ implementationVersion }, (corrected) =>
                          fieldTurn(pin.revision, corrected, ["hire"]))),
                        Node.bindPlanned(Node.capture({ implementationVersion }, (again) =>
                          StoreHire.call({ key: payload.key, attempt: 2, parent: payload.parent, answer: again })))
                      )
                  })
                )))
            )))
        ))),
      Node.bindPlanned(Node.capture({ implementationVersion }, (outcome) =>
        Node.branch(Node.succeed(outcome), {
          if: Node.capture({ implementationVersion }, (seen) => seen.hired),
          else: () =>
            Node.succeed({
              key: payload.key,
              status: "refused",
              summary: outcome.reason,
              principal: payload.parent,
              paths: [],
              violations: outcome.violations
            } as unknown as StaffReport),
          then: () => {
            // The team hears of the hire in the hire's thread.
            const announced = Node.succeed(outcome).pipe(
              Node.map(Node.capture({ implementationVersion }, (seen) => `Hired ${seen.principal}`)),
              Node.bindPlanned(Node.capture({ implementationVersion }, (text) =>
                TeamPost.call({ thread: payload.key, role: payload.parent, text, link: outcome.path })))
            )
            const hired = Node.succeed({
              key: payload.key,
              status: "hired",
              summary: outcome.reason,
              principal: outcome.principal,
              paths: [outcome.path]
            } as unknown as StaffReport)
            if (task === undefined) return announced.pipe(Node.andThen(hired))
            const child = `${payload.key}.task`
            // The first task's own ending is its receipt; the hire stands either way.
            return announced.pipe(Node.andThen(Delegate.child({
              key: child,
              parent: payload.parent,
              specialist: outcome.principal as unknown as string,
              objective: task,
              ...(payload.acceptance === undefined ? {} : { acceptance: payload.acceptance })
            }).pipe(
              Node.catch({ onFailure: Node.capture({ implementationVersion }, () => Node.succeed(null)) }),
              Node.andThen(Node.succeed({
                key: payload.key,
                status: "hired",
                summary: outcome.reason,
                principal: outcome.principal,
                paths: [outcome.path],
                delegated: child
              } as unknown as StaffReport))
            )))
          }
        }))),
      Node.catch({ onFailure: Node.capture({ implementationVersion }, (failure) => failed(payload, failure)) }),
      Node.bindPlanned(Node.capture({ implementationVersion }, (outcome) =>
        finish(payload.key, "hire", payload, outcome as Planned.Planned<StaffReport>)))
    )
  }
})
