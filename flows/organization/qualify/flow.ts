/**
 * `organization/qualify`: one attempt at one qualification case.
 *
 * A case (`Org/Cases/<id>.md`) gives one principal a task and the context it
 * would retrieve. The attempt pins the roster, runs the principal's turn the
 * way a delivery does (composed under its own host and seat, checked against
 * its charter, asked again once when a result breaks it), in a workspace
 * machine of the case's repository when the case needs one, and writes
 * the answer, or the failure that stopped it, as a receipt under the
 * organization's generated directory. Scoring against the case's
 * expectations is the `qualify` command's (`qualify/cases.ts`); the flow only
 * records what the principal answered.
 */
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import type * as Planned from "@smthrs/plan/Planned"
import { Schema } from "effect"
import * as Actions from "../../../packages/smithers/agent/organization/src/Actions.ts"
import * as Profile from "../../../packages/smithers/agent/organization/src/Profile.ts"
import * as Prompt from "../../../packages/smithers/agent/organization/src/Prompt.ts"
import * as Workspace from "../../../packages/smithers/agent/organization/src/Workspace.ts"
import { turn } from "../deliver/flow.ts"
import { Answer, Describe, RequestKey, type Stage, type StepFailure } from "../schema.ts"

const implementationVersion = "organization/qualify/v3"

/** The change a principal left in its workspace. */
export const Change = Schema.Struct({
  digest: Schema.String,
  files: Schema.Array(Workspace.FileStat),
  added: Schema.Int,
  deleted: Schema.Int
})

/**
 * What one attempt recorded: the checked answer, or why there is none; for
 * a case that checks the work, the change and the checks it ran in a fresh
 * machine.
 */
export const Outcome = Schema.Struct({
  answer: Schema.optionalKey(Answer),
  change: Schema.optionalKey(Change),
  checks: Schema.optionalKey(Workspace.Checks),
  failure: Schema.optionalKey(Schema.Struct({ code: Schema.String, message: Schema.String }))
})
export type Outcome = typeof Outcome.Type

/** One attempt: its key and the wiki path of the receipt holding its {@link Outcome}. */
export const Attempt = Schema.Struct({ key: RequestKey, receipt: Schema.String })
export type Attempt = typeof Attempt.Type

type Payload = {
  readonly key: string
  readonly principal: string
  readonly task: Profile.TaskContract
}

/** The attempt's receipt, and the attempt it records. */
const record = (payload: Payload, outcome: unknown): Node.Node<Attempt, typeof Actions.ReceiptFailed.Type, any> =>
  Actions.WriteReceipt.call({
    runId: payload.key,
    name: "qualify",
    // Planned references resolve wherever they sit; the declared types cannot say so.
    receipt: { principal: payload.principal, task: payload.task, outcome } as never
  }).pipe(
    Node.bindPlanned(Node.capture({ implementationVersion }, (written) =>
      Node.succeed({ key: payload.key, receipt: written.path } as unknown as Attempt)))
  ) as Node.Node<Attempt, typeof Actions.ReceiptFailed.Type, any>

/** Run one qualification attempt. */
export default Flow.make("organization/qualify", {
  description:
    "Run one qualification attempt: one principal's task over fixture context, answered under its own seat, checked against its charter, and recorded as a receipt.",
  capabilities: ["*"],
  effects: { reads: ["**"], writes: ["**"], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  modelInvocable: false,
  idempotencyKey: (payload) => payload.key,
  payload: {
    key: RequestKey,
    principal: Profile.PrincipalId,
    task: Profile.TaskContract,
    context: Schema.Array(Prompt.ContextEntry),
    /**
     * A repository to work in: the principal's turn runs in a workspace
     * machine seeded from `commit` (its checked-out commit otherwise), removed
     * when the turn ends.
     */
    repository: Schema.optionalKey(Profile.Container),
    /** The commit-ish the workspace is seeded from; `HEAD` otherwise. */
    commit: Schema.optionalKey(Schema.NonEmptyString),
    /**
     * With a repository: once the turn has answered, the change it left is
     * collected and checked in a fresh machine, the repository's own checks
     * first and then these, as a delivery's change is.
     */
    checks: Schema.optionalKey(Schema.Array(Workspace.Check))
  },
  success: Attempt,
  error: Actions.ReceiptFailed,
  body: (payload) => {
    const stage: Stage = {
      proceed: true,
      outcome: "blocked",
      reason: "",
      principal: payload.principal,
      task: payload.task,
      context: payload.context
    }
    const repository = payload.repository
    const commit = payload.commit ?? "HEAD"
    const checks = payload.checks
    /** Removes the workspace, then passes `result` on or fails with `failure`. */
    const disposing = (prepared: Planned.Planned<Workspace.Prepared>) => ({
      then: <A>(result: Planned.Planned<A>) =>
        Node.andThen(Node.succeed(result), Actions.DisposeWorkspace.call({ workspace: prepared })).pipe(
          Node.andThen(Node.succeed(result))
        ),
      fail: (failure: unknown) =>
        Actions.DisposeWorkspace.call({ workspace: prepared }).pipe(
          Node.andThen(Node.fail(failure as Planned.Planned<typeof StepFailure.Type>))
        )
    })
    /** The change the turn left and its checks, read only after the turn has answered. */
    const checked = (
      prepared: Planned.Planned<Workspace.Prepared>,
      answer: Planned.Planned<Answer>,
      run: ReadonlyArray<Workspace.Check>
    ): Node.Node<Outcome, any, any> =>
      Node.andThen(Node.succeed(answer), Actions.CollectDiff.call({ workspace: prepared })).pipe(
        Node.bindPlanned(Node.capture({ implementationVersion }, (diff) =>
          Actions.RunChecks.call({ repository: repository!, commit: prepared.commit, patch: diff.patch, checks: run }).pipe(
            // Planned references resolve wherever they sit in a node's value; the declared types cannot say so.
            Node.bindPlanned(Node.capture({ implementationVersion }, (ran) =>
              Node.succeed<unknown>({
                answer,
                change: { digest: diff.digest, files: diff.files, added: diff.added, deleted: diff.deleted },
                checks: ran
              }) as Node.Node<Outcome, any, any>))
          )))
      )
    /** The turn in a workspace machine of `repo`, removed once the turn has answered and its change is checked. */
    const inWorkspace = (revision: Planned.Planned<string>, planned: Planned.Planned<Stage>, repo: string): Node.Node<Outcome, any, any> =>
      Actions.PrepareWorkspace.call({ repository: repo, commit, slug: "qualify" }).pipe(
        Node.bindPlanned(Node.capture({ implementationVersion }, (prepared): Node.Node<Outcome, any, any> => {
          const answered: Node.Node<Answer, any, any> = turn(revision, planned, { key: prepared.key, repository: repo, commit: prepared.commit })
          const outcome: Node.Node<Outcome, any, any> = answered.pipe(
            Node.bindPlanned(Node.capture({ implementationVersion }, (answer: Planned.Planned<Answer>): Node.Node<Outcome, any, any> =>
              checks === undefined ? Node.succeed<unknown>({ answer }) as Node.Node<Outcome, any, any> : checked(prepared, answer, checks)))
          )
          return outcome.pipe(
            Node.catch({ onFailure: Node.capture({ implementationVersion }, (failure) => disposing(prepared).fail(failure)) }),
            Node.bindPlanned(Node.capture({ implementationVersion }, (settled) => disposing(prepared).then(settled)))
          ) as Node.Node<Outcome, any, any>
        }))
      )
    return Actions.PinRoster.call({}).pipe(
      Node.bindPlanned(Node.capture({ implementationVersion }, (pin) =>
        Node.succeed(stage).pipe(
          Node.bindPlanned(Node.capture({ implementationVersion }, (planned) =>
            repository === undefined
              ? turn(pin.revision, planned).pipe(Node.map(Node.capture({ implementationVersion }, (answer): Outcome => ({ answer }))))
              : inWorkspace(pin.revision, planned, repository)))
        ))),
      Node.catch({
        onFailure: Node.capture({ implementationVersion }, (failure) =>
          Describe.call({ failure: failure as Planned.Planned<typeof StepFailure.Type> }).pipe(
            Node.map(Node.capture({ implementationVersion }, (described): Outcome => ({ failure: described })))
          ))
      }),
      Node.bindPlanned(Node.capture({ implementationVersion }, (outcome) => record(payload, outcome)))
    )
  }
})
