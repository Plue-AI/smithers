/**
 * One principal's turn at a host task (a hire decision, a review, a meeting
 * agenda): composed and run under the principal's own host and seat like any
 * role task, then checked for the fields the task asks for
 * (`ValidateFields`) instead of the principal's charter. A `done` result
 * missing one is asked again once with what was missing, as a delivery's
 * turn is.
 */
import { Node } from "@smthrs/plan"
import type * as Planned from "@smthrs/plan/Planned"
import * as Actions from "../../packages/smithers/agent/organization/src/Actions.ts"
import { type Answer, CorrectTask, type Stage } from "./schema.ts"
import { ValidateFields } from "./staff.ts"

const implementationVersion = "organization/field-turn/v1"

/** A workspace machine the principal works in: its key, repository, and seeded commit. */
export type TurnWorkspace = {
  readonly key: Planned.Planned<string>
  readonly repository: string
  readonly commit: Planned.Planned<string>
}

const ask = (
  revision: Planned.Planned<string>,
  stage: Planned.Planned<Stage>,
  required: ReadonlyArray<string>,
  workspace?: TurnWorkspace
) =>
  Actions.ComposeTask.call({
    revision,
    principal: stage.principal,
    task: stage.task,
    context: stage.context,
    // The key and commit are planned references the engine resolves inside the struct.
    ...(workspace === undefined
      ? {}
      : { workspace: workspace as unknown as { key: string; repository: string; commit: string } })
  }).pipe(
    Node.bindPlanned(Node.capture({ implementationVersion }, (payload) => Actions.RoleTask.call(payload))),
    Node.bindPlanned(Node.capture({ implementationVersion, required }, function(result) {
      return Node.all({
        principal: Node.succeed(stage.principal),
        result: Node.succeed(result),
        validation: ValidateFields.call({ principal: stage.principal, result, required: this.required })
      })
    }))
  )

/** The principal's checked answer to a host task that needs `required` fields. */
export const fieldTurn = (
  revision: Planned.Planned<string>,
  stage: Planned.Planned<Stage>,
  required: ReadonlyArray<string>,
  workspace?: TurnWorkspace
) =>
  ask(revision, stage, required, workspace).pipe(
    Node.branch({
      if: Node.capture({ implementationVersion }, (seen) => !seen.validation.valid && seen.result.status === "done"),
      then: (seen) =>
        CorrectTask.call({ stage, result: seen.result, validation: seen.validation }).pipe(
          Node.bindPlanned(Node.capture({ implementationVersion, required }, function(corrected) {
            return ask(revision, corrected, this.required, workspace)
          }))
        ),
      else: (seen) => Node.succeed(seen)
    }),
    Node.map(Node.capture({ implementationVersion }, (seen): Answer => ({
      principal: seen.principal,
      result: seen.result,
      valid: seen.validation.valid,
      violations: seen.validation.violations.map((violation) => violation.message)
    })))
  )
